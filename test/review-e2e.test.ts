import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { decidableSteps } from "../src/flows";
import { FALLBACK_DEFAULTS } from "../src/config";
import { REVIEW_FILE } from "../src/output";
import { loadDefaults, type Defaults } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { executeRun, outcomeLine, type EnginePrompts } from "../src/engine";
import { Herdr } from "../src/herdr";
import type { PluginEnv } from "../src/env";
import { fakeHerdr } from "./support/fake-herdr-core";
import {
  classifyWorkSource,
  inferInputs,
  inputSources,
  inputValues,
  targetKind,
} from "../src/inputs";
import { RunStore, type Run } from "../src/run";

let rig: Rig;
let bin: FakeBin;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let queuedOutputs: ReadonlyArray<Schema.Json> = [];
let outputIndex = 0;
const Json = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeSync(Json);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      queuedOutputs = [];
      outputIndex = 0;
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const CLEAN = { verdict: "clean", findings: [] } satisfies Schema.JsonObject;
const SYNTH = {
  ...CLEAN,
  summary: "A one-file change to the CLI. Nothing wrong with it.",
} satisfies Schema.JsonObject;

/** review fans out to opus and sonnet, so a prompt lives under its variant. */
const readText = Effect.fn("test.readText")(function* (file: string) {
  return yield* fs.readFileString(file);
});

const exists = Effect.fn("test.exists")(function* (file: string) {
  return yield* fs.exists(file);
});

interface RanRun {
  run: Run;
  status: string;
  lines: string[];
}

type TestServices =
  Parameters<typeof runEffect<unknown, Error>>[0] extends Effect.Effect<
    unknown,
    Error,
    infer Services
  >
    ? Services
    : never;

class TestHerdr extends Herdr {
  constructor(
    pluginEnv: PluginEnv,
    private readonly fakeEnv: Record<string, string> & { FAKE_HERDR_LOG: string },
  ) {
    super(pluginEnv);
  }

  protected override exec(args: string[]) {
    if (args[0] === "agent" && args[1] === "prompt") return this.prompt(args);
    return Effect.promise(() =>
      runEffect(
        fakeHerdr(args).pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(this.fakeEnv))),
        ),
      ),
    );
  }

  private prompt(args: string[]) {
    const fakeEnv = this.fakeEnv;
    return Effect.promise(() =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const p = yield* Path.Path;
          const cmd = args.slice(0, 2).join(" ");
          yield* fs.writeFileString(
            fakeEnv.FAKE_HERDR_LOG,
            `${encodeJson({ transport: "cli", cmd, argv: args })}\n`,
            { flag: "a" },
          );

          const line = args[3] ?? "";
          const ref = /is in (\S+\.md) /.exec(line);
          const text = ref === null ? line : yield* fs.readFileString(ref[1]!);
          const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
          const next = queuedOutputs[outputIndex];
          outputIndex += 1;
          if (match !== null && next !== undefined && next !== null) {
            const outputPath = match[1]!.trim();
            yield* fs.makeDirectory(p.dirname(outputPath), { recursive: true });
            yield* fs.writeFileString(outputPath, encodeJson(next));
          }
          return { code: 0, stdout: `${encodeJson({ id: "fake", result: {} })}\n`, stderr: "" };
        }),
      ),
    );
  }
}
const queueOutputs = Effect.fn("test.queueOutputs")(function* (items: ReadonlyArray<Schema.Json>) {
  queuedOutputs = items;
  outputIndex = 0;
  const queued = items.map((output): Schema.JsonObject => ({ __write: {}, output }));
  yield* rig.queueOutputs(queued);
});

