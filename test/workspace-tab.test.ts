import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { CONTROL_PLANE } from "../src/naming";
import { registerAgent, registryPath, liveEntries, pruneRegistry, readRegistry, scopeFor } from "../src/registry";
import { buildView, renderWorkspace } from "../src/workspace";
import { RunStore, type Run } from "../src/run";
import type { AgentInfo } from "../src/herdr";

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

/** The Session the rig runs in, as the register and the board key it. */
function scope(env = rig.pluginEnv()) {
  return scopeFor(env, env.cwd);
}

function live(name: string, paneId: string, status: AgentInfo["status"] = "idle"): AgentInfo {
  return { name, paneId, workspaceId: rig.pluginEnv().workspaceId, status };
}

/** A run in this Session, with whatever the test needs on top. */
function seed(opts: {
  workflow: string;
  primaryInput: string;
  stepIds: string[];
  cwd?: string;
  workspace?: string | null;
  workspaceLabel?: string | null;
  session?: string | null;
  maxIterations?: number;
}): Run {
  const env = rig.pluginEnv();
  return new RunStore(env.stateDir).create({
    workflow: opts.workflow,
    cwd: opts.cwd ?? env.cwd,
    session: opts.session === undefined ? env.socketPath : opts.session,
    workspace: opts.workspace === undefined ? env.workspaceId : opts.workspace,
    workspaceLabel: opts.workspaceLabel === undefined ? "test" : opts.workspaceLabel,
    inputs: {},
    inputSources: {},
    stepIds: opts.stepIds,
    maxIterations: opts.maxIterations ?? 1,
    primaryInput: opts.primaryInput,
  });
}

/** A variant record as the engine writes one. */
function variant(agent: string, paneId: string, label: string, model = "sonnet") {
  return {
    harness: "claude",
    model,
    effort: null,
    agent,
    label,
    tabId: "1:2",
    paneId,
    status: "done" as const,
    output: null,
    error: null,
  };
}

/** The board as the Control Plane pane would build it, for a given set of live agents. */
function board(alive: AgentInfo[], now?: number) {
  const env = rig.pluginEnv();
  return buildView({ ...scope(env), stateDir: env.stateDir, workspaceLabel: "test", alive, now });
}

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
  expect(renames[0]).toEqual(["1:1", CONTROL_PLANE]);
  expect(
    rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).toContain(CONTROL_PLANE);

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
  const path = registryPath(rig.stateDir, scope());
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

  const alive = [live(entries[0]!.agent, entries[0]!.paneId)];
  expect(liveEntries(entries, alive)).toHaveLength(1);
  // Both are checked: ids compact, so a name on a different pane is a different agent.
  expect(liveEntries(entries, [{ ...alive[0]!, paneId: "1-99" }])).toHaveLength(0);
  // And an agent herdr puts in another workspace is not this Session's either.
  expect(liveEntries(entries, [{ ...alive[0]!, workspaceId: "9" }])).toHaveLength(0);
  expect(pruneRegistry(path, [])).toEqual([]);
  expect(readRegistry(path)).toEqual([]);
});

test("one agent per role: a second implementer replaces the first", () => {
  const path = registryPath(rig.stateDir, scope());
  const entry = {
    role: "implementer",
    agent: "a",
    paneId: "1-2",
    workspaceId: "1",
    runId: "r1",
    workflow: "implement",
    at: "t",
  };

  registerAgent(path, entry);
  const after = registerAgent(path, { ...entry, agent: "b", paneId: "1-3", runId: "r2" });

  expect(after).toHaveLength(1);
  expect(after[0]!.agent).toBe("b");
});

