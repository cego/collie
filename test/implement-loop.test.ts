import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import { Rig } from "./support/recorder";
import { COLLIE_TAB } from "../src/naming";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun, scriptedPrompts } from "./support/engine";
import { testDefaults } from "./support/compaction";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { FALLBACK_DEFAULTS, type Defaults } from "../src/config";
import { skillsIn } from "../src/template";
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
import { deliveriesOf } from "../src/steering";
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
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* plannedRun(rig, "add-picker");
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
const NO_EXIT = { file: "cli.js", line: 4, severity: "blocker", title: "no exit code" };
const FINDING = { verdict: "findings", findings: [NO_EXIT] } satisfies Schema.JsonObject;
const OTHER_FINDING = {
  verdict: "findings",
  findings: [{ file: "cli.js", line: 2, severity: "minor", title: "loose equality" }],
} satisfies Schema.JsonObject;
/** What the synthesiser writes: one review, and the summary a human reads first. */
const SUMMARY = "Adds a --version flag to the CLI. ";
const SYNTH = { ...CLEAN, summary: `${SUMMARY}Nothing wrong with it.` } satisfies Schema.JsonObject;
const synthesized = (...raw: { findings: readonly Schema.Json[] }[]): Schema.JsonObject => ({
  verdict: "findings",
  summary: `${SUMMARY}The reviewers found something.`,
  findings: raw.flatMap((r) => r.findings),
});

const MAJOR = { file: "cli.js", line: 9, severity: "major", title: "unhandled rejection" };
const blocking = (...findings: Schema.JsonObject[]): Schema.JsonObject => ({
  verdict: "findings",
  summary: `${SUMMARY}The reviewers found something.`,
  findings,
});
/** What a fix reports under the converging loop: dispositions by key, and its checks. */
const fixed = (...titles: string[]) => ({
  verdict: "clean",
  findings: [],
  fixed: titles.map((title) => ({ file: "cli.js", title, note: "done" })),
  checks: [{ name: "bun test", passed: true, note: "all pass" }],
});
const FIX_OK = fixed("no exit code");

/** The bundled implement workflow, edited, installed as the project's own. */
const bundledImplement = Effect.fn("test.bundledImplement")(function* (
  edit: (text: string) => string,
) {
  const text = yield* readText(path.join(rig.baselineDir, "workflows", "implement.md"));
  yield* writeDef(path.join(rig.projectDir, ".herdr"), "workflows", "implement", edit(text));
});
/** The loop as it was before `converge`: every finding drives it, the cap blocks. */
const legacy = (text: string) => text.replace(/^ {6}converge: true\n/m, "");
const withMax = (n: number) => (text: string) =>
  text.replace(/^max_iterations: \d+$/m, `max_iterations: ${n}`);

/** Which step each prompt went to, in order — i.e. the path the run took. */
function promptOrder(
  calls: ReadonlyArray<{ cmd: string; argv?: ReadonlyArray<string> }>,
  runDir: string,
): string[] {
  return calls
    .filter((c) => c.cmd === "agent prompt")
    .map((c) => path.relative(runDir, /is in (\S+)/.exec(c.argv?.[3] ?? "")?.[1] ?? runDir));
}

const readText = Effect.fn("test.readText")(function* (file: string) {
  return yield* fs.readFileString(file);
});

const writeText = Effect.fn("test.writeText")(function* (file: string, text: string) {
  yield* fs.writeFileString(file, text);
});

const makeDirectory = Effect.fn("test.makeDirectory")(function* (dir: string) {
  yield* fs.makeDirectory(dir, { recursive: true });
});

const loadTestDefinitions = Effect.fn("test.loadDefinitions")(function* () {
  return yield* layers(rig.pluginEnv()).pipe(Effect.flatMap(loadDefinitions));
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
          // A wait that ran out, as the shared fake answers it: the Output was still
          // written, because the agent works on a prompt whether or not herdr saw the turn.
          if (fakeEnv.FAKE_HERDR_PROMPT_ERROR === "timeout")
            return {
              code: 1,
              stdout: `${encodeJson({ id: "fake", error: { code: "timeout", message: "timeout" } })}\n`,
              stderr: "",
            };
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
    /** Drive this run again instead of creating one: what a resume does. */
    existing?: Run;
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
      const run =
        opts.existing ??
        (yield* new RunStore(env.stateDir).create({
          workflow: wf.name,
          cwd: env.cwd,
          session: env.socketPath,
          workspace: env.workspaceId,
          workspaceLabel: opts.workspaceLabel ?? "test",
          inputs: merged,
          inputSources: inputSources(inferred),
          stepIds: wf.steps.map((s) => s.id),
          maxIterations: wf.maxIterations,
          namedAfter:
            inferred.find((r) => merged[r.name] !== "")?.label ??
            Object.values(merged).find((v) => v !== "") ??
            "run",
        }));

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

test("implement is build, architecture, simplify, review, fix — and no commit step", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadTestDefinitions();
      const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);

      expect(wf.steps.map((s) => s.id)).toEqual([
        "build",
        "architecture",
        "simplify",
        "review",
        "review.synthesize",
        "fix",
        "mr",
      ]);
      expect(wf.steps.map((s) => s.agent)).toEqual([
        undefined,
        "build",
        "build",
        undefined,
        undefined,
        "build",
        "build",
      ]);
      // The gate is the one synthesised review, not the reviewers' raw union.
      expect(wf.steps[4]!.fanIn).toBe("review");
      expect(wf.steps[5]!.repeat).toEqual({
        from: "review.synthesize",
        back_to: "simplify",
        converge: true,
      });
      expect(wf.maxIterations).toBe(4);
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);

      const build = wf.steps[0]!.prompt;
      expect(build).toContain("checkout of its own, on the branch it is building");
      expect(build).toContain("one commit per ticket");
      // The skill is named, not spelled: the harness decides whether that is `/tdd`.
      expect(skillsIn(build)).toContain("tdd");
      expect(
        wf.steps.some((s) => /commit the work|commit step/i.test(s.prompt) && s.id !== "build"),
      ).toBe(false);
    }),
  ));

test("implement takes an optional repo, and the build prompt builds only its tickets", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadTestDefinitions();
      const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);

      expect(wf.inputs.repo).toBe("optional");
      // The `Repo:` line the planner wrote is what the run reads to know its share of a
      // plan that spans repositories; an empty one is the whole plan, as it always was.
      expect(wf.steps[0]!.preamble).toContain("{{inputs.repo}}");
      expect(wf.steps[0]!.prompt).toContain("**Repo:**");
    }),
  ));

