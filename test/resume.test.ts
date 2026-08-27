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

/** A run whose `build` step already finished in a previous session. */
function interruptedRun(): Run {
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  const wf = resolveWorkflow("implement", defs, loadDefaults(env.configDir));
  const store = new RunStore(env.stateDir);
  const run = store.create({
    workflow: "implement",
    cwd: env.cwd,
    inputs: { plan: planDir, target: "worktree", post: "false" },
    inputSources: { plan: "plan run", target: "working tree", post: "default" },
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
    hostPaneId: "1-0",
    out: (line) => lines.push(line),
  });
  return { status, lines };
}

test("resumable lists only runs that still have unfinished steps", () => {
  const env = rig.pluginEnv();
  const store = new RunStore(env.stateDir);
  const run = interruptedRun();

  expect(store.resumable().map((r) => r.id)).toEqual([run.id]);
  expect(store.resumable()[0]!.unfinished().map((s) => s.id)).toEqual(["review", "fix", "commit", "verify"]);

  for (const step of run.record.steps) step.status = "done";
  run.record.status = "done";
  run.save();
  expect(store.resumable()).toEqual([]);
});

test("resuming skips the finished step and never reattaches to its agent", async () => {
  const run = interruptedRun();

  const { status, lines } = await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN]);

  expect(status).toBe("done");
  expect(lines[0]).toBe("✓ build — already done, skipped");
  expect(run.step("build").variants[0]!.agent).toBe("dead-build-agent");

  const prompted = rig
    .calls()
    .filter((c) => c.cmd === "agent prompt")
    .map((c) => c.argv![2]);
  expect(prompted).not.toContain("dead-build-agent");
  expect(rig.calls().filter((c) => c.cmd === "agent prompt")).toHaveLength(4);

  // No herdr call may touch the dead pane either.
  expect(rig.calls().flatMap((c) => c.argv ?? [])).not.toContain("9-9");
});

test("a step that borrowed a skipped step's agent starts its own instead", async () => {
  const run = interruptedRun();
  const FINDING = {
    verdict: "findings",
    findings: [{ file: "cli.js", severity: "major", title: "no exit code" }],
  };

  // Findings make the fix step run; it declares `agent: build`, which is gone.
  await resume(run, [FINDING, FINDING, CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const fix = run.step("fix").variants[0]!;
  expect(fix.agent).not.toBe("dead-build-agent");
  expect(fix.agent).toBe("implement-add-picker-fix-r2");
  expect(fix.paneId).not.toBe("9-9");
  const starts = rig.calls().filter((c) => c.cmd === "agent start").map((c) => c.argv![2]);
  expect(starts).toContain(fix.agent);
});

test("the first unfinished step takes the status pane's tab", async () => {
  const run = interruptedRun();

  await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN]);

  const split = rig.calls().find((c) => c.cmd === "pane split")!.argv!;
  expect(split.slice(0, 3)).toEqual(["pane", "split", "1-0"]);
  expect(run.step("review").variants[0]!.paneId).toBe("1-1");
});

test("a resumed run toasts when it finishes and records the new status", async () => {
  const run = interruptedRun();

  await resume(run, [CLEAN, CLEAN, CLEAN, CLEAN]);

  const record = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8"));
  expect(record.status).toBe("done");
  expect(record.finished_at).not.toBeNull();
  expect(record.steps.every((s: { status: string }) => s.status === "done")).toBe(true);
  const toast = rig.calls().filter((c) => c.cmd === "notification show").at(-1)!.argv!;
  expect(toast[2]).toBe("implement-add-picker finished");
});
