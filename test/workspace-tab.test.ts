import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { WORKSPACE_TAB } from "../src/naming";
import { registerAgent, registryPath, liveEntries, pruneRegistry, readRegistry } from "../src/registry";
import { buildView, renderWorkspace } from "../src/workspace";
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
---
Goal: {{inputs.goal}}
`;

const CLEAN = { verdict: "clean", findings: [] };

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

/** The `plugin pane open` calls for one entrypoint. */
function opened(entrypoint: string): string[][] {
  return rig
    .calls()
    .filter((c) => c.cmd === "plugin pane" && c.argv!.includes(entrypoint))
    .map((c) => c.argv!);
}

test("the first run opens the workflows tab, puts it first, and moves its own pane in", async () => {
  rig.queueOutputs([CLEAN]);

  const { status } = await runWorkflow(rig, "solo", { goal: "Add a picker" });

  expect(status).toBe("done");

  // One view pane, opened as a tab of its own, then labelled `workflows` twice:
  // once on the tab, once on the pane, so the next run can find both.
  const view = opened("workspace");
  expect(view).toHaveLength(1);
  expect(view[0]!).toContain("--placement");
  expect(view[0]![view[0]!.indexOf("--placement") + 1]).toBe("tab");
  const renames = rig.calls().filter((c) => c.cmd === "tab rename").map((c) => c.argv!.slice(2));
  expect(renames[0]).toEqual(["1:1", WORKSPACE_TAB]);
  expect(
    rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).toContain(WORKSPACE_TAB);

  // First tab of the workspace, over the socket: there is no CLI for it.
  const move = rig.calls().filter((c) => c.cmd === "tab.move");
  expect(move).toHaveLength(1);
  expect(move[0]!.params).toEqual({ tab_id: "1:1", insert_index: 0 });

  // The runner's own pane joins the view instead of becoming a strip in a run tab.
  const paneMove = rig.calls().filter((c) => c.cmd === "pane move");
  expect(paneMove).toHaveLength(1);
  expect(paneMove[0]!.argv!.slice(2)).toEqual([
    "1-0",
    "--tab",
    "1:1",
    "--target-pane",
    "1-1",
    "--split",
    "down",
    "--ratio",
    "0.4",
  ]);

  // No strip anywhere: no swap, and nothing is called `status` any more.
  expect(rig.cmds()).not.toContain("pane swap");
  expect(
    rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).not.toContain("status");
});

test("the second run reuses that tab and re-asserts its position", async () => {
  rig.queueOutputs([CLEAN, CLEAN]);

  await runWorkflow(rig, "solo", { goal: "one" });
  const first = rig.calls().length;
  await runWorkflow(rig, "solo", { goal: "two" });

  const later = rig.calls().slice(first);
  const reopened = later.filter((c) => c.cmd === "plugin pane" && c.argv!.includes("workspace"));
  expect(reopened).toHaveLength(0);
  // It found the tab by its label, and put it back at the front regardless.
  expect(later.map((c) => c.cmd)).toContain("tab list");
  expect(later.filter((c) => c.cmd === "tab.move").map((c) => c.params)).toEqual([
    { tab_id: "1:1", insert_index: 0 },
  ]);
  expect(later.filter((c) => c.cmd === "pane move")).toHaveLength(1);
});

test("a run with no workspace keeps its own pane and opens no tab", async () => {
  rig.queueOutputs([CLEAN]);

  const { status } = await runWorkflow(rig, "solo", { goal: "one" }, { env: { HERDR_WORKSPACE_ID: "" } });

  expect(status).toBe("done");
  expect(opened("workspace")).toHaveLength(0);
  expect(rig.cmds()).not.toContain("pane move");
  expect(rig.cmds()).not.toContain("tab.move");
});

test("a waiting choice toasts and brings the workflows tab to the front", async () => {
  const prompts = scriptedPrompts(["Stop here"]);

  const { run, status } = await runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  // The menu is offered only after the human has been told where to look.
  const order = rig.cmds();
  const toast = order.findIndex((c) => c === "notification show");
  const focus = order.indexOf("tab focus");
  expect(toast).toBeGreaterThanOrEqual(0);
  expect(focus).toBeGreaterThan(toast);
  expect(rig.calls()[focus]!.argv!.at(-1)).toBe("1:1");
  expect(rig.calls()[toast]!.argv!).toContain("next: pick what happens next");

  // Unchanged: the choice is recorded, and the run does not stay marked as waiting.
  expect(run.record.choices.map((c) => c.title)).toEqual(["Stop here"]);
  expect(run.record.awaiting).toBeNull();
});

test("a long-lived agent is registered for the session, and dropped once its pane is gone", async () => {
  writeDef(
    rig.baselineDir,
    "workflows",
    "pair",
    `---
name: pair
title: pair — one agent, two steps
inputs:
  goal: goal
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: tidy
    persona: implementer
    agent: build
    output: tidy.json
---
Goal: {{inputs.goal}}

## build
Build it.