test(
  "findings loop fix → simplify → review, and architecture stays out of the loop",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN, // build
          CLEAN, // architecture
          CLEAN, // simplify
          FINDING, // review/claude-opus
          OTHER_FINDING, // review/claude-sonnet
          synthesized(FINDING, OTHER_FINDING), // review.synthesize
          {
            ...CLEAN,
            disputed: [
              {
                file: "cli.js",
                severity: "minor",
                title: "loose equality",
                detail: "== is fine here",
              },
            ],
          }, // fix
          CLEAN, // simplify, iteration 2
          CLEAN, // review/claude-opus
          CLEAN, // review/claude-sonnet
          SYNTH, // review.synthesize
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(2);
        expect(promptOrder(yield* rig.calls(), run.dir)).toEqual([
          "steps/build/prompt-1.md",
          "steps/architecture/prompt-1.md",
          "steps/simplify/prompt-1.md",
          "steps/review/claude-opus/prompt-1.md",
          "steps/review/claude-sonnet/prompt-1.md",
          "steps/review.synthesize/prompt-1.md",
          "steps/fix/prompt-1.md",
          "steps/simplify/prompt-2.md",
          "steps/review/claude-opus/prompt-2.md",
          "steps/review/claude-sonnet/prompt-2.md",
          "steps/review.synthesize/prompt-2.md",
        ]);
        expect(run.record.steps.map((s) => [s.id, s.status, s.note])).toEqual([
          ["build", "done", null],
          ["architecture", "done", null],
          ["simplify", "done", null],
          ["review", "done", null],
          ["review.synthesize", "done", null],
          ["fix", "done", "skipped: reviews clean"],
          // No glab in the rig, so the MR step is skipped rather than failing the run.
          ["mr", "done", "skipped: glab is not installed"],
        ]);
        expect(lines).toContain("  2 finding(s) to fix, 1 blocking");
        expect(lines).toContain("  looping back to simplify (iteration 2)");
        expect(lines).toContain("  reviews clean — skipping fix");

        // One synthesised review reaches the implementer, carrying both reviewers' findings.
        const fix = yield* readText(path.join(run.dir, "steps", "fix", "prompt-1.md"));
        expect(fix).toContain("- [blocker] no exit code (cli.js:4)");
        expect(fix).toContain("- [minor] loose equality (cli.js:2)");
        expect(fix).toContain("Iteration 1 of at most 4");
        expect(run.record.summary).toContain("Disputed findings");
      }),
    ),
  20_000,
);

test(
  "legacy: the loop stops at max_iterations and blocks with the findings still open, whatever the last fix said",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement((text) => legacy(withMax(2)(text)));
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          CLEAN,
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("blocked");
        expect(run.record.iteration).toBe(2);
        expect(run.record.halt).toBeNull();
        expect(run.step("fix").note).toBe("stopped at max_iterations 2 with 1 finding(s)");
        expect(lines).toContain("  max_iterations (2) reached with 1 finding(s)");
        expect(run.record.summary).toContain("Findings still open:");
        expect(run.record.summary).toContain("- [blocker] no exit code (cli.js:4)");
      }),
    ),
  20_000,
);

test(
  "the reviewers are one persona at two models, side by side in one tab, restarted every round",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);

        const { run } = yield* runWorkflowEffect("implement", {});

        // Two tabs, both named after the run and the step it opened them for: no
        // model and no slug — and the review step keeps its tab across both iterations.
        const created = (yield* rig.calls()).filter((c) => c.cmd === "tab create");
        expect(created.map((c) => c.argv!.at(-2))).toEqual([
          "⚙ Implement · add-picker · build",
          "⚙ Implement · add-picker · review",
        ]);
        expect(new Set(run.step("review").variants.map((v) => v.tabId)).size).toBe(1);

        // The second variant sits beside the first, each taking half the tab. A restart
        // splits without a ratio and closes the old pane, so it lands in the same slot.
        const rightSplits = (yield* rig.calls()).filter(
          (c) => c.cmd === "pane split" && c.argv!.includes("right"),
        );
        const sideBySide = rightSplits.filter((c) => c.argv!.includes("--ratio"));
        expect(sideBySide).toHaveLength(1);
        for (const split of sideBySide) {
          expect(split.argv![split.argv!.indexOf("--ratio") + 1]).toBe("0.5");
        }
        // The two reviewers and the synthesiser, all restarted for the second round.
        expect(rightSplits.length - sideBySide.length).toBe(3);
        // Parallel panes say which model they are, and nothing else does: the run's own
        // pane on the board says the workflow, and no pane anywhere names the run.
        const renames = (yield* rig.calls())
          .filter((c) => c.cmd === "pane rename")
          .map((c) => c.argv!.at(-1));
        expect(renames).toContain("Opus");
        expect(renames).toContain("Sonnet");
        expect(renames).toContain("Synthesize");
        // Nothing names the run: the implementer's pane is unlabelled and the run has no
        // pane of its own. The board's pane is not renamed either — the Home's pane is
        // owned by a token, not by a name (ADR-0009).
        expect(renames.some((n) => n!.includes("add-picker"))).toBe(false);
        expect(renames).not.toContain(COLLIE_TAB);

        const reviewer = path.join(run.dir, "personas", "reviewer.claude.md");
        const starts = (yield* rig.calls()).filter((c) => c.cmd === "agent start");
        // Every Claude start names its model; default resolves to the pinned Opus alias,
        // and every one of them ends with the unattended switch.
        expect(starts.map((c) => c.argv!.slice(-2))).toEqual(
          starts.map(() => ["--permission-mode", "bypassPermissions"]),
        );
        expect(starts.map((c) => c.argv!.slice(7, -2))).toEqual([
          [
            "--",
            "--model",
            "opus",
            "--effort",
            "medium",
            "--append-system-prompt-file",
            path.join(run.dir, "personas", "implementer.claude.md"),
          ],
          ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
          ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
          ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
          ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
          ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
          ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
        ]);
        expect(starts.flatMap((c) => c.argv!).filter((a) => a === "--model")).toHaveLength(7);

        // Every step that keeps the implementer's agent records the model it is actually on.
        for (const step of ["build", "architecture", "simplify", "fix"]) {
          expect(run.step(step).variants[0]!.model).toBe("opus");
          expect(run.step(step).variants[0]!.effort).toBe("medium");
        }
        expect(run.step("review").variants.map((v) => [v.model, v.effort])).toEqual([
          ["opus", "medium"],
          ["sonnet", "xhigh"],
        ]);

        // One implementer throughout: build, architecture, simplify and fix share its agent.
        const implementer = run.step("build").variants[0]!.agent;
        for (const step of ["architecture", "simplify", "fix"]) {
          expect(run.step(step).variants[0]!.agent).toBe(implementer);
        }
        expect((yield* rig.cmds()).filter((c) => c === "pane close")).toHaveLength(3);
      }),
    ),
  20_000,
);

