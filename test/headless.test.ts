import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { installBaseline, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import {
  answerChoice,
  appendProgress,
  CHOICE,
  CHOICE_ANSWER,
  clearPid,
  driverAlive,
  filePrompts,
  lastProgress,
  readChoice,
  readProgress,
  RUNNER_LOG,
  RUNNER_PID,
  stopDriver,
  writeChoice,
  writePid,
} from "../src/driver";
import { answerKey, openLog, spawnDriver } from "../src/flows";
import { Herdr } from "../src/herdr";
import type { Asking } from "../src/workspace";
import { askingRun, buildView, renderWorkspace } from "../src/workspace";
import { scopeFor } from "../src/registry";
import { RunStore } from "../src/run";

let rig: Rig;

const SOLO = `---
name: solo
title: solo — one step
inputs:
  goal: goal
steps:
  - id: solo
    persona: planner
    output: solo.json
---
Do the thing for {{inputs.goal}}.
`;

const CHOOSE = `---
name: choose
title: choose — one menu
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Stop here
        stop: true
      - title: Carry on
        stop: true
---
Goal: {{inputs.goal}}
`;

const CLEAN = { verdict: "clean", findings: [] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  writeDef(rig.baselineDir, "workflows", "solo", SOLO);
  writeDef(rig.baselineDir, "workflows", "choose", CHOOSE);
});

afterEach(async () => {
  await rig.close();
});

function board(now?: number) {
  const env = rig.pluginEnv();
  return buildView({
    ...scopeFor(env, env.cwd),
    workspaceLabel: "test",
    stateDir: env.stateDir,
    alive: [],
    now,
  });
}

test("a review is one run tab of agent panes, and the plugin keeps one pane", async () => {
  rig.queueOutputs([CLEAN, CLEAN, { ...CLEAN, summary: "nothing to fix", dropped: [] }]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  // One tab for the run — the reviewers' — plus the Control Plane's, and no pane of
  // the run's own anywhere: no runner pane to move, swap or name.
  expect(rig.cmds().filter((c) => c === "tab create")).toHaveLength(1);
  for (const cmd of ["pane move", "pane swap"]) expect(rig.cmds()).not.toContain(cmd);
  expect(rig.calls().filter((c) => c.cmd === "plugin pane")).toHaveLength(1);
  const panes = rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1));
  expect(panes).toEqual(["Control Plane", "Opus", "Sonnet", "Synthesize"]);
  expect(run.step("review").variants).toHaveLength(2);
});

test("the driver's progress is a file, and the board shows the last of it", async () => {
  const run = new RunStore(rig.stateDir).create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review"],
    maxIterations: 5,
    primaryInput: "worktree",
  });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  run.save();

  appendProgress(run.dir, "▶ review (2 in parallel) — iteration 1");
  appendProgress(run.dir, "  ✓ opus");

  // Both shapes: one line per event for the board, and a plain log for a human.
  expect(readProgress(run.dir).map((l) => l.text)).toEqual([
    "▶ review (2 in parallel) — iteration 1",
    "  ✓ opus",
  ]);
  expect(lastProgress(run.dir)).toBe("  ✓ opus");
  expect(readFileSync(join(run.dir, RUNNER_LOG), "utf8")).toContain("▶ review (2 in parallel)");

  const row = board().active[0]!;
  expect(row.detail).toBe("review · iteration 1/5 ·   ✓ opus");
});

test("a Choice asked through the run dir is answered through it", async () => {
  const answered: string[] = [];
  // Stands in for the Control Plane: sees choice.json, writes choice-answer.json.
  const answerer = (async () => {
    for (let i = 0; i < 200; i++) {
      const run = new RunStore(rig.stateDir).list()[0];
      const choice = run ? readChoice(run.dir) : null;
      if (choice) {
        answered.push(...choice.items.map((it) => it.title));
        answerChoice(run!.dir, { id: choice.id, choice: "Carry on" });
        return;
      }
      await sleep(25);
    }
  })();

  const { run, status } = await runWorkflow(
    rig,
    "choose",
    { goal: "g" },
    {
      // Exactly what the driver builds: the question goes into this run's own dir.
      promptsFor: (r) =>
        filePrompts({ dir: r.dir, run: r.id, step: () => "next", timeoutMs: 10_000, pollMs: 25 }),
    },
  );
  await answerer;

  // The question reached the file, the answer came back through it, and the run
  // recorded the choice exactly as a menu in a pane used to.
  expect(answered).toEqual(["Stop here", "Carry on"]);
  expect(status).toBe("done");
  expect(run.record.choices.map((c) => c.title)).toEqual(["Carry on"]);
  // Neither file is left behind to be answered twice.
  expect(existsSync(join(run.dir, CHOICE))).toBe(false);
  expect(existsSync(join(run.dir, CHOICE_ANSWER))).toBe(false);
});

