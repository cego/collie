import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import { testDefaults } from "./support/compaction";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { readSnapshot, stepDifference, stepsDiffer, writeSnapshot } from "../src/snapshot";
import { resumeRun } from "../src/operations";
import { RunStore } from "../src/run";
import { runEffect } from "./support/effect";

let rig: Rig;
let bin: FakeBin;

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

const resolved = (name: string) =>
  Effect.gen(function* () {
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    return resolveWorkflow(name, defs, yield* testDefaults(env.configDir));
  });

test("step ids compare by position, and the difference says which way", () => {
  expect(stepsDiffer(["a", "b"], ["a", "b"])).toBe(false);
  expect(stepsDiffer(["a", "b"], ["a"])).toBe(true);
  expect(stepsDiffer(["a", "b"], ["b", "a"])).toBe(true);
  expect(stepDifference(["a", "b"], ["a"])).toContain("no longer has b");
  expect(stepDifference(["a"], ["a", "c"])).toContain("now has c");
  expect(stepDifference(["a", "b"], ["b", "a"])).toContain("different order");
});

test("a snapshot round-trips the resolved workflow, prompts and all", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wf = yield* resolved("implement");
      const dir = path.join(rig.root, "run-a");
      yield* fs.makeDirectory(dir, { recursive: true });

      const definition = yield* writeSnapshot(dir, wf);
      expect(definition.snapshot).toBe("workflow/implement.json");
      expect(definition.layer).toBe("baseline");
      expect(yield* fs.exists(path.join(dir, definition.snapshot))).toBe(true);

      const back = yield* readSnapshot(dir, definition);
      expect(back).not.toBeNull();
      expect(back!.steps.map((s) => s.id)).toEqual(wf.steps.map((s) => s.id));
      // The prompt text, not just the shape: that is what the agent is actually sent,
      // and a snapshot that lost it would send a resumed Run somewhere else.
      expect(back!.steps.map((s) => s.prompt)).toEqual(wf.steps.map((s) => s.prompt));
      expect(back!.maxIterations).toBe(wf.maxIterations);
    }),
  ));

test("a snapshot keeps what a step waits for, or a frozen Run would skip its Helle gate", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const wf = yield* resolved("renovate");
      const dir = path.join(rig.root, "run-waits");
      yield* fs.makeDirectory(dir, { recursive: true });
      const back = yield* readSnapshot(dir, yield* writeSnapshot(dir, wf));
      const gated = wf.steps.filter((s) => s.waits?.includes("helle")).map((s) => s.id);
      expect(gated.length).toBeGreaterThan(0);
      expect(back!.steps.filter((s) => s.waits?.includes("helle")).map((s) => s.id)).toEqual(gated);
    }),
  ));

test("no definition recorded reads as no snapshot, not as an error", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(yield* readSnapshot(path.join(rig.root, "nowhere"), null)).toBeNull();
    }),
  ));

test("a snapshot whose file is gone refuses rather than falling back to the layers", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(rig.root, "run-b");
      yield* fs.makeDirectory(dir, { recursive: true });
      const definition = yield* writeSnapshot(dir, yield* resolved("review"));
      yield* fs.remove(path.join(dir, definition.snapshot));
      const result = yield* readSnapshot(dir, definition).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  ));

