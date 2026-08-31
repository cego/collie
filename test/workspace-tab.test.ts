import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Effect, FileSystem, Path, PlatformError } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Rig, type RigError } from "./support/recorder";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { CONTROL_PLANE } from "../src/naming";
import {
  registerAgent,
  registryPath,
  liveEntries,
  pruneRegistry,
  readRegistry,
  scopeFor,
} from "../src/registry";
import { buildView, renderWorkspace } from "../src/workspace";
import { RunStore } from "../src/run";
import type { AgentInfo } from "../src/herdr";
import { runEffect } from "./support/effect";

let rig: Rig;

function effectTest(
  name: string,
  body: () => Effect.gen.Return<void, RigError | PlatformError.PlatformError | Error, BunServices>,
) {
  test(name, () => runEffect(Effect.gen(body)));
}

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

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "solo", SOLO);
      yield* writeDef(rig.baselineDir, "workflows", "choose", CHOOSE);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

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
}) {
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
function opened(entrypoint: string) {
  return rig
    .calls()
    .pipe(
      Effect.map((calls) =>
        calls
          .filter((c) => c.cmd === "plugin pane" && c.argv!.includes(entrypoint))
          .map((c) => c.argv!),
      ),
    );
}

effectTest("the first run opens the Control Plane tab and puts it first", function* () {
  yield* rig.queueOutputs([CLEAN]);

  const { status } = yield* runWorkflow(rig, "solo", { goal: "Add a picker" });

  expect(status).toBe("done");

  // One view pane, opened as a tab of its own, then labelled `workflows` twice:
  // once on the tab, once on the pane, so the next run can find both.
  const view = yield* opened("workspace");
  expect(view).toHaveLength(1);
  expect(view[0]!).toContain("--placement");
  expect(view[0]![view[0]!.indexOf("--placement") + 1]).toBe("tab");
  const renames = (yield* rig.calls())
    .filter((c) => c.cmd === "tab rename")
    .map((c) => c.argv!.slice(2));
  expect(renames[0]).toEqual(["1:1", CONTROL_PLANE]);
  expect(
    (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).toContain(CONTROL_PLANE);

  // First tab of the workspace, over the socket: there is no CLI for it.
  const move = (yield* rig.calls()).filter((c) => c.cmd === "tab.move");
  expect(move).toHaveLength(1);
  expect(move[0]!.params).toEqual({ tab_id: "1:1", insert_index: 0 });

  // The board's pane is the only one this plugin keeps: the run has none of its own,
  // so nothing is moved or swapped and nothing is a `status` strip.
  for (const cmd of ["pane move", "pane swap"]) expect(yield* rig.cmds()).not.toContain(cmd);
  expect(
    (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).not.toContain("status");
});

effectTest("the second run reuses that tab and re-asserts its position", function* () {
  yield* rig.queueOutputs([CLEAN, CLEAN]);

  yield* runWorkflow(rig, "solo", { goal: "one" });
  const first = (yield* rig.calls()).length;
  yield* runWorkflow(rig, "solo", { goal: "two" });

  const later = (yield* rig.calls()).slice(first);
  const reopened = later.filter((c) => c.cmd === "plugin pane" && c.argv!.includes("workspace"));
  expect(reopened).toHaveLength(0);
  // It found the tab by its label, and put it back at the front regardless.
  expect(later.map((c) => c.cmd)).toContain("tab list");
  expect(later.filter((c) => c.cmd === "tab.move").map((c) => c.params)).toEqual([
    { tab_id: "1:1", insert_index: 0 },
  ]);
});

effectTest("a step that fails after starting its agents still records them", function* () {
  // The Control Plane finds its agents in the run record, so an agent that was
  // started has to be in there whatever happens to the step afterwards.
  yield* rig.queueOutputs([CLEAN]);
  const env = { FAKE_HERDR_FAIL: JSON.stringify({ "agent prompt": "no such agent" }) };

  const { run, status } = yield* runWorkflow(rig, "solo", { goal: "g" }, { env });

  expect(status).toBe("failed");
  const variants = run.step("solo").variants;
  expect(variants).toHaveLength(1);
  expect(variants[0]!.agent).toBe("solo-g-solo-r1");
  expect(variants[0]!.paneId).not.toBeNull();

  // And the board lists it, which is the whole point of recording it.
  const view = yield* board([live(variants[0]!.agent, variants[0]!.paneId!, "working")]);
  expect(view.agents.map((a) => [a.name, a.status])).toEqual([["Solo", "working"]]);
});

effectTest(
  "a second run of the same workflow adds the target to tell the tabs apart",
  function* () {
    yield* rig.queueOutputs([CLEAN, CLEAN]);

    yield* runWorkflow(rig, "solo", { goal: "one" });
    const first = (yield* rig.calls()).length;
    yield* runWorkflow(rig, "solo", { goal: "two" });

    const created = (yield* rig.calls())
      .filter((c) => c.cmd === "tab create")
      .map((c) => c.argv!.at(-2));
    // The first tab is the plain word; the second cannot be, so it says which run it is.
    expect(created).toEqual(["⚙ Solo", "⚙ Solo · two"]);
    // The rename that follows keeps the name the tab was given, and moves the glyph.
    const later = (yield* rig.calls())
      .slice(first)
      .filter((c) => c.cmd === "tab rename")
      .map((c) => c.argv!.at(-1));
    expect(later).toContain("⚙ Solo · two");
    expect(later).toContain("✓ Solo · two");
    expect(later).not.toContain("✓ Solo");
  },
);

effectTest("a run with no workspace opens no board at all", function* () {
  yield* rig.queueOutputs([CLEAN]);

  const { status } = yield* runWorkflow(
    rig,
    "solo",
    { goal: "one" },
    { env: { HERDR_WORKSPACE_ID: "" } },
  );

  expect(status).toBe("done");
  expect(yield* opened("workspace")).toHaveLength(0);
  expect(yield* rig.cmds()).not.toContain("tab.move");
});

effectTest("a waiting choice toasts and brings the workflows tab to the front", function* () {
  const prompts = scriptedPrompts(["Stop here"]);

  const { run, status } = yield* runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  // The menu is offered only after the human has been told where to look.
  const order = yield* rig.cmds();
  const toast = order.findIndex((c) => c === "notification show");
  const focus = order.indexOf("tab focus");
  expect(toast).toBeGreaterThanOrEqual(0);
  expect(focus).toBeGreaterThan(toast);
  const focusCalls = yield* rig.calls();
  expect(focusCalls[focus]!.argv!.at(-1)).toBe("1:1");
  expect(focusCalls[toast]!.argv!).toContain("next: pick what happens next");

  // Unchanged: the choice is recorded, and the run does not stay marked as waiting.
  expect(run.record.choices.map((c) => c.title)).toEqual(["Stop here"]);
  expect(run.record.awaiting).toBeNull();
});

effectTest(
  "a long-lived agent is registered for the session, and dropped once its pane is gone",
  function* () {
    yield* writeDef(
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
    yield* rig.queueOutputs([CLEAN, CLEAN]);

    const { run } = yield* runWorkflow(rig, "pair", { goal: "g" });
    const path = yield* registryPath(rig.stateDir, scope());
    const entries = yield* readRegistry(path);

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
    expect(yield* pruneRegistry(path, [])).toEqual([]);
    expect(yield* readRegistry(path)).toEqual([]);
  },
);

effectTest("one agent per role: a second implementer replaces the first", function* () {
  const path = yield* registryPath(rig.stateDir, scope());
  const entry = {
    role: "implementer",
    agent: "a",
    paneId: "1-2",
    workspaceId: "1",
    runId: "r1",
    workflow: "implement",
    at: "t",
  };

  yield* registerAgent(path, entry);
  const after = yield* registerAgent(path, { ...entry, agent: "b", paneId: "1-3", runId: "r2" });

  expect(after).toHaveLength(1);
  expect(after[0]!.agent).toBe("b");
});

effectTest("the board lists this Session's agents and runs, and nobody else's", function* () {
  const running = yield* seed({
    workflow: "implement",
    primaryInput: "add-a-picker",
    stepIds: ["build", "review"],
    maxIterations: 5,
  });
  running.record.target_label = "add-a-picker";
  running.step("build").status = "running";
  running.step("build").variants.push(variant("impl-1", "1-4", "implement-add-a-picker/build"));
  yield* running.save();

  const finished = yield* seed({
    workflow: "review",
    primaryInput: "worktree",
    stepIds: ["review"],
  });
  finished.record.target_label = "worktree";
  finished.record.status = "blocked";
  finished.record.outstanding = [
    { severity: "major", title: "t", file: "f", line: 1, detail: "d" },
  ];
  yield* finished.save();

  // Another repo in this workspace; the same repo in another workspace; the same
  // workspace id in another herdr session; and the same id under another label.
  yield* seed({
    workflow: "plan",
    primaryInput: "not-mine",
    stepIds: ["grill"],
    cwd: "/elsewhere",
  });
  yield* seed({ workflow: "plan", primaryInput: "not-mine", stepIds: ["grill"], workspace: "9" });
  yield* seed({
    workflow: "plan",
    primaryInput: "not-mine",
    stepIds: ["grill"],
    session: "/other.sock",
  });
  yield* seed({
    workflow: "plan",
    primaryInput: "not-mine",
    stepIds: ["grill"],
    workspaceLabel: "recycled",
  });

  const path = yield* registryPath(rig.stateDir, scope());
  yield* registerAgent(path, {
    role: "implementer",
    agent: "impl-1",
    paneId: "1-4",
    workspaceId: "1",
    runId: running.id,
    workflow: "implement",
    at: "t",
  });
  yield* registerAgent(path, {
    role: "planner",
    agent: "gone-1",
    paneId: "1-9",
    workspaceId: "1",
    runId: "old",
    workflow: "plan",
    at: "t",
  });

  const view = yield* board([live("impl-1", "1-4", "working")]);

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

effectTest("every live agent of this Session's runs is listed, role or no role", function* () {
  const run = yield* seed({
    workflow: "review",
    primaryInput: "worktree",
    stepIds: ["review", "synthesize"],
  });
  run
    .step("review")
    .variants.push(
      variant("rev-opus", "1-4", "review-worktree/review/claude-opus", "opus"),
      variant("rev-pi", "1-5", "review-worktree/review/pi-gpt", "openai-codex/gpt-5.6-sol"),
    );
  run.step("synthesize").variants.push(variant("synth-1", "1-6", "review-worktree/synthesize"));
  yield* run.save();

  // Nobody is registered: a reviewer is not a role, and it still has to be listed.
  const view = yield* board([
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
  expect((yield* board([live("rev-opus", "1-4")])).agents.map((a) => a.agent)).toEqual([
    "rev-opus",
  ]);
  expect((yield* board([{ ...live("rev-opus", "1-4"), workspaceId: "9" }])).agents).toEqual([]);
  expect(renderWorkspace(yield* board([])).includes("1-9 focus that agent")).toBe(false);
});

effectTest("a running run whose agents are all gone is abandoned, not active", function* () {
  const run = yield* seed({ workflow: "review", primaryInput: "worktree", stepIds: ["review"] });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  run.step("review").variants.push(variant("rev-1", "1-4", "review-worktree/review"));
  yield* run.save();

  // Its agent is still alive: work in progress, whatever the clock says.
  const busy = yield* board(
    [live("rev-1", "1-4", "working")],
    (yield* Clock.currentTimeMillis) + 3_600_000,
  );
  expect(busy.active.map((r) => r.title)).toEqual(["Review · worktree"]);
  expect(busy.recent).toEqual([]);

  // Nothing alive, and nothing written for a while: the runner is gone.
  const gone = yield* board([], (yield* Clock.currentTimeMillis) + 3_600_000);
  expect(gone.active).toEqual([]);
  expect(gone.recent.map((r) => [r.glyph, r.detail])).toEqual([["⚠", "abandoned"]]);
  expect(renderWorkspace(gone)).toContain("⚠ Review · worktree");

  // A run that has only just been created is not abandoned, it is starting.
  expect((yield* board([])).active.map((r) => r.title)).toEqual(["Review · worktree"]);
});

effectTest("a run waiting on the human says so on the board", function* () {
  const run = yield* seed({
    workflow: "plan",
    primaryInput: "add-a-picker",
    stepIds: ["grill", "next"],
  });
  run.record.awaiting = "next";
  yield* run.save();

  const view = yield* board([]);

  expect(view.active[0]!.glyph).toBe("⚠");
  expect(view.active[0]!.detail).toBe("next — your turn");
  expect(renderWorkspace(view)).toContain("(none live here)");
});

effectTest("an empty state dir renders the board rather than nothing", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(rig.stateDir, "runs"), { recursive: true });
  yield* fs.writeFileString(path.join(rig.stateDir, "runs", "half-written"), "not a run dir");

  const view = yield* board([]);
  const text = renderWorkspace(view);

  expect(view.active).toEqual([]);
  expect(text).toContain("(none running)");
  expect(text).toContain("(nothing yet)");
});