function runWorkflowEffect(
  name: string,
  inputs: Record<string, string>,
  opts: {
    defaults?: Partial<Defaults>;
    handoffTimeoutMs?: number;
    outputPollMs?: number;
    prompts?: EnginePrompts;
    promptsFor?: (run: Run) => EnginePrompts;
    env?: Record<string, string>;
    workspaceLabel?: string;
  } = {},
): Effect.Effect<RanRun, Error | PlatformError.PlatformError, TestServices> {
  const program: Effect.Effect<RanRun, Error | PlatformError.PlatformError, TestServices> =
    Effect.gen(function* () {
      const fakeEnv = { ...rig.env(opts.env), FAKE_HERDR_LOG: rig.logPath };
      const env = rig.pluginEnv(opts.env);
      const herdr = new TestHerdr(env, fakeEnv);
      const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
      const defaults = Object.assign(
        yield* loadDefaults(env.configDir),
        { trust: "never" },
        opts.defaults,
      );
      const wf = resolveWorkflow(name, defs, defaults);
      const errors = yield* validateWorkflow(wf, defs, defaults);
      if (errors.length > 0) return yield* Effect.fail(new Error(errors.join("\n")));

      const inferred = yield* inferInputs(wf.inputs, { cwd: env.cwd, stateDir: env.stateDir });
      for (const r of inferred) {
        const override = inputs[r.name];
        if (override === undefined) continue;
        r.value = override;
        r.source = "asked";
        if (r.strategy === "work-source")
          r.kind = yield* classifyWorkSource(override).pipe(Effect.map((c) => c.kind));
        if (r.strategy === "diff-target") r.kind = targetKind(override);
      }
      const merged = inputValues(inferred);
      const run = yield* new RunStore(env.stateDir).create({
        workflow: wf.name,
        cwd: env.cwd,
        session: env.socketPath,
        workspace: env.workspaceId,
        workspaceLabel: opts.workspaceLabel ?? "test",
        inputs: merged,
        inputSources: inputSources(inferred),
        stepIds: wf.steps.map((s) => s.id),
        maxIterations: wf.maxIterations,
        primaryInput:
          inferred.find((r) => merged[r.name] !== "")?.label ??
          Object.values(merged).find((v) => v !== "") ??
          "run",
      });

      const lines: string[] = [];
      const status = yield* Effect.tryPromise({
        try: () =>
          runEffect(
            executeRun({
              herdr,
              defs,
              defaults,
              wf,
              run,
              out: (line) =>
                Effect.sync(() => {
                  lines.push(line);
                }),
              handoffTimeoutMs: opts.handoffTimeoutMs,
              outputPollMs: opts.outputPollMs,
              prompts: opts.promptsFor ? opts.promptsFor(run) : opts.prompts,
              env,
            }),
          ),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      return { run, status, lines };
    });
  return program;
}

function promptOf(run: { dir: string }, variant = "claude-opus") {
  return readText(path.join(run.dir, "steps", "review", variant, "prompt-1.md"));
}

/** A glab that answers `mr view` and appends every note it is asked to post. */
function fakeGlab(iid: number) {
  return Effect.gen(function* () {
    const notes = path.join(rig.root, "bin", "notes.txt");
    yield* bin.add(
      "glab",
      `case "$1 $2" in
      "--version ") echo "glab 1.40.0" ;;
      "auth status") echo "logged in" ;;
      "mr view") echo '{"iid": ${iid}, "state": "opened"}' ;;
      "mr note") shift 2; printf '%s\\n' "$@" >> ${notes} ;;
      "api user") echo '{"username": "mk"}' ;;
      "mr update") shift 2; printf '%s\\n' "$*" >> ${path.join(rig.root, "bin", "updates.txt")} ;;
      *) exit 1 ;;
    esac`,
    );
    yield* bin.add(
      "git",
      `case "$*" in
      "rev-parse --git-dir") echo .git ;;
      "remote get-url origin") echo git@gitlab.cego.dk:cego/herdr-plugin.git ;;
      "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)" ;;
      *) echo main ;;
    esac`,
    );
  });
}

test("review runs standalone on the inferred target, and post is no longer an input", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo '{"iid": 12, "state": "opened"}'`);
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Don't post"]);

      const { run, status } = yield* runWorkflowEffect("review", {}, { prompts });
      expect(status).toBe("done");
      // The kind is recorded next to the value, so a prompt can branch on it.
      expect(run.record.inputs).toEqual({
        target: "mr:12",
        target_kind: "mr",
        plan: "",
        previous: "",
      });
      expect(run.record.input_sources).toEqual({
        target: "open merge request !12",
        plan: "default",
        previous: "default",
      });

      const prompt = yield* promptOf(run);
      expect(prompt).toContain("Review target: mr:12");
      expect(prompt).not.toContain("Post to GitLab");
      expect(prompt).toContain(
        `OUTPUT_PATH: ${path.join(run.dir, "steps", "review", "claude-opus", "review.json")}`,
      );

      // Same persona, two models: that is the whole difference between the variants.
      const starts = (yield* rig.calls()).filter((c) => c.cmd === "agent start");
      expect(starts.map((c) => c.argv!.slice(8))).toEqual([
        [
          "--model",
          "opus",
          "--effort",
          "medium",
          "--append-system-prompt-file",
          path.join(run.dir, "personas", "reviewer.claude.md"),
        ],
        [
          "--model",
          "sonnet",
          "--effort",
          "xhigh",
          "--append-system-prompt-file",
          path.join(run.dir, "personas", "reviewer.claude.md"),
        ],
        [
          "--model",
          "opus",
          "--append-system-prompt-file",
          path.join(run.dir, "personas", "reviewer.claude.md"),
        ],
      ]);
      expect(yield* readText(path.join(run.dir, "personas", "reviewer.claude.md"))).toContain(
        "You are a reviewer",
      );
    }),
  ));

test("the synthesiser is handed every reviewer's Output and writes one review", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      const opus = {
        verdict: "findings",
        findings: [
          {
            file: "cli.js",
            line: 4,
            severity: "blocker",
            title: "no exit code",
            detail: "returns 1",
          },
        ],
      };
      const sonnet = {
        verdict: "findings",
        findings: [{ file: "cli.js", line: 9, severity: "minor", title: "loose equality" }],
      };
      const synthesized = {
        verdict: "findings",
        summary: "Adds a --version flag to the CLI. One blocker: it exits with the wrong code.",
        findings: [
          {
            file: "cli.js",
            line: 4,
            severity: "blocker",
            title: "The exit code is 1 on success",
            detail: "A caller cannot tell it worked.",
          },
          { file: "cli.js", line: 9, severity: "minor", title: "Loose equality on the flag" },
        ],
        dropped: [
          {
            file: "cli.js",
            severity: "minor",
            title: "no engines field",
            reason: "packaging is out of this branch's scope",
          },
        ],
      };
      yield* queueOutputs([opus, sonnet, synthesized]);

      const { run, status, lines } = yield* runWorkflowEffect(
        "review",
        {},
        {
          prompts: scriptedPrompts(["Don't post"]),
        },
      );

      expect(status).toBe("done");
      // The prompt names both reviews by path; the synthesiser reads them itself.
      const prompt = yield* readText(path.join(run.dir, "steps", "synthesize", "prompt-1.md"));
      expect(prompt).toContain(
        `- ${path.join(run.dir, "steps", "review", "claude-opus", "review.json")}`,
      );
      expect(prompt).toContain(
        `- ${path.join(run.dir, "steps", "review", "claude-sonnet", "review.json")}`,
      );
      expect(prompt).toContain("Never say which model or which skill found it");
      expect(prompt).toContain(
        `OUTPUT_PATH: ${path.join(run.dir, "steps", "synthesize", "synthesized.json")}`,
      );

      // One review comes out, rendered for a human and printed where they are looking.
      const review = yield* readText(path.join(run.dir, REVIEW_FILE));
      expect(review).toBe(
        [
          "Adds a --version flag to the CLI. One blocker: it exits with the wrong code.",
          "",
          "**Blocker**",
          "",
          "- `cli.js:4` — The exit code is 1 on success",
          "  A caller cannot tell it worked.",
          "",
          "**Minor**",
          "",
          "- `cli.js:9` — Loose equality on the flag",
          "",
        ].join("\n"),
      );
      expect(lines.join("\n")).toContain(review.trimEnd());
      // Nothing about the process or the models reaches the human-facing review.
      expect(review).not.toContain("dropped");
      expect(review).not.toContain("opus");
      expect(review.split("\n")).toHaveLength(11);
    }),
  ));

test("the synthesis pane opens under the reviewers, in their tab", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);

      const { run } = yield* runWorkflowEffect("review", {});

      const reviewers = run.step("review").variants;
      const synth = run.step("synthesize").variants[0]!;
      expect(synth.tabId).toBe(reviewers[1]!.tabId);
      expect(synth.paneId).not.toBe(reviewers[1]!.paneId);

      // Down, not right: a third column would leave all three unreadable.
      const split = (yield* rig.calls())
        .filter((c) => c.cmd === "pane split")
        .find((c) => c.argv![2] === reviewers[1]!.paneId)!;
      expect(split.argv!.slice(3, 7)).toEqual(["--direction", "down", "--ratio", "0.5"]);
      // One tab for the whole run: the reviewers', which the synthesis joins.
      expect((yield* rig.cmds()).filter((c) => c === "tab create")).toHaveLength(1);
      expect(
        (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
      ).toContain("Synthesize");
    }),
  ));

test("a synthesis without a summary, or a dropped finding without a reason, fails the step", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([CLEAN, CLEAN, CLEAN]);

      const { run, status } = yield* runWorkflowEffect("review", {});

      expect(status).toBe("blocked");
      expect(run.step("synthesize").variants[0]!.error).toBe(
        "steps/synthesize/synthesized.json: summary is required",
      );
      expect(yield* exists(path.join(run.dir, REVIEW_FILE))).toBe(false);
    }),
  ));

test("an MR target offers the post choice, and Post sends review.md as one note", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGlab(12);
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Post to MR"]);

      const { run, status, lines } = yield* runWorkflowEffect("review", {}, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Post to MR", "Don't post"],
      ]);
      const where = "gitlab.cego.dk/cego/herdr-plugin!12";
      expect(run.step("post").note).toBe(`chose "Post to MR" — posted the review to ${where}`);
      expect(lines).toContain(`  posted the review to ${where}`);
      // Reviewing it makes mk its reviewer, before the menu and whatever is chosen there.
      expect(lines).toContain(`  ▸ mk is reviewer on ${where}`);
      expect(yield* readText(path.join(rig.root, "bin", "updates.txt"))).toBe(
        "12 --repo gitlab.cego.dk/cego/herdr-plugin --reviewer +mk\n",
      );

      // Exactly one note, sent with --repo so no checkout is needed, and review.md
      // character for character.
      const posted = yield* readText(path.join(rig.root, "bin", "notes.txt"));
      expect(posted).toBe(
        `12\n--repo\ngitlab.cego.dk/cego/herdr-plugin\n--message\n${yield* readText(path.join(run.dir, REVIEW_FILE))}\n`,
      );
    }),
  ));

test("an explicit MR can be reviewed and posted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGlab(7);
      const notes = path.join(rig.root, "bin", "notes.txt");

      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Post to MR"]);

      const { run, status } = yield* runWorkflowEffect("review", {}, { prompts });

      // The step is offered and can post to the inferred MR.
      expect(status).toBe("done");
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Post to MR", "Don't post"],
      ]);
      expect(run.step("post").note).toBe(
        `chose "Post to MR" — posted the review to gitlab.cego.dk/cego/herdr-plugin!7`,
      );
      expect(yield* readText(notes)).toBe(
        `7\n--repo\ngitlab.cego.dk/cego/herdr-plugin\n--message\n${yield* readText(path.join(run.dir, REVIEW_FILE))}\n`,
      );

      // The reviewers were told how to read it without a checkout.
      const prompt = yield* readText(
        path.join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"),
      );
      expect(prompt).toContain("glab mr diff <iid>");
      expect(prompt).not.toContain("{{target_repo}}");
    }),
  ));

test("Don't post leaves the merge request alone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGlab(12);
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Don't post"]);

      const { run, status } = yield* runWorkflowEffect("review", {}, { prompts });

      expect(status).toBe("done");
      expect(run.step("post").note).toBe(`chose "Don't post"`);
      expect(yield* exists(path.join(rig.root, "bin", "notes.txt"))).toBe(false);
    }),
  ));

test("a note that will not send re-offers the menu instead of ending the step", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add(
        "glab",
        `case "$1 $2" in "--version ") echo "glab 1.40.0" ;; "mr view") echo '{"iid": 12, "state": "opened"}' ;; *) exit 3 ;; esac`,
      );
      yield* bin.add(
        "git",
        `case "$1 $2" in "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/x.git (fetch)" ;; *) echo main ;; esac`,
      );
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Post to MR", "Don't post"]);

      const { status, lines } = yield* runWorkflowEffect("review", {}, { prompts });

      expect(status).toBe("done");
      expect(lines).toContain("  glab mr note !12 failed (exit 3)");
      expect(prompts.offered).toHaveLength(2);
    }),
  ));

test("a branch target cannot be posted to, so the menu offers what it can", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$1 $2" in "rev-parse --abbrev-ref") echo feature ;; *) echo main ;; esac`,
      );
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const prompts = scriptedPrompts(["Don't post"]);

      const { run, status, lines } = yield* runWorkflowEffect("review", {}, { prompts });

      expect(status).toBe("done");
      expect(run.record.inputs.target_kind).toBe("branch");
      // No merge request to post to, and no implementer live, so the two that are left.
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Don't post"],
      ]);
      expect(run.step("post").note).toBe(`chose "Don't post"`);
      // The review is still written, and still printed for the human.
      expect(yield* readText(path.join(run.dir, REVIEW_FILE))).toContain("Nothing to fix.");
      expect(lines.join("\n")).toContain("Nothing to fix.");
    }),
  ));