test("the board lists this Session's agents and runs, and nobody else's", () => {
  const running = seed({ workflow: "implement", primaryInput: "add-a-picker", stepIds: ["build", "review"], maxIterations: 5 });
  running.record.target_label = "add-a-picker";
  running.step("build").status = "running";
  running.step("build").variants.push(variant("impl-1", "1-4", "implement-add-a-picker/build"));
  running.save();

  const finished = seed({ workflow: "review", primaryInput: "worktree", stepIds: ["review"] });
  finished.record.target_label = "worktree";
  finished.record.status = "blocked";
  finished.record.outstanding = [{ severity: "major", title: "t", file: "f", line: 1, detail: "d" }];
  finished.save();

  // Another repo in this workspace; the same repo in another workspace; the same
  // workspace id in another herdr session; and the same id under another label.
  seed({ workflow: "plan", primaryInput: "not-mine", stepIds: ["grill"], cwd: "/elsewhere" });
  seed({ workflow: "plan", primaryInput: "not-mine", stepIds: ["grill"], workspace: "9" });
  seed({ workflow: "plan", primaryInput: "not-mine", stepIds: ["grill"], session: "/other.sock" });
  seed({ workflow: "plan", primaryInput: "not-mine", stepIds: ["grill"], workspaceLabel: "recycled" });

  const path = registryPath(rig.stateDir, scope());
  registerAgent(path, {
    role: "implementer",
    agent: "impl-1",
    paneId: "1-4",
    workspaceId: "1",
    runId: running.id,
    workflow: "implement",
    at: "t",
  });
  registerAgent(path, {
    role: "planner",
    agent: "gone-1",
    paneId: "1-9",
    workspaceId: "1",
    runId: "old",
    workflow: "plan",
    at: "t",
  });

  const view = board([live("impl-1", "1-4", "working")]);

  expect(view.agents).toEqual([
    { key: "1", name: "Implementer", agent: "impl-1", status: "working", run: running.id },
  ]);
  expect(view.active.map((r) => r.title)).toEqual(["Implement · add-a-picker"]);
  expect(view.active[0]!.detail).toBe("build · iteration 1/5");
  expect(view.recent.map((r) => r.title)).toEqual(["Review · worktree"]);
  expect(view.recent[0]!.detail).toBe("blocked · 1 finding(s) open");

  const text = renderWorkspace(view, "sent the review");
  expect(text.split("\n")[0]).toBe(`${CONTROL_PLANE} — ${rig.projectDir.split("/").at(-1)}`);
  expect(text).toContain("1  Implementer");
  expect(text).toContain("⚙ Implement · add-a-picker");
  expect(text).toContain("⚠ Review · worktree");
  expect(text).not.toContain("not-mine");
  expect(text).toContain("1-9 focus that agent");
  expect(text).toContain("s send the last review to the implementer");
  expect(text.trimEnd().split("\n").at(-1)).toBe("sent the review");
  // One screen: a normal session must not need scrolling.
  expect(text.split("\n").length).toBeLessThan(24);
});

test("every live agent of this Session's runs is listed, role or no role", () => {
  const run = seed({ workflow: "review", primaryInput: "worktree", stepIds: ["review", "synthesize"] });
  run.step("review").variants.push(
    variant("rev-opus", "1-4", "review-worktree/review/claude-opus", "opus"),
    variant("rev-pi", "1-5", "review-worktree/review/pi-gpt", "openai-codex/gpt-5.6-sol"),
  );
  run.step("synthesize").variants.push(variant("synth-1", "1-6", "review-worktree/synthesize"));
  run.save();

  // Nobody is registered: a reviewer is not a role, and it still has to be listed.
  const view = board([
    live("rev-opus", "1-4", "working"),
    live("rev-pi", "1-5", "done"),
    live("synth-1", "1-6"),
  ]);

  expect(view.agents.map((a) => [a.key, a.name, a.status])).toEqual([
    ["1", "Review · Opus", "working"],
    ["2", "Review · gpt-5.6-sol", "done"],
    ["3", "Synthesize", "idle"],
  ]);
  // An agent herdr no longer has is not listed, and neither is one it puts elsewhere.
  expect(board([live("rev-opus", "1-4")]).agents.map((a) => a.agent)).toEqual(["rev-opus"]);
  expect(board([{ ...live("rev-opus", "1-4"), workspaceId: "9" }]).agents).toEqual([]);
  expect(renderWorkspace(board([])).includes("1-9 focus that agent")).toBe(false);
});

test("a running run whose agents are all gone is abandoned, not active", () => {
  const run = seed({ workflow: "review", primaryInput: "worktree", stepIds: ["review"] });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  run.step("review").variants.push(variant("rev-1", "1-4", "review-worktree/review"));
  run.save();

  // Its agent is still alive: work in progress, whatever the clock says.
  const busy = board([live("rev-1", "1-4", "working")], Date.now() + 3_600_000);
  expect(busy.active.map((r) => r.title)).toEqual(["Review · worktree"]);
  expect(busy.recent).toEqual([]);

  // Nothing alive, and nothing written for a while: the runner is gone.
  const gone = board([], Date.now() + 3_600_000);
  expect(gone.active).toEqual([]);
  expect(gone.recent.map((r) => [r.glyph, r.detail])).toEqual([["⚠", "abandoned"]]);
  expect(renderWorkspace(gone)).toContain("⚠ Review · worktree");

  // A run that has only just been created is not abandoned, it is starting.
  expect(board([]).active.map((r) => r.title)).toEqual(["Review · worktree"]);
});

test("a run waiting on the human says so on the board", () => {
  const run = seed({ workflow: "plan", primaryInput: "add-a-picker", stepIds: ["grill", "next"] });
  run.record.awaiting = "next";
  run.save();

  const view = board([]);

  expect(view.active[0]!.glyph).toBe("⚠");
  expect(view.active[0]!.detail).toBe("next — your turn");
  expect(renderWorkspace(view)).toContain("(none live here)");
});

test("an empty state dir renders the board rather than nothing", () => {
  mkdirSync(join(rig.stateDir, "runs"), { recursive: true });
  writeFileSync(join(rig.stateDir, "runs", "half-written"), "not a run dir");

  const view = board([]);
  const text = renderWorkspace(view);

  expect(view.active).toEqual([]);
  expect(text).toContain("(none running)");
  expect(text).toContain("(nothing yet)");
});
