import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, scriptedPrompts } from "./support/engine";
import { testDefaults } from "./support/compaction";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { REVIEW_FILE } from "../src/output";
import type { Defaults } from "../src/config";
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

/**
 * The shape the baseline had until one complete review became the default, installed as
 * a user-layer override — which is exactly what a user who keeps two reviewers has. Every
 * test below that is about the fan-in itself asks for it.
 */
const twoReviewers = Effect.fn("test.twoReviewers")(function* () {
  const baseline = yield* fs.readFileString(path.join(rig.baselineDir, "workflows", "review.md"));
  yield* writeDef(
    rig.configDir,
    "workflows",
    "review",
    baseline.replace(
      "      - { harness: claude, model: opus, effort: medium }",
      "      - { harness: claude, model: opus, effort: medium }\n      - { harness: claude, model: sonnet, effort: xhigh }",
    ),
  );
});

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
        yield* testDefaults(env.configDir),
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
        inputStrategies: wf.inputs,
        // As a real start does: what a Run proves is the Workflow's own declaration, and
        // a fixture that withheld the definition would record a Run that proves nothing.
        definition: wf,
        stepIds: wf.steps.map((s) => s.id),
        maxIterations: wf.maxIterations,
        namedAfter:
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

/**
 * The review prompt. One reviewer has no variant directory of its own — a key is what
 * keeps several apart — so the default path is the step's, and a test that installs two
 * reviewers names the one it means.
 */
function promptOf(run: { dir: string }, variant: string | null = null) {
  const dir =
    variant === null ? [run.dir, "steps", "review"] : [run.dir, "steps", "review", variant];
  return readText(path.join(...dir, "prompt-1.md"));
}

