import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun } from "./support/engine";
import { loadDefaults } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { executeRun } from "../src/engine";
import { Herdr } from "../src/herdr";
import { RunStore, type Run } from "../src/run";

let rig: Rig;
let bin: FakeBin;
let planDir: string;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  bin = new FakeBin(join(rig.root, "bin"));
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  planDir = plannedRun(rig, "add-picker");
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const CLEAN = { verdict: "clean", findings: [] };
/** What the synthesiser writes: a review.json plus the summary a human reads. */
const SYNTH = { ...CLEAN, summary: "A small change to the CLI. Nothing wrong with it." };

/** A run whose `build` step already finished in a previous session. */
function interruptedRun(): Run {
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  const wf = resolveWorkflow("implement", defs, loadDefaults(env.configDir));
  const store = new RunStore(env.stateDir);
  const run = store.create({
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
  writeFileSync(run.outputPath("build", null, "build.json"), JSON.stringify(CLEAN));
  run.record.status = "blocked";
  run.save();
  return run;
}

async function resume(run: Run, queue: unknown[]) {
  rig.queueOutputs(queue);
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  const defaults = loadDefaults(env.configDir);
  const wf = resolveWorkflow(run.record.workflow, defs, defaults);
  const lines: string[] = [];
  const status = await executeRun({
    herdr: new Herdr(env),
    defs,
    defaults,
    wf,
    run,
    env,
    out: (line) => lines.push(line),
  });
  return { status, lines };
}

test("resumable lists only runs that still have unfinished steps", () => {
  const env = rig.pluginEnv();
  const store = new RunStore(env.stateDir);
  const run = interruptedRun();

  expect(store.resumable().map((r) => r.id)).toEqual([run.id]);
  expect(store.resumable()[0]!.unfinished().map((s) => s.id)).toEqual([
    "architecture",
    "simplify",
    "review",
    "review.synthesize",
    "fix",
    "mr",
  ]);

  for (const step of run.record.steps) step.status = "done";
  run.record.status = "done";
  run.save();
  expect(store.resumable()).toEqual([]);
}, 20_000);

test("resuming skips the finished step and never reattaches to its agent", async () => {
  const run = interruptedRun();

  const { status, lines } = await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  expect(status).toBe("done");
  expect(lines[0]).toBe("✓ build — already done, skipped");
  expect(run.step("build").variants[0]!.agent).toBe("dead-build-agent");

  const prompted = rig
    .calls()
    .filter((c) => c.cmd === "agent prompt")
    .map((c) => c.argv![2]);
  expect(prompted).not.toContain("dead-build-agent");
  expect(rig.calls().filter((c) => c.cmd === "agent prompt")).toHaveLength(5);

  // No herdr call may touch the dead pane either.
  expect(rig.calls().flatMap((c) => c.argv ?? [])).not.toContain("9-9");
}, 20_000);

test("the steps that borrowed the dead agent share one new agent instead", async () => {
  const run = interruptedRun();
  const FINDING = {
    verdict: "findings",
    findings: [{ file: "cli.js", severity: "major", title: "no exit code" }],
  };

  // architecture, simplify and fix all declare `agent: build`, which is gone.
  const synthesized = { ...FINDING, summary: "A small change to the CLI. It exits wrong." };
  await resume(run, [CLEAN, CLEAN, FINDING, FINDING, synthesized, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  const architect = run.step("architecture").variants[0]!;
  expect(architect.agent).toBe("implement-add-pi-architecture-r2");
  expect(architect.paneId).not.toBe("9-9");
  for (const step of ["simplify", "fix"]) {
    expect(run.step(step).variants[0]!.agent).toBe(architect.agent);
  }
  const starts = rig.calls().filter((c) => c.cmd === "agent start").map((c) => c.argv![2]);
  expect(starts.filter((a) => a === architect.agent)).toHaveLength(1);
  expect(starts).not.toContain("dead-build-agent");
}, 20_000);

test("a resumed run opens its own tab and no pane of the run's own", async () => {
  const run = interruptedRun();

  await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  // A resumed run is driven headlessly like any other: it opens a tab for the first
  // unfinished step's agent, and nothing for itself.
  expect(rig.cmds().filter((c) => c === "tab create").length).toBeGreaterThan(0);
  for (const cmd of ["pane move", "pane swap", "pane zoom"]) expect(rig.cmds()).not.toContain(cmd);
  expect(run.step("architecture").variants[0]!.paneId).not.toBeNull();
}, 20_000);

test("a resumed run toasts when it finishes and records the new status", async () => {
  const run = interruptedRun();

  await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  const record = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8"));
  expect(record.status).toBe("done");
  expect(record.finished_at).not.toBeNull();
  expect(record.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
  const toast = rig.calls().filter((c) => c.cmd === "notification show").at(-1)!.argv!;
  expect(toast[2]).toBe("implement-add-picker finished");
}, 20_000);

test("a step that failed and then succeeds does not keep the failure note", async () => {
  const run = interruptedRun();
  const review = run.step("review");
  review.status = "failed";
  review.note = "herdr agent start failed (exit 1): blocked during startup";
  run.save();

  await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  expect(run.step("review").status).toBe("done");
  expect(run.step("review").note).toBeNull();
  expect(run.record.summary).not.toContain("blocked during startup");
}, 20_000);