test("a question nobody answers leaves the step unfinished, not the run wedged", async () => {
  const { run, status } = await runWorkflow(
    rig,
    "choose",
    { goal: "g" },
    {
      promptsFor: (r) =>
        filePrompts({ dir: r.dir, run: r.id, step: () => "next", timeoutMs: 150, pollMs: 25 }),
    },
  );

  expect(status).toBe("blocked");
  expect(run.step("next").status).toBe("blocked");
  expect(run.step("next").note).toBe("no choice taken");
});

test("a pending choice renders under its run, and survives the board being reopened", () => {
  const run = new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: {},
    inputSources: {},
    stepIds: ["grill", "next"],
    maxIterations: 1,
    primaryInput: "add-a-picker",
  });
  run.record.target_label = "add-a-picker";
  run.record.awaiting = "next";
  run.save();
  writeChoice(run.dir, {
    id: "c1",
    kind: "menu",
    run: run.id,
    step: "next",
    header: "plan-add-a-picker — next",
    footer: "↑↓ move · Enter choose",
    items: [
      { id: "Implement now", title: "Implement now", subtitle: "runs implement" },
      { id: "Refine", title: "Refine", subtitle: "a fresh agent" },
    ],
  });

  // Read from the file every time, so closing and reopening the pane loses nothing.
  for (const pass of [1, 2]) {
    const view = board();
    const waiting = askingRun(view);
    expect(waiting?.id, `pass ${pass}`).toBe(run.id);
    const text = renderWorkspace(view, undefined, { index: 1, typed: "" });
    expect(text).toContain("⚠ Plan · add-a-picker");
    expect(text).toContain("plan-add-a-picker — next");
    expect(text).toContain("  Implement now");
    expect(text).toContain("❯ Refine");
    // While a run is asking, the board's own keys are that question's.
    expect(text).toContain("answering Plan · add-a-picker");
    expect(text).not.toContain("p run a workflow");
  }
});

test("the board's keys answer the question, and Esc leaves the run open", () => {
  const run = new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });
  const row = {
    id: run.id,
    dir: run.dir,
    glyph: "⚠",
    title: "Plan · x",
    detail: "",
    choice: {
      id: "c1",
      kind: "menu" as const,
      run: run.id,
      step: "next",
      header: "h",
      footer: "f",
      items: [
        { id: "one", title: "One" },
        { id: "two", title: "Two" },
      ],
    },
  };
  const start: Asking = { index: 0, typed: "" };

  // Down moves, and Enter sends the highlighted option's id.
  const moved = answerKey(row, start, "\x1b[B");
  expect(moved.asking.index).toBe(1);
  answerKey(row, moved.asking, "\r");
  expect(JSON.parse(readFileSync(join(run.dir, CHOICE_ANSWER), "utf8"))).toEqual({
    id: "c1",
    choice: "two",
  });

  // Esc is an answer too: it is what leaves the run open for a resume.
  answerKey(row, start, "\x1b");
  expect(JSON.parse(readFileSync(join(run.dir, CHOICE_ANSWER), "utf8"))).toEqual({
    id: "c1",
    choice: null,
    text: null,
  });

  // A typed question collects characters and sends the text.
  const ask = { ...row, choice: { ...row.choice, kind: "ask" as const, items: [] } };
  let asking = start;
  for (const key of ["c", "e", "g", "o"]) asking = answerKey(ask, asking, key).asking;
  asking = answerKey(ask, asking, "\x7f").asking;
  expect(asking.typed).toBe("ceg");
  answerKey(ask, asking, "\r");
  expect(JSON.parse(readFileSync(join(run.dir, CHOICE_ANSWER), "utf8"))).toEqual({
    id: "c1",
    text: "ceg",
  });
});

test("a run nothing is driving is abandoned; one with a live driver is not", () => {
  const store = new RunStore(rig.stateDir);
  const run = store.create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "worktree",
  });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  run.step("review").note = "herdr agent start failed (exit 1)";
  run.save();
  const later = Date.now() + 3_600_000;

  // This test process is a live driver as far as the pid file is concerned.
  writePid(run.dir);
  expect(driverAlive(run.dir)).toBe(true);
  expect(board(later).active.map((r) => r.title)).toEqual(["Review · worktree"]);
  // And resume will not start a second one for it.
  expect(store.resumable().filter((r) => !driverAlive(r.dir))).toEqual([]);

  clearPid(run.dir);
  expect(driverAlive(run.dir)).toBe(false);
  const gone = board(later);
  expect(gone.active).toEqual([]);
  // Why it stopped is on the row, because there is no pane it could have printed in.
  expect(gone.recent[0]!.detail).toBe("abandoned · herdr agent start failed (exit 1)");

  // A pid file left behind by a driver that died is not a driver.
  writeFileSync(join(run.dir, RUNNER_PID), "999999\n");
  expect(driverAlive(run.dir)).toBe(false);
});