/** A glab that answers `mr view` and appends every note it is asked to post. */
function fakeGlab(iid: number, assignees: readonly string[] = []) {
  return Effect.gen(function* () {
    const notes = path.join(rig.root, "bin", "notes.txt");
    const assigned = assignees.map((who) => `{"username": "${who}"}`).join(", ");
    yield* bin.add(
      "glab",
      `case "$1 $2" in
      "--version ") echo "glab 1.40.0" ;;
      "auth status") echo "logged in" ;;
      "mr view") echo '{"iid": ${iid}, "state": "opened", "assignees": [${assigned}]}' ;;
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
      yield* queueOutputs([SYNTH]);
      const prompts = scriptedPrompts(["Don't post"]);

      const { run, status } = yield* runWorkflowEffect("review", {}, { prompts });
      expect(status).toBe("done");
      // A review's outcome is fixed, and its one requirement — a summary a human can
      // read — was met, so nothing is left on the record as missing.
      expect(run.record.outcome).toBe("review");
      expect(run.record.evidence_gaps).toEqual([]);
      // The kind is recorded next to the value, so a prompt can branch on it.
      expect(run.record.inputs).toEqual({
        target: "mr:12",
        target_kind: "mr",
        plan: "",
        previous: "",
        risks: "",
        outcome: "",
      });
      expect(run.record.input_sources).toEqual({
        target: "open merge request !12",
        plan: "default",
        previous: "default",
        risks: "default",
        outcome: "default",
      });

      const prompt = yield* promptOf(run);
      expect(prompt).toContain("Review target: mr:12");
      expect(prompt).not.toContain("Post to GitLab");
      expect(prompt).toContain(
        `OUTPUT_PATH: ${path.join(run.dir, "steps", "review", "review.json")}`,
      );

      // One agent for the whole review: no second reviewer, and no model started to
      // reconcile one file into one file.
      const starts = (yield* rig.calls()).filter((c) => c.cmd === "agent start");
      expect(starts.map((c) => c.argv!.slice(8))).toEqual([
        [
          "--model",
          "opus",
          "--effort",
          "medium",
          "--append-system-prompt-file",
          path.join(run.dir, "personas", "reviewer.claude.md"),
          "--permission-mode",
          "bypassPermissions",
        ],
      ]);
      expect(run.step("synthesize").status).toBe("done");
      expect(run.step("synthesize").note).toBe("skipped: one review, nothing to reconcile");
      expect(run.step("synthesize").variants).toEqual([]);
      // The one review that was written is the review a human reads, and the record
      // points at it as the synthesis.
      expect(yield* readText(path.join(run.dir, REVIEW_FILE))).toContain(
        "A one-file change to the CLI.",
      );
      expect(run.record.synthesis).toBe(path.join("steps", "review", "review.json"));
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
      yield* twoReviewers();
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
      yield* twoReviewers();
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
      yield* twoReviewers();
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
      yield* queueOutputs([SYNTH]);
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

test("a merge request already assigned to me is reviewed for me, not at me", () =>
  runEffect(
    Effect.gen(function* () {
      // The same merge request as above, with one difference: it is mine to land.
      yield* fakeGlab(12, ["mk"]);
      yield* queueOutputs([SYNTH]);
      const prompts = scriptedPrompts(["Don't post"]);

      const { run, status, lines } = yield* runWorkflowEffect("review", {}, { prompts });

      expect(status).toBe("done");
      // Posting is not on the menu: the findings are the author's own to fix, and a note
      // would be the author writing to the author.
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Don't post"],
      ]);
      const where = "gitlab.cego.dk/cego/herdr-plugin!12";
      expect(lines).toContain(`  ▸ mk already has ${where}`);
      expect(lines).not.toContain(`  ▸ mk is reviewer on ${where}`);
      // Nobody was added in either role, so GitLab does not show a review that is really
      // one person reading their own change.
      expect(yield* exists(path.join(rig.root, "bin", "updates.txt"))).toBe(false);
      expect(yield* exists(path.join(rig.root, "bin", "notes.txt"))).toBe(false);
      expect(run.step("post").note).toContain("Don't post");
    }),
  ));

test("an explicit MR can be reviewed and posted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGlab(7);
      const notes = path.join(rig.root, "bin", "notes.txt");

      yield* queueOutputs([SYNTH]);
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
      const prompt = yield* readText(path.join(run.dir, "steps", "review", "prompt-1.md"));
      expect(prompt).toContain("glab mr diff <iid>");
      expect(prompt).not.toContain("{{target_repo}}");
    }),
  ));

test("Don't post leaves the merge request alone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGlab(12);
      yield* queueOutputs([SYNTH]);
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
      yield* queueOutputs([SYNTH]);
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
      yield* queueOutputs([SYNTH]);
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
      yield* queueOutputs([broken, broken]);

      const { run, status } = yield* runWorkflowEffect("review", {});

      expect(status).toBe("blocked");
      expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
      expect(run.record.steps[0]!.variants[0]!.repairs).toHaveLength(1);
      expect(run.record.steps[0]!.variants[0]!.error).toBe(
        'steps/review/review.json: verdict "findings" with an empty findings list',
      );
    }),
  ));

test("the working tree is the last resort target", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([SYNTH]);

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
      yield* twoReviewers();
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
      yield* queueOutputs([SYNTH]);
      const first = yield* runWorkflowEffect("review", target, {
        prompts: scriptedPrompts(["Don't post"]),
      });
      expect(first.status).toBe("done");

      yield* queueOutputs([SYNTH]);
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

      yield* queueOutputs([SYNTH]);
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
      yield* queueOutputs([SYNTH]);
      yield* runWorkflowEffect(
        "review",
        { target: "worktree" },
        {
          prompts: scriptedPrompts(["Don't post"]),
        },
      );

      yield* queueOutputs([SYNTH]);
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

test("a review that ends with findings does not announce itself as clean", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([
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

test("a user who keeps two reviewers keeps the synthesis exactly as it was", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* twoReviewers();
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      // Three agents: two reviewers and the model that reconciles them. Changing the
      // baseline default must not reach into a layer that says otherwise.
      expect((yield* rig.calls()).filter((c) => c.cmd === "agent start")).toHaveLength(3);
      expect(run.step("synthesize").note).toBeNull();
      expect(run.step("synthesize").variants).toHaveLength(1);
      expect(run.record.synthesis).toBe(path.join("steps", "synthesize", "synthesized.json"));
    }),
  ));

test("a blocking finding that says neither where nor why goes back to the reviewer once", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      const vague = {
        verdict: "findings",
        summary: "Adds a flag. Something is wrong with it.",
        dropped: [],
        findings: [{ severity: "blocker", title: "this feels wrong" }],
      };
      const substantiated = {
        verdict: "findings",
        summary: "Adds a flag. It breaks a caller.",
        dropped: [],
        findings: [
          {
            // Deliberately a file this change never touched: an unchanged caller the
            // change breaks is a real blocker, and must not be refused for that.
            file: "src/other-caller.ts",
            line: 12,
            severity: "blocker",
            title: "the caller still passes two arguments",
            detail: "It calls the renamed function with the old arity and will throw.",
          },
        ],
      };
      yield* queueOutputs([vague, substantiated]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      const repairs = run.step("review").variants[0]!.repairs;
      expect(repairs).toHaveLength(1);
      expect(repairs[0]).toContain("say neither where nor why");
      expect(repairs[0]).toContain('"this feels wrong"');
      expect(repairs[0]).toContain("need not be one the change touched");

      // The second Output stands, unchanged file and all.
      expect(run.record.outstanding).toHaveLength(1);
      expect(run.record.outstanding[0]!.file).toBe("src/other-caller.ts");
    }),
  ));

test("a minor finding is not held to a blocker's standard", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([
        {
          verdict: "findings",
          summary: "Adds a flag. One passing remark.",
          dropped: [],
          findings: [{ severity: "minor", title: "could be shorter" }],
        },
      ]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      // A note nobody has to act on must not cost a repair round.
      expect(run.step("review").variants[0]!.repairs).toEqual([]);
    }),
  ));

test("a risk axis is asked for or it is not there at all", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* queueOutputs([SYNTH]);
      const plain = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );
      const ordinary = yield* promptOf(plain.run);
      expect(ordinary).not.toContain("Additional axes requested");
      expect(ordinary).toContain("need not be one the change touched");
      // A review on its own has no outcome to judge, and says so rather than guessing one.
      expect(ordinary).toContain("Outcome the change has to prove (empty means unclassified): \n");

      yield* queueOutputs([SYNTH]);
      const asked = yield* runWorkflowEffect(
        "review",
        { risks: "security", outcome: "refactor" },
        { prompts: scriptedPrompts(["Don't post"]) },
      );
      const specialist = yield* promptOf(asked.run);
      expect(specialist).toContain(
        "Outcome the change has to prove (empty means unclassified): refactor",
      );
      expect(specialist).toContain('"behavior_preserved": true');
      expect(specialist).toContain("Additional axes requested for this change: security");
      expect(specialist).toContain("security-and-hardening");
      expect(specialist).toContain("on top of the complete review, not instead of it");
    }),
  ));

test("a lone review that does not read as a review is sent back to its own reviewer", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      // No summary: with nobody reconciling it, this Output is the review a human reads,
      // so it is held to that shape rather than quietly published without one.
      yield* queueOutputs([CLEAN, SYNTH]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        { prompts: scriptedPrompts(["Don't post"]) },
      );

      expect(status).toBe("done");
      const repairs = run.step("review").variants[0]!.repairs;
      expect(repairs).toHaveLength(1);
      expect(repairs[0]).toContain("summary is required");
      expect(yield* readText(path.join(run.dir, REVIEW_FILE))).toContain("A one-file change");
    }),
  ));
