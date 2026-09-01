import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { fakeHerdr } from "./support/fake-herdr-core";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun } from "./support/engine";
import { loadDefaults } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { RunStore, type Run } from "../src/run";
import { runEffect } from "./support/effect";

const Json = Schema.fromJsonString(Schema.Any);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeUnknownSync(Json);

Object.defineProperty(FakeHerdr.prototype, "exec", {
  value(args: string[]) {
    return fakeHerdr(args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(Bun.env))),
    );
  },
});

let rig: Rig;
let bin: FakeBin;
let planDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      planDir = yield* plannedRun(rig, "add-picker").pipe(Effect.orDie);
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

const CLEAN = { verdict: "clean", findings: [] };
/** What the synthesiser writes: a review.json plus the summary a human reads. */
const SYNTH = { ...CLEAN, summary: "A small change to the CLI. Nothing wrong with it." };

/** A run whose `build` step already finished in a previous session. */
function interruptedRun() {
  return Effect.gen(function* () {
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const wf = resolveWorkflow("implement", defs, yield* loadDefaults(env.configDir));
    const store = new RunStore(env.stateDir);
    const run = yield* store.create({
      workflow: "implement",
      cwd: env.cwd,
      inputs: { plan: planDir, target: "worktree", target_kind: "worktree" },
      inputSources: { plan: "plan run", target: "working tree" },
      stepIds: wf.steps.map((s) => s.id),
      maxIterations: wf.maxIterations,
      primaryInput: "add-picker",
    });
    const build = run.step("build");
    build.status = "done";
    build.iteration = 1;
    build.variants = [
      {
        harness: "claude",
        model: "sonnet",
        effort: null,
        agent: "dead-build-agent",
        label: "implement-add-picker/build",
        tabId: null,
        paneId: "9-9",
        status: "done",
        output: "steps/build/build.json",
        error: null,
      },
    ];
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      yield* run.outputPath("build", null, "build.json"),
      encodeJson(CLEAN),
    );
    run.record.status = "blocked";
    yield* run.save();
    return run;
  });
}

function resume(run: Run, queue: Schema.Json[]) {
  return Effect.gen(function* () {
    yield* rig.queueOutputs(queue);
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    const defaults = yield* loadDefaults(env.configDir);
    const wf = resolveWorkflow(run.record.workflow, defs, defaults);
    const lines: string[] = [];
    const status = yield* Effect.promise(() =>
      import("../src/engine").then(({ executeRun }) =>
        runEffect(
          executeRun({
            herdr: new FakeHerdr(env),
            defs,
            defaults,
            wf,
            run,
            env,
            out: (line) =>
              Effect.sync(() => {
                lines.push(line);
              }),
          }),
        ),
      ),
    ).pipe(Effect.orDie);
    return { status, lines };
  });
}

test(
  "resumable lists only runs that still have unfinished steps",
  () =>
    runEffect(
      Effect.gen(function* () {
        const env = rig.pluginEnv();
        const store = new RunStore(env.stateDir);
        const run = yield* interruptedRun();

        expect((yield* store.resumable()).map((r) => r.id)).toEqual([run.id]);
        expect((yield* store.resumable())[0]!.unfinished().map((s) => s.id)).toEqual([
          "architecture",
          "simplify",
          "review",
          "review.synthesize",
          "fix",
          "mr",
        ]);

        for (const step of run.record.steps) step.status = "done";
        run.record.status = "done";
        yield* run.save();
        expect(yield* store.resumable()).toEqual([]);
      }),
    ),
  20_000,
);

test(
  "resuming skips the finished step and never reattaches to its agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();

        const { status, lines } = yield* resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        expect(status).toBe("done");
        expect(lines[0]).toBe("✓ build — already done, skipped");
        expect(run.step("build").variants[0]!.agent).toBe("dead-build-agent");

        const prompted = (yield* rig.calls())
          .filter((c) => c.cmd === "agent prompt")
          .map((c) => c.argv![2]);
        expect(prompted).not.toContain("dead-build-agent");
        expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(5);

        // No herdr call may touch the dead pane either.
        expect((yield* rig.calls()).flatMap((c) => c.argv ?? [])).not.toContain("9-9");
      }),
    ),
  20_000,
);

test(
  "the steps that borrowed the dead agent share one new agent instead",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();
        const FINDING = {
          verdict: "findings",
          findings: [{ file: "cli.js", severity: "major", title: "no exit code" }],
        };

        // architecture, simplify and fix all declare `agent: build`, which is gone.
        const synthesized = { ...FINDING, summary: "A small change to the CLI. It exits wrong." };
        yield* resume(run, [
          CLEAN,
          CLEAN,
          FINDING,
          FINDING,
          synthesized,
          CLEAN,
          CLEAN,
          CLEAN,
          CLEAN,
          SYNTH,
        ]);

        const architect = run.step("architecture").variants[0]!;
        expect(architect.agent).toBe("implement-add-pi-architecture-r2");
        expect(architect.paneId).not.toBe("9-9");
        for (const step of ["simplify", "fix"]) {
          expect(run.step(step).variants[0]!.agent).toBe(architect.agent);
        }
        const starts = (yield* rig.calls())
          .filter((c) => c.cmd === "agent start")
          .map((c) => c.argv![2]);
        expect(starts.filter((a) => a === architect.agent)).toHaveLength(1);
        expect(starts).not.toContain("dead-build-agent");
      }),
    ),
  20_000,
);

test(
  "a resumed run opens its own tab and no pane of the run's own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();

        yield* resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        // A resumed run is driven headlessly like any other: it opens a tab for the first
        // unfinished step's agent, and nothing for itself.
        expect((yield* rig.cmds()).filter((c) => c === "tab create").length).toBeGreaterThan(0);
        for (const cmd of ["pane move", "pane swap", "pane zoom"])
          expect(yield* rig.cmds()).not.toContain(cmd);
        expect(run.step("architecture").variants[0]!.paneId).not.toBeNull();
      }),
    ),
  20_000,
);

test(
  "a resumed run toasts when it finishes and records the new status",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const run = yield* interruptedRun();

        yield* resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        const record = decodeJson(yield* fs.readFileString(path.join(run.dir, "run.json")));
        expect(record.status).toBe("done");
        expect(record.finished_at).not.toBeNull();
        expect(record.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
        const toast = (yield* rig.calls())
          .filter((c) => c.cmd === "notification show")
          .at(-1)!.argv!;
        expect(toast[2]).toBe("implement-add-picker finished");
      }),
    ),
  20_000,
);

test(
  "a step that failed and then succeeds does not keep the failure note",
  () =>
    runEffect(
      Effect.gen(function* () {
        const run = yield* interruptedRun();
        const review = run.step("review");
        review.status = "failed";
        review.note = "herdr agent start failed (exit 1): blocked during startup";
        yield* run.save();

        yield* resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

        expect(run.step("review").status).toBe("done");
        expect(run.step("review").note).toBeNull();
        expect(run.record.summary).not.toContain("blocked during startup");
      }),
    ),
  20_000,
);