test("a failed run says why on its row, and its log opens in a pane of its own", async () => {
  rig.queueOutputs([]);
  const env = rig.pluginEnv({ FAKE_HERDR_FAIL: JSON.stringify({ "agent prompt": "no such agent" }) });

  const { run, status } = await runWorkflow(
    rig,
    "solo",
    { goal: "g" },
    { env: { FAKE_HERDR_FAIL: JSON.stringify({ "agent prompt": "no such agent" }) } },
  );
  expect(status).toBe("failed");
  appendProgress(run.dir, "✗ solo — herdr agent prompt failed (exit 1): no such agent");

  // The row carries the reason, because there is no pane it could have printed in.
  const row = board().recent[0]!;
  expect(row.glyph).toBe("✗");
  expect(row.detail).toContain("failed");
  expect(row.detail).toContain("no such agent");
  // And a toast said so at the time.
  const toast = rig.calls().filter((c) => c.cmd === "notification show").at(-1)!.argv!;
  expect(toast[2]).toBe(`${run.record.slug} failed`);

  // `l` puts the detail in a pane of its own, split off the board's.
  const before = rig.calls().length;
  const note = await openLog(
    { herdr: new Herdr(env), ...scopeFor(env, env.cwd), stateDir: env.stateDir, paneId: "1-1" },
    board(),
  );
  expect(note).toContain(row.title);
  const after = rig.calls().slice(before);
  expect(after.map((c) => c.cmd)).toEqual(["pane split", "pane run"]);
  expect(after[0]!.argv!.slice(2, 5)).toEqual(["1-1", "--direction", "down"]);
  expect(after[1]!.argv!.at(-1)).toBe(`less +G ${run.dir}/${RUNNER_LOG}`);
});

test("a run can be stopped, because closing a pane no longer does it", () => {
  const run = new RunStore(rig.stateDir).create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: {},
    inputSources: {},
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "worktree",
  });
  run.step("review").status = "running";
  run.save();

  // A driver that is not there cannot be stopped, and says so rather than lying.
  expect(stopDriver(run.dir)).toBe(false);

  // One that is: a real process, asked to stop, and its pid file goes with it.
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  writeFileSync(join(run.dir, RUNNER_PID), `${child.pid}\n`);
  expect(driverAlive(run.dir)).toBe(true);
  expect(stopDriver(run.dir)).toBe(true);
  expect(driverAlive(run.dir)).toBe(false);
  expect(existsSync(join(run.dir, RUNNER_PID))).toBe(false);
});

test("the driver outlives the process that started it", async () => {
  const store = new RunStore(rig.stateDir);
  const run = store.create({
    workflow: "solo",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: { goal: "Add a picker" },
    inputSources: { goal: "asked" },
    stepIds: ["solo"],
    maxIterations: 5,
    primaryInput: "Add a picker",
  });
  rig.queueOutputs([CLEAN]);

  // A parent that starts a driver and exits at once, which is what the picker does.
  const root = new URL("../", import.meta.url).pathname;
  const parent = join(rig.root, "parent.ts");
  writeFileSync(
    parent,
    `import { readEnv } from "${root}src/env";
import { spawnDriver } from "${root}src/flows";
const env = readEnv(process.env);
spawnDriver(env, process.env.RUN_ID!, env.cwd);
`,
  );
  const spawned = Bun.spawn(["bun", parent], {
    env: {
      ...rig.env({ HERDR_WORKFLOWS_DRIVER: `bun ${root}src/main.ts`, RUN_ID: run.id }),
    } as Record<string, string>,
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await spawned.exited).toBe(0);

  // The parent is gone; the run finishes anyway.
  for (let i = 0; i < 200 && store.load(run.id).record.status === "running"; i++) await sleep(100);
  const finished = store.load(run.id);
  expect(finished.record.status).toBe("done");
  expect(finished.step("solo").status).toBe("done");
  // And it said what it was doing where the board can read it.
  expect(readProgress(finished.dir).map((l) => l.text)).toContain("▶ solo — iteration 1");
  // The pid file is cleaned up, so nothing thinks it is still being driven — the
  // driver is a moment behind the record it just saved, so give it that moment.
  for (let i = 0; i < 40 && driverAlive(finished.dir); i++) await sleep(50);
  expect(driverAlive(finished.dir)).toBe(false);
}, 30_000);