test("a menu with nothing but an ending left is skipped, not asked", () =>
  runEffect(
    Effect.gen(function* () {
      // Nothing here can post and nothing is live, so the only choice left is `stop` —
      // and a menu whose every option is an ending is not a question worth asking.
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "endings",
        `---
name: endings
inputs:
  target: diff-target
steps:
  - id: next
    choices:
      - title: Post to MR
        post: true
        requires: [mr-target, gitlab]
      - title: Hand it over
        handoff: implementer
      - title: Don't post
        stop: true
---
Target: {{inputs.target}}
`,
      );
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$1 $2" in "rev-parse --abbrev-ref") echo feature ;; *) echo main ;; esac`,
      );

      const { run, status, lines } = yield* runWorkflowEffect(
        "endings",
        {},
        { prompts: scriptedPrompts([]) },
      );

      expect(status).toBe("done");
      expect(run.step("next").note).toContain("skipped: nothing to decide");
      expect(run.step("next").note).toContain("Post to MR");
      expect(run.step("next").note).toContain("Hand it over");
      expect(lines.some((l) => l.startsWith("◦ next — nothing to decide"))).toBe(true);
    }),
  ));

test("a review.json that breaks the Output schema fails the step with the schema error", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // Twice, because one unusable Output now buys a repair round: the second is
      // what the step is finally judged on.
      const broken = { verdict: "findings", findings: [] };
      // The reviewers are prompted first and collected after, so the repair's write
      // is the third in the queue.
      yield* queueOutputs([broken, CLEAN, broken]);

      const { run, status } = yield* runWorkflowEffect("review", {});

      expect(status).toBe("blocked");
      expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
      expect(run.record.steps[0]!.variants[0]!.repairs).toHaveLength(1);
      expect(run.record.steps[0]!.variants[0]!.error).toBe(
        'steps/review/claude-opus/review.json: verdict "findings" with an empty findings list',
      );
    }),
  ));