## tidy
Tidy it.
`,
  );
  rig.queueOutputs([CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "pair", { goal: "g" });
  const env = rig.pluginEnv();
  const path = registryPath(env.stateDir, env.workspaceId, env.cwd);
  const entries = readRegistry(path);

  // The head of the `agent:` group, by its Persona — not the step that borrows it.
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    role: "implementer",
    agent: run.step("build").variants[0]!.agent,
    paneId: run.step("build").variants[0]!.paneId,
    runId: run.id,
    workflow: "pair",
  });

  const alive = [{ name: entries[0]!.agent, paneId: entries[0]!.paneId, status: "idle" as const }];
  expect(liveEntries(entries, alive)).toHaveLength(1);
  // Both are checked: ids compact, so a name on a different pane is a different agent.
  expect(liveEntries(entries, [{ ...alive[0]!, paneId: "1-99" }])).toHaveLength(0);
  expect(pruneRegistry(path, [])).toEqual([]);
  expect(readRegistry(path)).toEqual([]);
});

test("one agent per role: a second implementer replaces the first", () => {
  const env = rig.pluginEnv();
  const path = registryPath(env.stateDir, env.workspaceId, env.cwd);
  const entry = { role: "implementer", agent: "a", paneId: "1-2", runId: "r1", workflow: "implement", at: "t" };

  registerAgent(path, entry);
  const after = registerAgent(path, { ...entry, agent: "b", paneId: "1-3", runId: "r2" });

  expect(after).toHaveLength(1);
  expect(after[0]!.agent).toBe("b");
});

test("the view lists this session's agents and runs, and nobody else's", () => {
  const env = rig.pluginEnv();
  const store = new RunStore(env.stateDir);

  const running = store.create({
    workflow: "implement",
    cwd: env.cwd,
    workspace: env.workspaceId,
    inputs: { plan: "p" },
    inputSources: { plan: "asked" },
    stepIds: ["build", "review"],
    maxIterations: 5,
    primaryInput: "add-a-picker",
  });
  running.record.target_label = "add-a-picker";
  running.step("build").status = "running";
  running.save();

  const finished = store.create({
    workflow: "review",
    cwd: env.cwd,
    workspace: env.workspaceId,
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "worktree",
  });
  finished.record.status = "blocked";
  finished.record.outstanding = [{ severity: "major", title: "t", file: "f", line: 1, detail: "d" }];
  finished.save();

  // Another repo in the same workspace, and the same repo in another workspace.
  for (const other of [
    { cwd: "/elsewhere", workspace: env.workspaceId },
    { cwd: env.cwd, workspace: "9" },
  ]) {
    store.create({
      workflow: "plan",
      cwd: other.cwd,
      workspace: other.workspace,
      inputs: { goal: "g" },
      inputSources: { goal: "asked" },
      stepIds: ["grill"],
      maxIterations: 1,
      primaryInput: "not-mine",
    });
  }

  const path = registryPath(env.stateDir, env.workspaceId, env.cwd);
  registerAgent(path, {
    role: "implementer",
    agent: "impl-1",
    paneId: "1-4",
    runId: running.id,
    workflow: "implement",
    at: "t",
  });
  registerAgent(path, {
    role: "planner",
    agent: "gone-1",
    paneId: "1-9",
    runId: "old",
    workflow: "plan",
    at: "t",
  });

  const view = buildView({
    stateDir: env.stateDir,
    workspaceId: env.workspaceId,
    cwd: env.cwd,
    alive: [{ name: "impl-1", paneId: "1-4", status: "working" }],
  });

  expect(view.agents).toEqual([
    { key: "1", role: "implementer", agent: "impl-1", status: "working", run: running.id },
  ]);
  expect(view.active.map((r) => r.title)).toEqual(["implement · add-a-picker"]);
  expect(view.active[0]!.detail).toBe("build · iteration 1/5");
  expect(view.recent.map((r) => r.title)).toEqual(["review · worktree"]);
  expect(view.recent[0]!.detail).toBe("blocked · 1 finding(s) open");

  const text = renderWorkspace(view, "sent the review");
  expect(text.split("\n")[0]).toBe(`${WORKSPACE_TAB} — ${env.cwd.split("/").at(-1)}`);
  expect(text).toContain("1  implementer working");
  expect(text).toContain("⚙ implement · add-a-picker");
  expect(text).toContain("⚠ review · worktree");
  expect(text).not.toContain("not-mine");
  expect(text).toContain("s send the last review to the implementer");
  expect(text.trimEnd().split("\n").at(-1)).toBe("sent the review");
  // One screen: a normal session must not need scrolling.
  expect(text.split("\n").length).toBeLessThan(24);
});

test("a run waiting on the human says so on the board", () => {
  const env = rig.pluginEnv();
  const run = new RunStore(env.stateDir).create({
    workflow: "plan",
    cwd: env.cwd,
    workspace: env.workspaceId,
    inputs: { goal: "g" },
    inputSources: { goal: "asked" },
    stepIds: ["grill", "next"],
    maxIterations: 1,
    primaryInput: "add-a-picker",
  });
  run.record.awaiting = "next";
  run.save();

  const view = buildView({ stateDir: env.stateDir, workspaceId: env.workspaceId, cwd: env.cwd, alive: [] });

  expect(view.active[0]!.glyph).toBe("⚠");
  expect(view.active[0]!.detail).toBe("next — your turn");
  expect(renderWorkspace(view)).toContain("(none live here)");
});

test("an empty state dir renders the board rather than nothing", () => {
  const env = rig.pluginEnv();
  mkdirSync(join(env.stateDir, "runs"), { recursive: true });
  writeFileSync(join(env.stateDir, "runs", "half-written"), "not a run dir");

  const view = buildView({ stateDir: env.stateDir, workspaceId: env.workspaceId, cwd: env.cwd, alive: [] });
  const text = renderWorkspace(view);

  expect(view.active).toEqual([]);
  expect(text).toContain("(none running)");
  expect(text).toContain("(nothing yet)");
});