test("review standalone is the same two variants, and says so when it has no spec", () =>
  runEffect(
    Effect.gen(function* () {
      yield* queueOutputs([CLEAN, CLEAN, SYNTH]);

      const { run, status } = yield* runWorkflowEffect(
        "review",
        {},
        {
          prompts: scriptedPrompts(["Don't post"]),
        },
      );

      expect(status).toBe("done");
      expect(run.record.steps[0]!.variants.map((v) => [v.harness, v.model, v.effort])).toEqual([
        ["claude", "opus", "medium"],
        ["claude", "sonnet", "xhigh"],
      ]);
      const prompt = yield* readText(
        path.join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"),
      );
      expect(prompt).toContain("Review target: worktree");
      expect(prompt).toContain("Spec: \n");
      expect(prompt).toContain("there is no spec");
      // Declared and empty, not undeclared: the spec line resolves on every run.
      expect(yield* readText(path.join(run.dir, "log.txt"))).not.toContain(
        "unknown template keys in review",
      );
    }),
  ));

test("review inside implement is held to the plan the run was given", () =>
  runEffect(
    Effect.gen(function* () {
      yield* queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

      const { run } = yield* runWorkflowEffect("implement", {});

      const prompt = yield* readText(
        path.join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"),
      );
      expect(prompt).toContain(`Spec: ${run.record.inputs.plan}`);
      expect(run.record.inputs.plan).toContain("/plan");
    }),
  ));

const DISPUTED_REASON = {
  file: "cli.js",
  severity: "minor",
  title: "no exit code",
  detail: "the spec asks for this",
};

test(
  "legacy: a finding the implementer disputed stops driving the loop, so the run converges",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(legacy);
        yield* queueOutputs([
          CLEAN, // build
          CLEAN, // architecture
          CLEAN, // simplify
          FINDING, // review/claude-opus
          FINDING, // review/claude-sonnet
          synthesized(FINDING), // review.synthesize
          { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix: applies nothing, disputes it
          CLEAN, // simplify, iteration 2
          FINDING, // review/claude-opus, raises it again
          FINDING, // review/claude-sonnet, raises it again
          synthesized(FINDING), // review.synthesize carries it through
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(2);
        expect(run.step("fix").note).toBe("skipped: reviews clean");
        expect(lines).toContain("  1 finding(s) already disputed — your call, not the loop's");
        expect(run.record.summary).toContain("Disputed findings");
        expect(run.record.summary).toContain("- [minor] no exit code (cli.js)");

        // The reviewers were told what had already been argued.
        const second = yield* readText(
          path.join(run.dir, "steps", "review", "claude-opus", "prompt-2.md"),
        );
        expect(second).toContain("Already disputed");
        expect(second).toContain("- [minor] no exit code (cli.js)");
        expect(second).toContain("the spec asks for this");
      }),
    ),
  20_000,
);

test(
  "a reviewer that answers the dispute puts the finding back in front of the implementer",
  () =>
    runEffect(
      Effect.gen(function* () {
        // Legacy loop: under `converge` a fix that disputes every blocking finding stops
        // for the human instead of spending a review round on the argument.
        yield* bundledImplement(legacy);
        const rebutted = {
          verdict: "findings",
          findings: [{ ...NO_EXIT, rebuttal: "the spec's own out-of-scope line says otherwise" }],
        };
        yield* queueOutputs([
          CLEAN, // build
          CLEAN, // architecture
          CLEAN, // simplify
          FINDING, // review/claude-opus
          FINDING, // review/claude-sonnet
          synthesized(FINDING), // review.synthesize
          { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix disputes it
          CLEAN, // simplify, iteration 2
          rebutted, // review/claude-opus answers the dispute
          CLEAN, // review/claude-sonnet
          synthesized(rebutted), // the synthesis carries the rebuttal through
          CLEAN, // fix applies it
          CLEAN, // simplify, iteration 3
          CLEAN, // review/claude-opus
          CLEAN, // review/claude-sonnet
          SYNTH, // review.synthesize
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(3);
        expect(lines).toContain("  1 disputed finding(s) answered by a reviewer");
        // The argument moved on, so the dispute is no longer standing.
        expect(run.record.disputed).toEqual([]);

        const fix = yield* readText(path.join(run.dir, "steps", "fix", "prompt-2.md"));
        expect(fix).toContain("- [blocker] no exit code (cli.js:4)");
        expect(fix).toContain(
          "answers your dispute: the spec's own out-of-scope line says otherwise",
        );
        // Three iterations of a five-step workflow is a lot of fake agents.
      }),
    ),
  20_000,
);

test(
  "the build prompt is told which kind of work source it got, and nothing renders empty",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        const { run } = yield* runWorkflowEffect("implement", {});

        const build = yield* readText(path.join(run.dir, "steps", "build", "prompt-1.md"));
        expect(build).toContain("Work source (plan-dir):");
        // The three branches have to survive templating, or the implementer cannot choose one.
        for (const kind of ["**plan-dir**", "**linear**", "**text**"])
          expect(build).toContain(kind);
        // A key the run never set renders empty and is only visible in the log.
        expect(yield* readText(path.join(run.dir, "log.txt"))).not.toContain(
          "unknown template keys",
        );
      }),
    ),
  20_000,
);