test("the working tree is the last resort target", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);

      const { run } = yield* runWorkflowEffect("review", {});

      expect(run.record.inputs.target).toBe("worktree");
      expect(yield* promptOf(run)).toContain("Review target: worktree");
    }),
  ));

test("a synthesis written as one newline is repaired, not thrown away", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // This is the failure that found the bug: the fan-in Output was one newline,
      // and the whole round — two reviewers — was discarded over a write.
      yield* queueOutputs([CLEAN, CLEAN, "\n", SYNTH]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      const synthesize = run.record.steps[1]!.variants[0]!;
      expect(synthesize.status).toBe("done");
      expect(synthesize.repairs).toHaveLength(1);
    }),
  ));

test("a second review of the same target is given the first one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // A branch, not the working tree: `worktree` names no change, so it is never
      // matched against an earlier review (that would be another branch's findings).
      const target = { target: "branch:main...feature" };
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const first = yield* runWorkflowEffect("review", target, {
        prompts: scriptedPrompts(["Don't post"]),
      });
      expect(first.status).toBe("done");

      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const second = yield* runWorkflowEffect("review", target, {
        prompts: scriptedPrompts(["Don't post"]),
      });

      // The rally is traceable in both directions, and the reviewers read what was
      // said last time rather than re-deriving it.
      expect(second.run.record.previous_review).toBe(first.run.id);
      const prompt = yield* promptOf(second.run);
      expect(prompt).toContain("Nothing to fix.");
      expect(prompt).toContain("Earlier review of this target");
      expect(prompt).toContain("say what happened to it — still");
      // A first review has no section at all, rather than a heading over nothing.
      expect(yield* promptOf(first.run)).not.toContain("Earlier review of this target");
      expect(first.run.record.previous_review).toBeNull();
    }),
  ));