test("a Run records the definition it was started with, and the snapshot outlives an edit", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([]);
      // `review` with no scripted Output blocks at its first step; the Run is created
      // either way, and creation is what this is about.
      const { run } = yield* runWorkflow(rig, "review", { target: "worktree" });

      expect(run.record.definition).not.toBeNull();
      expect(run.record.definition!.layer).toBe("baseline");
      expect(run.record.definition!.snapshot).toBe("workflow/review.json");
      expect(yield* fs.exists(path.join(run.dir, "workflow", "review.json"))).toBe(true);

      const frozen = yield* readSnapshot(run.dir, run.record.definition);
      const before = frozen!.steps.map((s) => s.id);

      // The layer moves under it, exactly as a human editing a workflow would.
      yield* writeDef(
        path.join(rig.projectDir, ".herdr"),
        "workflows",
        "review",
        "---\nname: review\ntitle: gone\ninputs:\n  target: diff-target\nsteps:\n  - id: nothing\n    output: x.json\n---\n\n## nothing\n\nDo nothing.\n",
      );
      expect((yield* resolved("review")).steps.map((s) => s.id)).toEqual(["nothing"]);
      // The Run still runs what it started with.
      const after = yield* readSnapshot(run.dir, run.record.definition);
      expect(after!.steps.map((s) => s.id)).toEqual(before);
    }),
  ));

test("a user-layer override is recorded as such, and hashes differently from the baseline", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const dir = path.join(rig.root, "run-c");
      yield* fs.makeDirectory(dir, { recursive: true });
      const baseline = yield* writeSnapshot(dir, yield* resolved("review"));

      const text = yield* fs.readFileString(path.join(rig.baselineDir, "workflows", "review.md"));
      yield* writeDef(
        rig.configDir,
        "workflows",
        "review",
        text.replace("title: review", "title: review — the user's own"),
      );
      const mine = yield* resolved("review");
      expect(mine.layer).toBe("user");

      const other = path.join(rig.root, "run-d");
      yield* fs.makeDirectory(other, { recursive: true });
      const overridden = yield* writeSnapshot(other, mine);
      expect(overridden.layer).toBe("user");
      expect(overridden.hash).not.toBe(baseline.hash);
    }),
  ));

test("a legacy Run whose workflow lost a step is refused a resume, and nothing is written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = rig.pluginEnv();
      const wf = yield* resolved("review");
      // No `definition`: the shape of every Run recorded before snapshots existed.
      const run = yield* new RunStore(env.stateDir).create({
        workflow: "review",
        cwd: env.cwd,
        inputs: { target: "worktree", target_kind: "worktree" },
        inputSources: { target: "working tree" },
        stepIds: wf.steps.map((s) => s.id),
        maxIterations: wf.maxIterations,
        namedAfter: "worktree",
      });
      run.record.status = "blocked";
      yield* run.save();
      expect(run.record.definition).toBeNull();

      const file = path.join(run.dir, "run.json");
      const before = yield* fs.readFileString(file);

      yield* writeDef(
        path.join(rig.projectDir, ".herdr"),
        "workflows",
        "review",
        "---\nname: review\ntitle: changed\ninputs:\n  target: diff-target\nsteps:\n  - id: elsewhere\n    output: x.json\n---\n\n## elsewhere\n\nDo something else.\n",
      );

      const loaded = yield* new RunStore(env.stateDir).load(run.id);
      const result = yield* resumeRun(env, loaded, "req-1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("definition_changed");
        expect(result.error.message).toContain("elsewhere");
        expect(result.error.message).toContain("Nothing was changed");
      }
      expect(yield* fs.readFileString(file)).toBe(before);
    }),
  ));

test("a legacy Run whose workflow still matches resumes as it always did", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const wf = yield* resolved("review");
      const run = yield* new RunStore(env.stateDir).create({
        workflow: "review",
        cwd: env.cwd,
        inputs: { target: "worktree", target_kind: "worktree" },
        inputSources: { target: "working tree" },
        stepIds: wf.steps.map((s) => s.id),
        maxIterations: wf.maxIterations,
        namedAfter: "worktree",
      });
      run.record.status = "blocked";
      yield* run.save();

      const loaded = yield* new RunStore(env.stateDir).load(run.id);
      const result = yield* resumeRun(env, loaded, "req-2");
      // It gets past the definition guard; whether a Driver could be placed in this rig
      // is another question, and not this one.
      if (!result.ok) expect(result.error.code).not.toBe("definition_changed");
    }),
  ));