test("review's inputs are the embedder's when it is embedded, so implement never asks for them", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadTestDefinitions();

      const implement = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);
      // `target` reaches implement only through `use: review`, so its picker must infer
      // it silently; `plan` is implement's own and is chosen normally.
      expect(implement.inputs.plan).toBe("work-source");
      expect(implement.inputs.target).toBe("diff-target");
      // `previous` is review's own too, and never asked for: it defaults to empty.
      expect(implement.embeddedInputs).toEqual(["target", "previous"]);
      // The post choice is standalone, so embedding review drops it.
      expect(implement.steps.some((s) => s.id.endsWith("post"))).toBe(false);
      expect(resolveWorkflow("review", defs, FALLBACK_DEFAULTS).steps.at(-1)!.id).toBe("post");

      // Standalone, the same input belongs to review itself, so the menu is shown.
      const review = resolveWorkflow("review", defs, FALLBACK_DEFAULTS);
      expect(review.inputs.target).toBe("diff-target");
      expect(review.embeddedInputs).toEqual([]);
    }),
  ));

/** glab and git as they look in a repo that really is on GitLab. */
function onGitLab(branch: string) {
  return Effect.gen(function* () {
    yield* bin.add(
      "glab",
      `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "--version ") echo "glab 1.40.0" ;;
      "api user") echo '{"username": "mk"}' ;;
      "mr update") shift 2; printf '%s\\n' "$*" >> ${path.join(rig.root, "bin", "updates.txt")} ;;
      *) exit 1 ;;
    esac`,
    );
    yield* bin.add(
      "git",
      `case "$1 $2" in
      "rev-parse --git-dir") echo .git ;;
      "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)" ;;
      "rev-parse --abbrev-ref") echo ${branch} ;;
      "status --porcelain") echo "" ;;
      *) echo main ;;
    esac`,
    );
  });
}

test("the mr step is skipped, not failed, when this repo cannot have a merge request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.add("glab", `echo "glab 1.40.0"`);
      yield* bin.add(
        "git",
        `case "$1 $2" in "remote -v") echo "origin\tgit@github.com:me/x.git (fetch)" ;; *) echo main ;; esac`,
      );
      yield* queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

      const { run, status, lines } = yield* runWorkflowEffect("implement", {});

      expect(status).toBe("done");
      expect(run.step("mr").status).toBe("done");
      expect(run.step("mr").note).toBe("skipped: no GitLab remote");
      expect(lines).toContain("◦ mr — skipped: no GitLab remote");
      expect(run.record.mr_url).toBeNull();
    }),
  ));

test(
  "on GitLab the mr step gets the assignee, the tickets and a short CIATF brief",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* onGitLab("FRO-149-modal");
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
          {
            verdict: "clean",
            findings: [],
            mr_url: "https://gitlab.cego.dk/x/-/merge_requests/7",
            linear_issues: ["FRO-149"],
          },
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        const prompt = yield* readText(path.join(run.dir, "steps", "mr", "prompt-1.md"));
        expect(prompt).toContain("Assignee: `mk`");
        // The branch names the ticket, so the MR has something to link.
        expect(prompt).toContain("Linear tickets: `FRO-149`");
        // Short by instruction, in the words mk asked for.
        expect(prompt).toContain("One or two ordinary sentences per section");
        expect(prompt).toContain("`No impact.`");
        expect(prompt).toContain("no tables, no");
        expect(prompt).toContain("Never merge the MR");
        expect(prompt).toContain("Where the template asks for a Trello card");
        // Nothing in a prompt or a description may carry the scope with a leading at-sign.
        // Built rather than written, so the literal is absent from the repo too.
        expect(prompt).not.toContain(`@${"cego"}`);

        // What it reported reaches the run record and the summary.
        expect(run.record.mr_url).toBe("https://gitlab.cego.dk/x/-/merge_requests/7");
        // The engine, not the agent, puts mk on the merge request it opened.
        expect(yield* readText(path.join(rig.root, "bin", "updates.txt"))).toBe(
          "7 --repo gitlab.cego.dk/x --assignee +mk\n",
        );
        expect(run.record.linear_issues).toEqual(["FRO-149"]);
        expect(run.record.summary).toContain(
          "Merge request: https://gitlab.cego.dk/x/-/merge_requests/7 (FRO-149)",
        );
      }),
    ),
  20_000,
);

test(
  "with a template in the repo the prompt points at it instead of the plain fallback",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* onGitLab("add-a-picker");
        yield* makeDirectory(path.join(rig.projectDir, ".gitlab", "merge_request_templates"));
        yield* writeText(
          path.join(rig.projectDir, ".gitlab", "merge_request_templates", "default.md"),
          "## Description\n",
        );
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
          { verdict: "clean", findings: [] },
        ]);

        const { run } = yield* runWorkflowEffect("implement", {});

        const prompt = yield* readText(path.join(run.dir, "steps", "mr", "prompt-1.md"));
        expect(prompt).toContain("MR template: `.gitlab/merge_request_templates/default.md`");
        // No ticket anywhere this time, so the prompt says so rather than inventing one.
        expect(prompt).toContain("Linear tickets: ``");
      }),
    ),
  20_000,
);

test(
  "build, architecture, simplify and fix are one unlabelled pane in one tab",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);

        const { run } = yield* runWorkflowEffect("implement", {});

        // One pane, in the implementer's own tab, for every step that reuses the agent.
        const panes = ["build", "architecture", "simplify", "fix"].map(
          (id) => run.step(id).variants[0]!.paneId,
        );
        expect(new Set(panes).size).toBe(1);

        // It is never labelled: it is alone in its tab, and the tab names the run.
        // Nothing else opens for it either.
        const onThatPane = (yield* rig.calls())
          .filter((c) => c.cmd === "pane rename" && c.argv![2] === panes[0])
          .map((c) => c.argv!.at(-1));
        expect(onThatPane).toEqual([]);
        // Every tab of the run follows the run: the implementer's tab says which step
        // the run is on, whichever tab that step is working in, and says `2/4` once the
        // loop has been round. It ends at what the run is, with no step left running.
        const itsTab = run.step("build").variants[0]!.tabId;
        const tabNames = (yield* rig.calls())
          .filter((c) => c.cmd === "tab rename" && c.argv![2] === itsTab)
          .map((c) => c.argv!.at(-1));
        expect(tabNames).toContain("⚙ Implement · add-picker · fix");
        expect(tabNames).toContain("⚙ Implement · add-picker · review 2/4");
        expect(tabNames.at(-1)).toBe("✓ Implement · add-picker");
        // Never twice in a row: the poll that renames it runs every couple of seconds.
        expect(tabNames.filter((name, at) => name === tabNames[at - 1])).toEqual([]);

        // Two tabs for the whole run: the implementer's and the reviewers'.
        expect((yield* rig.cmds()).filter((c) => c === "tab create")).toHaveLength(2);

        // The run has no pane of its own to move, swap or name `status`.
        for (const cmd of ["pane move", "pane swap"]) expect(yield* rig.cmds()).not.toContain(cmd);
        expect(
          (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
        ).not.toContain("status");
      }),
    ),
  20_000,
);