test("a re-review narrows the previous run's outstanding to its own verdict", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      const target = { target: "branch:main...feature" };
      yield* queueOutputs([
        CLEAN,
        CLEAN,
        {
          verdict: "findings",
          summary: "It exits wrong.",
          findings: [
            { file: "cli.js", line: 4, severity: "blocker", title: "exit code", detail: "wrong" },
          ],
          dropped: [],
        },
      ]);
      const first = yield* runWorkflowEffect("review", target, {
        prompts: scriptedPrompts(["Don't post"]),
      });
      expect(first.run.record.outstanding).toHaveLength(1);

      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const second = yield* runWorkflowEffect("review", target, {
        prompts: scriptedPrompts(["Don't post"]),
      });
      expect(second.run.record.previous_review).toBe(first.run.id);

      // The newer verdict on the same target is the current one, so the first run
      // stops reporting a finding the re-review no longer holds open.
      const reloaded = yield* new RunStore(rig.stateDir).load(first.run.id);
      expect(reloaded.record.outstanding).toHaveLength(0);
    }),
  ));

test("the working tree is never matched against an earlier review of it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // Every review of this checkout's working tree carries the same target, so a
      // second one would otherwise be handed a different branch's findings.
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      yield* runWorkflowEffect(
        "review",
        { target: "worktree" },
        {
          prompts: scriptedPrompts(["Don't post"]),
        },
      );

      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);
      const second = yield* runWorkflowEffect(
        "review",
        { target: "worktree" },
        {
          prompts: scriptedPrompts(["Don't post"]),
        },
      );

      expect(second.run.record.previous_review).toBeNull();
      expect(yield* promptOf(second.run)).not.toContain("Earlier review of this target");
    }),
  ));