// --- the converging loop: a ceiling of four reviews and four fixes, exit at the first acceptable review ---

test("implement converges: four iterations at most, and the fix loop says so", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadTestDefinitions();
      const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);
      expect(wf.maxIterations).toBe(4);
      expect(wf.steps[5]!.repeat).toEqual({
        from: "review.synthesize",
        back_to: "simplify",
        converge: true,
      });
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
    }),
  ));

test(
  "a clean first review goes straight to the merge request: one review round, no fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(1);
        expect(run.step("fix").note).toBe("skipped: reviews clean");
        expect(lines).toContain("  reviews clean — skipping fix");
        const order = promptOrder(yield* rig.calls(), run.dir);
        expect(order.filter((p) => p.startsWith("steps/review"))).toHaveLength(3);
        expect(order.some((p) => p.startsWith("steps/fix"))).toBe(false);
        expect(run.record.unreviewed).toBeNull();
        expect(outcomeLine(run.record, "done")).toBe("clean");
      }),
    ),
  20_000,
);

test(
  "a minor-only review does not cost another round, and is not called clean",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          OTHER_FINDING,
          CLEAN,
          synthesized(OTHER_FINDING),
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(1);
        expect(run.step("fix").note).toBe("skipped: 1 non-blocking finding(s) remain");
        expect(lines).toContain(
          "  nothing blocking — 1 non-blocking finding(s) remain, skipping fix",
        );
        expect(lines).not.toContain("  reviews clean — skipping fix");
        expect(run.record.outstanding.map((f) => f.title)).toEqual(["loose equality"]);
        expect(run.record.summary).toContain("Findings still open:");
        expect(run.record.summary).toContain("- [minor] loose equality (cli.js:2)");
        expect(outcomeLine(run.record, "done")).not.toStartWith("clean");
        expect(outcomeLine(run.record, "done")).toContain("1 minor");
      }),
    ),
  20_000,
);

test(
  "a severity the vocabulary does not know blocks, it is not minor by default",
  () =>
    runEffect(
      Effect.gen(function* () {
        const odd = { file: "cli.js", severity: "nit", title: "odd severity" };
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(odd),
          fixed("odd severity"),
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(2);
        expect(lines).toContain("  1 finding(s) to fix, 1 blocking");
      }),
    ),
  20_000,
);

test(
  "a fixed blocker is checked by a focused second review, and a clean one exits early",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          FIX_OK,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(2);
        expect(run.step("fix").note).toBe("skipped: reviews clean");
        expect(run.record.unreviewed).toBeNull();
        expect(run.record.outstanding).toEqual([]);
        // The first review is the comprehensive one; the second is told where the
        // previous round's review and the fix's account of it are.
        const first = yield* readText(
          path.join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"),
        );
        const second = yield* readText(
          path.join(run.dir, "steps", "review", "claude-opus", "prompt-2.md"),
        );
        expect(first).toContain("Iteration 1 of at most 4");
        expect(second).toContain("Iteration 2 of at most 4");
        expect(second).toContain(`${run.dir}/review.md`);
        expect(second).toContain("steps/fix/fix.json");
        const fix = yield* readText(path.join(run.dir, "steps", "fix", "prompt-1.md"));
        expect(fix).toContain("Iteration 1 of at most 4");
        expect(fix).toContain("ceiling");
      }),
    ),
  20_000,
);

test(
  "blockers that keep changing get four reviews and four fixes, never a fifth",
  () =>
    runEffect(
      Effect.gen(function* () {
        const b = (n: number) => ({ file: "cli.js", severity: "blocker", title: `problem ${n}` });
        // simplify, two reviewers, the synthesis, the fix.
        const round = (n: number) => [
          CLEAN,
          CLEAN,
          blocking(b(n)),
          blocking(b(n)),
          fixed(`problem ${n}`),
        ];
        yield* queueOutputs([CLEAN, CLEAN, ...round(1), ...round(2), ...round(3), ...round(4)]);

        const { run, status, lines } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(4);
        const order = promptOrder(yield* rig.calls(), run.dir);
        expect(order.filter((p) => p.startsWith("steps/review/"))).toHaveLength(8);
        expect(order.filter((p) => p.startsWith("steps/review.synthesize"))).toHaveLength(4);
        expect(order.filter((p) => p.startsWith("steps/fix"))).toHaveLength(4);
        // The fourth fix is judged on its own account, not on the fourth review's findings.
        expect(run.record.outstanding).toEqual([]);
        expect(run.record.halt).toBeNull();
        expect(run.record.unreviewed).toContain("not re-reviewed");
        expect(run.step("fix").note).toContain("not re-reviewed");
        expect(lines).toContain(
          "  last fix: 1 blocking finding(s) reported fixed, 1 check(s) passed — implementer-reported, not re-reviewed",
        );
        expect(run.record.summary).toContain("not re-reviewed");
        expect(outcomeLine(run.record, "done")).toContain("not re-reviewed");
      }),
    ),
  20_000,
);

test(
  "the last fix that accounts for every blocker reaches the merge request, which says it was not re-reviewed",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* onGitLab("add-a-picker");
        yield* bundledImplement(withMax(1));
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          OTHER_FINDING,
          synthesized(FINDING, OTHER_FINDING),
          FIX_OK,
          { verdict: "clean", findings: [], mr_url: "https://gitlab.cego.dk/x/-/merge_requests/9" },
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("done");
        expect(run.record.iteration).toBe(1);
        // The minor it left alone is still open; the blocker it fixed is not.
        expect(run.record.outstanding.map((f) => f.title)).toEqual(["loose equality"]);
        const prompt = yield* readText(path.join(run.dir, "steps", "mr", "prompt-1.md"));
        expect(prompt).toContain("implementer-reported, not re-reviewed");
        expect(prompt).toContain("say so in the description");
        expect(outcomeLine(run.record, "done")).toContain("merge_requests/9");
      }),
    ),
  20_000,
);

test(
  "a last fix with a missing disposition, a legacy shape or a failed check blocks, and the old review is not what it reports",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(withMax(1));
        const cases: [Schema.Json, string][] = [
          [
            { ...fixed(), fixed: [{ file: "cli.js", title: "missing exit code", note: "?" }] },
            "no disposition for [blocker] no exit code (cli.js)",
          ],
          // A bare CLEAN parses and says nothing, which is not enough.
          [CLEAN, "no disposition for [blocker] no exit code (cli.js); no checks reported"],
          // The shape the fix step used to write does not even parse.
          [{ ...CLEAN, fixed: ["added process.exit"] }, "fix.json: fixed[0]: expected an object"],
          [
            { ...FIX_OK, checks: [{ name: "bun test", passed: false, note: "1 fail" }] },
            "check failed: bun test (1 fail)",
          ],
        ];
        for (const [last, reason] of cases) {
          yield* plannedRun(rig, "add-picker");
          yield* queueOutputs([CLEAN, CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING), last]);

          const { run, status } = yield* runWorkflowEffect("implement", {});

          expect(status).toBe("blocked");
          expect(run.record.halt).toBe("fix_unverified");
          expect(run.step("fix").status).toBe("blocked");
          expect(run.step("fix").note).toContain(reason);
          expect(run.step("mr").status).toBe("pending");
          expect(run.record.unreviewed).toBeNull();
          expect(run.record.summary).toContain("Findings still open:");
          expect(run.record.summary).toContain("- [blocker] no exit code (cli.js:4)");
        }
      }),
    ),
  40_000,
);

test(
  "a last fix that disputes a blocker stops for the human rather than shipping the dispute",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(withMax(1));
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          { ...fixed(), disputed: [{ ...NO_EXIT, detail: "out of scope" }] },
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("blocked");
        expect(run.record.halt).toBe("dispute_unresolved");
        expect(run.step("fix").note).toBe(
          "fix 1 disputed every blocking finding (1) — your call, not the loop's",
        );
        expect(run.record.outstanding.map((f) => f.title)).toEqual(["no exit code"]);

        // Mixed: one blocker fixed, the other disputed, checks green — still the human's.
        yield* plannedRun(rig, "add-picker");
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          blocking(MAJOR),
          blocking(NO_EXIT, MAJOR),
          {
            ...fixed("unhandled rejection"),
            disputed: [{ ...NO_EXIT, severity: "minor", detail: "out of scope" }],
          },
        ]);
        const mixed = yield* runWorkflowEffect("implement", {});
        expect(mixed.status).toBe("blocked");
        expect(mixed.run.record.halt).toBe("dispute_unresolved");
        expect(mixed.run.step("fix").note).toBe(
          "last fix not enough: disputed blocking finding: [blocker] no exit code (cli.js)",
        );
        // Nothing the fix said is verified once it does not hold up, so all of it is open.
        expect(mixed.run.record.outstanding.map((f) => f.title)).toEqual([
          "no exit code",
          "unhandled rejection",
        ]);
        // The dispute carries the reviewers' severity, not the implementer's.
        expect(mixed.run.record.disputed.map((f) => f.severity)).toEqual(["blocker"]);
      }),
    ),
  40_000,
);

test(
  "a later review that leaves a disputed blocker out does not waive it",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          {
            ...fixed("unhandled rejection"),
            disputed: [{ ...NO_EXIT, severity: "minor", detail: "out of scope" }],
          },
          CLEAN, // simplify
          CLEAN, // the reviewers were told not to raise the dispute again, and did not
          CLEAN,
          SYNTH,
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("blocked");
        expect(run.record.iteration).toBe(2);
        expect(run.record.halt).toBe("dispute_unresolved");
        expect(run.step("fix").note).toBe(
          "1 disputed blocking finding(s) stand unanswered — your call, not the loop's",
        );
        expect(run.record.outstanding.map((f) => f.title)).toEqual(["no exit code"]);
        expect(run.step("mr").status).toBe("pending");
      }),
    ),
  20_000,
);

test(
  "a fix that disputes every blocking finding stops at once, and a standing dispute of one blocks the gate",
  () =>
    runEffect(
      Effect.gen(function* () {
        // Every blocker disputed, nothing fixed: no review round is spent on it.
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          { ...fixed(), disputed: [{ ...NO_EXIT, detail: "out of scope" }] },
        ]);
        const all = yield* runWorkflowEffect("implement", {});
        expect(all.status).toBe("blocked");
        expect(all.run.record.iteration).toBe(1);
        expect(all.run.record.halt).toBe("dispute_unresolved");
        expect(all.run.step("fix").note).toBe(
          "fix 1 disputed every blocking finding (1) — your call, not the loop's",
        );
        expect(promptOrder(yield* rig.calls(), all.run.dir).at(-1)).toBe("steps/fix/prompt-1.md");

        // One fixed, one disputed: the loop goes on, and when the next review raises
        // the disputed one again without an answer, the human decides — not the MR.
        yield* plannedRun(rig, "add-picker");
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          blocking(MAJOR),
          blocking(NO_EXIT, MAJOR),
          { ...fixed("unhandled rejection"), disputed: [{ ...NO_EXIT, detail: "no" }] },
          CLEAN,
          FINDING,
          CLEAN,
          synthesized(FINDING),
        ]);
        const partial = yield* runWorkflowEffect("implement", {});
        expect(partial.status).toBe("blocked");
        expect(partial.run.record.iteration).toBe(2);
        expect(partial.run.record.halt).toBe("dispute_unresolved");
        expect(partial.run.step("fix").status).toBe("blocked");
        expect(partial.run.step("fix").note).toBe(
          "1 disputed blocking finding(s) stand unanswered — your call, not the loop's",
        );
        expect(partial.run.record.outstanding.map((f) => f.title)).toEqual(["no exit code"]);
        expect(partial.run.record.summary).toContain("Disputed findings");
      }),
    ),
  40_000,
);