test("a choice this environment cannot carry out is not offered at launch", () =>
  runEffect(
    Effect.gen(function* () {
      // No GitLab and a working-tree target, so posting the review is not on the table
      // — and deciding it at launch would send the unattended run back to the menu.
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      const env = rig.pluginEnv();
      const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
      const wf = resolveWorkflow("review", defs, FALLBACK_DEFAULTS);
      const resolutions = yield* inferInputs(wf.inputs, { cwd: env.cwd, stateDir: env.stateDir });

      const decidable = yield* decidableSteps(wf, env, resolutions);

      const post = decidable.find((entry) => entry.step.id === "post")!;
      const titles = post.items.map((item) => item.title);
      expect(titles).toContain("Fix findings");
      expect(titles).toContain("Don't post");
      expect(titles).not.toContain("Post to MR");
      // The hand-off and its twin are one decision, offered whoever is live right now:
      // who is live at launch says nothing about who will be live an hour later.
      expect(titles.filter((t) => t === "Fix findings")).toHaveLength(1);
    }),
  ));

test("a review that ends with findings does not announce itself as clean", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([
        CLEAN,
        CLEAN,
        {
          verdict: "findings",
          summary: "Adds a flag. It exits wrong.",
          findings: [
            { file: "cli.js", line: 4, severity: "blocker", title: "exit code", detail: "wrong" },
            { file: "cli.js", severity: "minor", title: "no help text", detail: "missing" },
          ],
          dropped: [],
        },
      ]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      // The body is verdict-shaped: what came of the run, not that it ended.
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast.at(-1)).toContain("2 finding(s) still open");
      expect(toast.at(-1)).toContain("1 blocker");
      expect(toast.at(-1)).not.toBe("clean");
      expect(run.record.outstanding).toHaveLength(2);
    }),
  ));

test("a review that found the last round's findings gone says how many", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([
        CLEAN,
        CLEAN,
        {
          verdict: "clean",
          summary: "The blocker is gone. Nothing else came back.",
          findings: [],
          dropped: [],
          fixed: [
            { file: "cli.js", title: "exit code", note: "now exits 2" },
            { file: "cli.js", title: "no help text", note: "added" },
          ],
        },
      ]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      expect(run.record.fixed).toBe(2);
      // Clean alone undersells the rally; the count is what says it is converging.
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast.at(-1)).toBe("clean — 2 fixed");
    }),
  ));

test("a fix round that did not push says so, rather than reading as landed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // The fix round works on someone else's branch and is told not to push; a result
      // that looks like it landed and did not is worse than either outcome.
      yield* queueOutputs([
        CLEAN,
        CLEAN,
        {
          verdict: "findings",
          summary: "One blocker.",
          findings: [{ file: "cli.js", severity: "blocker", title: "exit code", detail: "d" }],
          dropped: [],
        },
        {
          verdict: "clean",
          findings: [],
          fixed: ["the exit code"],
          commits: ["fix the exit code"],
          branch: "feature/x",
          pushed: false,
        },
      ]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Fix findings", "Don't post"]) },
      );

      expect(status).toBe("done");
      expect(run.record.unpushed).toBe("feature/x");
      expect(run.record.summary).toContain("Committed on feature/x, not pushed.");
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast.at(-1)).toContain("commits on feature/x are not pushed");

      // And a merge request in the same run does not hide it: an MR URL is the first
      // thing the ending says, and local-only work must not read as shipped under it.
      run.record.mr_url = "https://gitlab.example.com/acme/app/-/merge_requests/7";
      expect(outcomeLine(run.record, "done")).toContain("commits on feature/x are not pushed");
    }),
  ));