test(
  "the same blocking set twice is no progress and stops before the cap; a shrinking one goes on",
  () =>
    runEffect(
      Effect.gen(function* () {
        // The fix claims it fixed the blocker; the next review raises it again, at
        // another line and in other words for the detail — the same finding.
        const moved = {
          verdict: "findings",
          findings: [{ ...NO_EXIT, line: 11, detail: "still no exit code" }],
        };
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          FIX_OK,
          CLEAN,
          moved,
          moved,
          synthesized(moved),
        ]);
        const stuck = yield* runWorkflowEffect("implement", {});
        expect(stuck.status).toBe("blocked");
        expect(stuck.run.record.iteration).toBe(2);
        expect(stuck.run.record.halt).toBe("no_progress");
        expect(stuck.run.step("fix").status).toBe("blocked");
        expect(stuck.run.step("fix").note).toBe(
          "no progress: review 2 raised the same 1 blocking finding(s) as review 1",
        );
        expect(stuck.run.record.outstanding.map((f) => f.line)).toEqual([11]);
        expect(stuck.run.record.summary).toContain("Findings still open:");
        expect(stuck.lines).toContain(
          "  no progress: review 2 raised the same 1 blocking finding(s) as review 1",
        );

        // Two blockers, then one of them: the set shrank, so the loop continues.
        yield* plannedRun(rig, "add-picker");
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          fixed("unhandled rejection", "no exit code"),
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          FIX_OK,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);
        const shrinking = yield* runWorkflowEffect("implement", {});
        expect(shrinking.status).toBe("done");
        expect(shrinking.run.record.iteration).toBe(3);
        expect(shrinking.run.record.halt).toBeNull();
      }),
    ),
  40_000,
);

test(
  "a resumed run re-reads its review and fix evidence: nothing is run twice, and missing or legacy evidence blocks",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(withMax(1));
        yield* queueOutputs([CLEAN, CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING), FIX_OK]);
        const first = yield* runWorkflowEffect("implement", {});
        expect(first.status).toBe("done");
        const run = first.run;
        const before = (yield* rig.calls()).filter((c) => c.cmd === "agent prompt").length;

        // What `run resume` does to the record before a new Driver picks it up.
        const resume = Effect.fn("test.resume")(function* () {
          run.record.status = "running";
          run.record.finished_at = null;
          run.record.unreviewed = null;
          for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
          run.step("mr").status = "pending";
          yield* run.save();
          yield* queueOutputs([]);
          return yield* runWorkflowEffect("implement", {}, { existing: run });
        });

        // The evidence is still there: the gate and the last fix are re-judged from it,
        // no agent is prompted, and the run ends where it did.
        const replayed = yield* resume();
        expect(replayed.status).toBe("done");
        expect(replayed.run.record.unreviewed).toContain("not re-reviewed");
        expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(before);
        expect(replayed.lines).toContain("✓ fix — already done, skipped");

        // The last fix's Output replaced by a legacy bare CLEAN: not enough, and the done
        // record does not carry it past the gate.
        const fixJson = path.join(run.dir, "steps", "fix", "fix.json");
        yield* writeText(fixJson, encodeJson(CLEAN));
        const stale = yield* resume();
        expect(stale.status).toBe("blocked");
        expect(stale.run.record.halt).toBe("fix_unverified");
        expect(stale.run.step("fix").status).toBe("blocked");
        expect(stale.run.step("mr").status).toBe("pending");

        // The review's Output gone: the gate cannot be re-judged, so the run does not
        // guess its way to the merge request.
        yield* writeText(fixJson, encodeJson(FIX_OK));
        run.step("fix").status = "done";
        yield* fs.remove(path.join(run.dir, "steps", "review.synthesize", "synthesized.json"));
        const missing = yield* resume();
        expect(missing.status).toBe("blocked");
        expect(missing.run.record.halt).toBe("fix_unverified");
        expect(missing.run.step("fix").note).toBe(
          "cannot re-check review.synthesize: its Output is missing or unreadable",
        );
        expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(before);
      }),
    ),
  40_000,
);

test(
  "resuming after no progress or a dispute retries the blocked fix, and starts no review of its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        // What `run resume` does to the record before a new Driver picks it up.
        const resume = Effect.fn("test.resume")(function* (run: Run, outputs: Schema.Json[]) {
          run.record.status = "running";
          run.record.finished_at = null;
          for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
          yield* run.save();
          yield* queueOutputs(outputs);
          return yield* runWorkflowEffect("implement", {}, { existing: run });
        });
        const prompts = Effect.fn("test.prompts")(function* (dir: string, from: number) {
          return promptOrder(yield* rig.calls(), dir).slice(from);
        });

        // No progress: review 2 repeated review 1's blocker and the run stopped. A resume
        // is the human saying "try that fix again": fix 2 runs against review 2, and the
        // loop goes on from there — no third review is started to make it so.
        const moved = {
          verdict: "findings",
          findings: [{ ...NO_EXIT, line: 11 }],
        };
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized(FINDING),
          FIX_OK,
          CLEAN,
          moved,
          moved,
          synthesized(moved),
        ]);
        const stuck = yield* runWorkflowEffect("implement", {});
        expect(stuck.run.record.halt).toBe("no_progress");
        const before = (yield* rig.calls()).filter((c) => c.cmd === "agent prompt").length;
        const retried = yield* resume(stuck.run, [FIX_OK, CLEAN, CLEAN, CLEAN, SYNTH]);
        expect(retried.status).toBe("done");
        expect(retried.run.record.halt).toBeNull();
        expect(retried.run.record.iteration).toBe(3);
        expect(yield* prompts(stuck.run.dir, before)).toEqual([
          "steps/fix/prompt-2.md",
          "steps/simplify/prompt-3.md",
          "steps/review/claude-opus/prompt-3.md",
          "steps/review/claude-sonnet/prompt-3.md",
          "steps/review.synthesize/prompt-3.md",
        ]);
        expect(yield* readText(path.join(stuck.run.dir, "log.txt"))).toContain(
          "resumed after no_progress: fix 2 runs again against review 2's findings",
        );

        // A dispute: the blocker the implementer disputed goes back in front of it —
        // even though the last review, told not to, did not raise it again.
        yield* plannedRun(rig, "add-picker");
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          { ...fixed("unhandled rejection"), disputed: [{ ...NO_EXIT, detail: "no" }] },
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);
        const disputed = yield* runWorkflowEffect("implement", {});
        expect(disputed.run.record.halt).toBe("dispute_unresolved");
        const mark = (yield* rig.calls()).filter((c) => c.cmd === "agent prompt").length;
        // Disputed again: the human is asked again, and nothing is shipped.
        const again = yield* resume(disputed.run, [
          { ...fixed(), disputed: [{ ...NO_EXIT, detail: "still no" }] },
        ]);
        expect(again.status).toBe("blocked");
        expect(again.run.record.halt).toBe("dispute_unresolved");
        expect(yield* prompts(disputed.run.dir, mark)).toEqual(["steps/fix/prompt-2.md"]);
        const fix = yield* readText(path.join(disputed.run.dir, "steps", "fix", "prompt-2.md"));
        expect(fix).toContain("- [blocker] no exit code (cli.js:4)");
        expect(fix).toContain("The review found:");
        expect(again.lines).toContain("  1 finding(s) to fix, 1 blocking");
        // Fixed this time: the loop verifies it with the review it would have run anyway.
        const fixedNow = yield* resume(disputed.run, [FIX_OK, CLEAN, CLEAN, CLEAN, SYNTH]);
        expect(fixedNow.status).toBe("done");
        expect(fixedNow.run.record.disputed).toEqual([]);
        expect(fixedNow.run.record.iteration).toBe(3);
      }),
    ),
  60_000,
);

test(
  "a fix prompt herdr saw no turn come of is not sent again by a resume, to the same agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(withMax(5));
        yield* plannedRun(rig, "add-picker");
        const resume = Effect.fn("test.resume")(function* (
          run: Run,
          outputs: Schema.Json[],
          env: Record<string, string> = {},
        ) {
          run.record.status = "running";
          run.record.finished_at = null;
          for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
          yield* run.save();
          yield* queueOutputs(outputs);
          return yield* runWorkflowEffect("implement", {}, { existing: run, env });
        });

        // A dispute stops the run; the human resumes it — and this time herdr's wait for a
        // turn runs out. The fix is written and worked on (the fake still writes its
        // Output), so the run stops on the dispute again with the prompt `submitted` but
        // `unobserved`.
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          { ...fixed("unhandled rejection"), disputed: [{ ...NO_EXIT, detail: "no" }] },
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);
        const disputed = yield* runWorkflowEffect("implement", {});
        expect(disputed.run.record.halt).toBe("dispute_unresolved");
        const unseen = yield* resume(
          disputed.run,
          [{ ...fixed(), disputed: [{ ...NO_EXIT, detail: "still no" }] }],
          { FAKE_HERDR_PROMPT_ERROR: "timeout" },
        );
        expect(unseen.run.record.halt).toBe("dispute_unresolved");
        const doubted = (yield* deliveriesOf(rig.stateDir, disputed.run.id))
          .map((entry) => entry.delivery)
          .filter((delivery) => delivery.cause.ref === "fix/#2");
        // Collected, but not settled: an Output beside a prompt nobody saw taken does not
        // say the prompt was read.
        expect(doubted.map((d) => [d.state, d.note])).toEqual([["submitted", "unobserved"]]);

        // Resumed again, with the same implementer live: the same work is not sent to it
        // a second time. The step is withheld with the delivery to reconcile, and no
        // prompt goes out.
        const before = (yield* rig.calls()).filter((c) => c.cmd === "agent prompt").length;
        const again = yield* resume(disputed.run, [FIX_OK, CLEAN, CLEAN, CLEAN, SYNTH]);
        expect(again.status).toBe("blocked");
        expect(again.run.step("fix").status).toBe("blocked");
        expect(
          again.run
            .step("fix")
            .variants.map((v) => v.error)
            .join(" "),
        ).toContain(`${doubted[0]!.id} is submitted`);
        expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(before);
        expect(again.lines.join("\n")).toContain("was not given its prompt: blocked");
      }),
    ),
  60_000,
);

test(
  "a blocker disputed earlier and left out of the last review still blocks the last fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* bundledImplement(withMax(2));
        const late = { file: "cli.js", severity: "blocker", title: "late problem" };
        yield* queueOutputs([
          CLEAN,
          CLEAN,
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          CLEAN,
          blocking(NO_EXIT, MAJOR),
          { ...fixed("unhandled rejection"), disputed: [{ ...NO_EXIT, detail: "out of scope" }] },
          CLEAN, // simplify
          blocking(late), // the reviewers, told not to raise the dispute again, find something new
          CLEAN,
          blocking(late),
          fixed("late problem"), // the last fix: new blocker fixed, checks green, dispute standing
        ]);

        const { run, status } = yield* runWorkflowEffect("implement", {});

        expect(status).toBe("blocked");
        expect(run.record.iteration).toBe(2);
        expect(run.record.halt).toBe("dispute_unresolved");
        expect(run.step("fix").note).toBe(
          "last fix not enough: disputed blocking finding: [blocker] no exit code (cli.js)",
        );
        expect(run.record.outstanding.map((f) => f.title)).toEqual([
          "late problem",
          "no exit code",
        ]);
        expect(run.record.unreviewed).toBeNull();
        expect(run.step("mr").status).toBe("pending");
      }),
    ),
  20_000,
);

test("the prompts ask for complete scope, a thorough first review, a focused follow-up, and truthful fix dispositions", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadTestDefinitions();
      const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);
      const step = (id: string) => wf.steps.find((s) => s.id === id)!;
      const build = step("build").prompt;
      const fix = step("fix").prompt;
      const review = step("review").prompt;
      const synthesize = step("review.synthesize").prompt;
      const mr = step("mr").prompt;

      // Complete scope before completion; no quiet deferral.
      expect(build).toContain("complete approved scope");
      expect(build).toContain("not an optional follow-up");
      for (const text of [build, step("simplify").prompt, fix, mr]) {
        expect(text).not.toContain(`{"verdict": "clean", "findings": []`);
      }
      // Ceiling, not target.
      expect(fix).toContain("ceiling, not a target");
      // Dispositions by key, checks as run, no unapproved deferral.
      expect(fix).toContain('"fixed": [{"file"');
      expect(fix).toContain('"checks": [{"name"');
      expect(fix).toContain("exactly as the finding above gives them");
      expect(fix).toContain("not re-reviewed");
      expect(fix).toContain("Never defer");
      // First review thorough, later ones focused.
      expect(review).toContain("Iteration {{iteration}} of at most {{max_iterations}}");
      expect(review).toContain("first review");
      expect(review).toContain("do not run the full review skills again");
      expect(synthesize).toContain("same file and title");
      expect(mr).toContain("{{unreviewed}}");

      const reviewer = defs.personas.get("reviewer")!.body;
      expect(reviewer).toContain("follow-up");
      const implementer = defs.personas.get("implementer")!.body;
      expect(implementer).toContain("whole scope");
    }),
  ));
