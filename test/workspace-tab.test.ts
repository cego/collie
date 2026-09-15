import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Effect, FileSystem, Path, PlatformError } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Rig, type RigError } from "./support/recorder";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { COLLIE_TAB } from "../src/naming";
import {
  registerAgent,
  registryPath,
  liveEntries,
  pruneRegistry,
  readRegistry,
  scopeFor,
} from "../src/registry";
import {
  NO_OUTCOME,
  buildView,
  buildWideView,
  renderRedirect,
  renderWorkspace,
  type WorkspaceView,
} from "../src/workspace";
import { NO_MARKS } from "../src/lines";
import { recordDisposition } from "../src/disposition";
import { originPath, readOrigin } from "../src/home";
import { herdOf } from "../src/steering";
import { appState, boardFlow, type ControlSession } from "../src/flows";
import { Herdr } from "../src/herdr";
import { RunStore } from "../src/run";
import { writeChoice } from "../src/driver";
import type { AgentInfo, WorkspaceInfo } from "../src/herdr";
import { runEffect } from "./support/effect";
import { focus } from "./support/focus";
import { DateTime } from "effect";
import { FakeBin } from "./support/bin";

let rig: Rig;

function effectTest(
  name: string,
  body: () => Effect.gen.Return<void, RigError | PlatformError.PlatformError | Error, BunServices>,
  /** For the few that open the Home twice: each ensure is a fake-herdr subprocess. */
  timeout?: number,
) {
  test(name, () => runEffect(Effect.gen(body)), timeout);
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
      # Two, because a menu with one option is taken rather than asked.
      - title: Stop here
        stop: true
      - title: Stop here too
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

function live(
  name: string,
  paneId: string,
  status: AgentInfo["status"] = "idle",
  title: string | null = null,
  /** Which workspace herdr says it is in; this Session's unless a test says otherwise. */
  workspaceId: string | null = rig.pluginEnv().workspaceId,
): AgentInfo {
  return {
    name,
    paneId,
    workspaceId,
    status,
    title,
    terminalId: `term-${name}`,
    agentSession: null,
  };
}

/** A run in this Session, with whatever the test needs on top. */
function seed(opts: {
  workflow: string;
  namedAfter: string;
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
    namedAfter: opts.namedAfter,
  });
}

/** A variant record as the engine writes one. */
function variant(agent: string, paneId: string, label: string, model = "sonnet") {
  return {
    harness: "claude",
    model,
    effort: null,
    permissions: null,
    agent,
    label,
    tabId: "1:2",
    paneId,
    status: "done" as const,
    output: null,
    error: null,
    repairs: [],
    nudges: 0,
  };
}

/** The Session the Control Plane app reads through, for the herdr calls it makes. */
function controlSession(env = rig.pluginEnv()): ControlSession {
  return {
    herdr: new Herdr(env),
    ...scope(env),
    stateDir: env.stateDir,
    configDir: env.configDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
  };
}

/** The board as the Control Plane pane would build it, for a given set of live agents. */
function board(alive: AgentInfo[], now?: number, quietMs?: number) {
  const env = rig.pluginEnv();
  return buildView({
    ...scope(env),
    stateDir: env.stateDir,
    workspaceLabel: "test",
    alive,
    now,
    quietMs,
  });
}

/** The board as the pane builds it, with `git` answering for the installation. */
const viewOfInstallation = Effect.fn("workspaceTest.viewOfInstallation")(function* (now?: number) {
  const env = rig.pluginEnv();
  return yield* buildView({
    ...scope(env),
    stateDir: env.stateDir,
    workspaceLabel: "test",
    alive: [],
    pluginRoot: rig.projectDir,
    now,
  });
});

const boardOfInstallation = Effect.fn("workspaceTest.boardOfInstallation")(function* (
  git: string,
  now?: number,
) {
  const bin = yield* FakeBin.make(`${rig.root}/bin`);
  yield* bin.add("git", git);
  const view = yield* viewOfInstallation(now);
  yield* bin.restore();
  return view;
});

effectTest("the board says how far behind its remote the installation is", function* () {
  const view = yield* boardOfInstallation(`echo 3`);

  expect(view.behind).toBe(3);
  expect(renderWorkspace(view)).toContain("3 commits behind");
  // Shown, never sent: being a few commits behind is not worth interrupting anyone.
  expect(yield* rig.cmds()).not.toContain("notify");
});

effectTest("a count stands for a moment, and not for longer than that", function* () {
  // The board redraws every second and a half and this answer changes only when
  // something fetches or pulls, so it is not asked again on every redraw — but
  // `collie upgrade` in another terminal has to show up while the human is still
  // looking at the board, so what it stands for is seconds, not minutes.
  const start = 1_000_000;
  const behind = yield* boardOfInstallation(`echo 3`, start);
  const redrawn = yield* boardOfInstallation(`echo 0`, start + 1_500);
  const later = yield* boardOfInstallation(`echo 0`, start + 60_000);

  expect(behind.behind).toBe(3);
  expect(redrawn.behind).toBe(3);
  expect(later.behind).toBe(0);
});

effectTest("the board's fetch cannot prompt, and cannot hang the redraw", function* () {
  const fs = yield* FileSystem.FileSystem;
  const bin = yield* FakeBin.make(`${rig.root}/bin`);
  // The fetch carries its no-prompt settings in front of it, so what says which
  // command this is is the whole argument list rather than the first word. The stub
  // records both what it was passed and what it was given to run with.
  yield* bin.add(
    "git",
    `case "$*" in
      *fetch*) echo "$* prompt=$GIT_TERMINAL_PROMPT" >> "${rig.root}/fetches" ;;
      *) echo 2 ;;
    esac`,
  );

  const view = yield* viewOfInstallation();

  // Answered from the refs this machine already has: the board never waits on a
  // remote. The fetch runs behind it, and the next redraw is what shows its result.
  expect(view.behind).toBe(2);
  // Generous, because it exits the moment the file appears: the whole suite runs
  // beside this, and a forked subprocess is not owed a couple of seconds.
  const fetched = `${rig.root}/fetches`;
  for (let i = 0; i < 200 && !(yield* fs.exists(fetched)); i++) yield* Effect.sleep("50 millis");
  expect(yield* fs.exists(fetched)).toBe(true);
  // Nothing it runs may stop to ask a human: the pane is reading those keys.
  const asked = yield* fs.readFileString(fetched);
  expect(asked).toContain("prompt=0");
  expect(asked).toContain("credential.helper=");
  expect(asked).toContain("BatchMode=yes");
  yield* bin.restore();
});

effectTest("an installation level with its remote says nothing", function* () {
  const view = yield* boardOfInstallation(`echo 0`);

  expect(view.behind).toBe(0);
  expect(renderWorkspace(view)).not.toContain("behind");
});

effectTest("an installation git cannot answer for says nothing, and still renders", function* () {
  // Not a checkout, no upstream, or an unreachable remote: all the same answer.
  const view = yield* boardOfInstallation(`exit 1`);

  expect(view.behind).toBe(null);
  expect(renderWorkspace(view)).toContain(COLLIE_TAB);
  expect(renderWorkspace(view)).not.toContain("behind");
});

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

effectTest("the first run makes the Herd a Home and opens its board there", function* () {
  yield* rig.queueOutputs([CLEAN]);

  const { status } = yield* runWorkflow(rig, "solo", { goal: "Add a picker" });

  expect(status).toBe("done");

  // A workspace of Collie's own, with the board's pane opened in it as a tab. One Home
  // per Herd (ADR-0009), so it is created rather than found in the Run's own workspace.
  const created = (yield* rig.calls()).filter((c) => c.cmd === "workspace create");
  expect(created).toHaveLength(1);
  const view = yield* opened("workspace");
  expect(view).toHaveLength(1);
  expect(view[0]![view[0]!.indexOf("--workspace") + 1]).toBe("w1");

  // Owned by metadata and not by a label: the token on the workspace and on the pane is
  // what the next ensure reads, and no rename decides anything.
  const marked = (yield* rig.calls()).filter((c) => c.cmd === "workspace.report_metadata");
  expect(marked).toHaveLength(1);
  expect((yield* rig.calls()).map((c) => c.cmd)).toContain("pane.report_metadata");

  // The board's own tab is never the anchor: this Run's step tab is ordered in the
  // Run's own workspace, and Collie owns nothing else there yet.
  for (const cmd of ["pane move", "pane swap"]) expect(yield* rig.cmds()).not.toContain(cmd);
});

effectTest("a second run finds the Home rather than making another", function* () {
  yield* rig.queueOutputs([CLEAN, CLEAN]);

  yield* runWorkflow(rig, "solo", { goal: "one" });
  const first = (yield* rig.calls()).length;
  yield* runWorkflow(rig, "solo", { goal: "two" });

  const later = (yield* rig.calls()).slice(first);
  // No second Home and no second board pane: the record plus the live token is proof,
  // so the second Run refreshes the claim rather than deciding again.
  expect(later.filter((c) => c.cmd === "workspace create")).toHaveLength(0);
  expect(
    later.filter((c) => c.cmd === "plugin pane" && c.argv!.includes("workspace")),
  ).toHaveLength(0);
  expect(later.map((c) => c.cmd)).toContain("workspace.report_metadata");
});

effectTest("no HERDR_SOCKET_PATH: the Home is still found, via herdr's own status", function* () {
  // A CLI launch that never got HERDR_SOCKET_PATH injected. The Herd is named by the
  // socket, so without discovery there would be no Herd and no Home at all.
  yield* rig.queueOutputs([CLEAN]);

  const { status } = yield* runWorkflow(
    rig,
    "solo",
    { goal: "Add a picker" },
    { env: { HERDR_SOCKET_PATH: "" } },
  );

  expect(status).toBe("done");
  const calls = yield* rig.calls();
  expect(calls.map((c) => c.cmd)).toContain("status server");
  expect(calls.filter((c) => c.cmd === "workspace create")).toHaveLength(1);
});

effectTest("a step whose prompt cannot be delivered still records its agents", function* () {
  // The Control Plane finds its agents in the run record, so an agent that was
  // started has to be in there whatever happens to the step afterwards.
  yield* rig.queueOutputs([CLEAN]);
  const env = { FAKE_HERDR_FAIL: JSON.stringify({ "agent prompt": "no such agent" }) };

  const { run, status } = yield* runWorkflow(rig, "solo", { goal: "g" }, { env });

  // Blocked, not failed: a prompt that did not arrive is the variant's problem, and
  // the Run stops for the human the way a held compaction does — `run resume` picks
  // it back up rather than the whole fan-out being abandoned.
  expect(status).toBe("blocked");
  const variants = run.step("solo").variants;
  expect(variants).toHaveLength(1);
  expect(variants[0]!.status).toBe("blocked");
  expect(variants[0]!.error).toContain("was not given its prompt");
  expect(variants[0]!.agent).toBe("solo-g-solo-r1");
  expect(variants[0]!.paneId).not.toBeNull();

  // And the board lists it, which is the whole point of recording it.
  const view = yield* board([live(variants[0]!.agent, variants[0]!.paneId!, "working")]);
  expect(view.agents.map((a) => [a.name, a.status])).toEqual([["Solo", "working"]]);
});

effectTest(
  "every run's tab names the run and the step it is on, so two of them read apart",
  function* () {
    yield* rig.queueOutputs([CLEAN, CLEAN]);

    yield* runWorkflow(rig, "solo", { goal: "one" });
    const first = (yield* rig.calls()).length;
    yield* runWorkflow(rig, "solo", { goal: "two" });

    const created = (yield* rig.calls())
      .filter((c) => c.cmd === "tab create")
      .map((c) => c.argv!.at(-2));
    // Workflow, what it is for, and the step: no `tab list` is asked for and no
    // collision is judged, because two runs never had the same name to begin with.
    expect(created).toEqual(["⚙ Solo · one · solo", "⚙ Solo · two · solo"]);
    // The rename that follows keeps the sentence and moves the glyph; the step drops
    // off the end once there is no step running.
    const later = (yield* rig.calls())
      .slice(first)
      .filter((c) => c.cmd === "tab rename")
      .map((c) => c.argv!.at(-1));
    expect(later).toContain("✓ Solo · two");
    expect(later).not.toContain("✓ Solo · one");
  },
);

effectTest("a run in no workspace orders nothing, and still has a Home", function* () {
  yield* rig.queueOutputs([CLEAN]);

  const { status } = yield* runWorkflow(
    rig,
    "solo",
    { goal: "one" },
    { env: { HERDR_WORKSPACE_ID: "" } },
  );

  expect(status).toBe("done");
  // The Home is the Herd's, not this Run's workspace, so it is made either way. What a
  // Run with no workspace of its own has is no strip to order: `tab.move` is a local
  // fact about one workspace, and there is none here.
  expect(yield* rig.cmds()).toContain("workspace create");
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

effectTest("findings that were handed off are not presented as untouched", function* () {
  const finished = yield* seed({
    workflow: "review",
    namedAfter: "worktree",
    stepIds: ["review"],
  });
  finished.record.target_label = "worktree";
  finished.record.status = "blocked";
  finished.record.outstanding = [
    { severity: "major", title: "t", file: "f", line: 1, detail: "d" },
  ];
  finished.record.handoffs.push({
    id: "h1",
    direction: "sent",
    role: "implementer",
    agent: "impl-1",
    run: "other",
    at: "t",
    note: "sent review.md to the implementer",
  });
  yield* finished.save();

  const view = yield* board([]);

  expect(view.recent[0]!.detail).toBe("blocked · 1 finding(s) open · handed off");
});

effectTest("an open board keeps the tab glyph true after the Driver has gone", function* () {
  // The other half of the reconcile: a review handed back to a live implementer, or a
  // finished run's agent prompted from here, leaves herdr's own status the only thing
  // that knows work has started again. Nobody renames anything; the board notices.
  const run = yield* seed({
    workflow: "implement",
    namedAfter: "add-a-picker",
    stepIds: ["build"],
    maxIterations: 5,
  });
  run.record.target_label = "add-a-picker";
  run.record.status = "done";
  run.record.finished_at = run.record.created_at;
  run.step("build").status = "done";
  run.step("build").variants.push(variant("impl-1", "1-4", "implement-add-a-picker/build"));
  yield* run.save();
  yield* rig.addAgent("impl-1", "1-4");

  const env = rig.pluginEnv({ FAKE_HERDR_AGENT_STATUS: "working" });
  const board = appState(controlSession(env), env);
  yield* board.load(focus());

  const renames = (yield* rig.calls())
    .filter((c) => c.cmd === "tab rename")
    .map((c) => c.argv!.slice(2));
  expect(renames).toContainEqual(["1:2", "⚙ Implement · add-a-picker"]);
  // And not again on the next read: the label is the same string, and the board is
  // re-read every three seconds and on every filesystem event.
  yield* board.load(focus({ nonce: 1 }));
  expect(
    (yield* rig.calls()).filter((c) => c.cmd === "tab rename" && c.argv![2] === "1:2"),
  ).toHaveLength(1);
});

effectTest("a wide board asks herdr no more than the local board it is built beside", function* () {
  yield* rig.addWorkspace("1", "test", rig.projectDir);
  yield* rig.addWorkspace("w9", "Env", rig.projectDir);
  const env = rig.pluginEnv();
  const board = appState(controlSession(env), env);

  yield* board.load(focus());
  const counted = (cmds: ReadonlyArray<string>) => ({
    agents: cmds.filter((c) => c === "agent list").length,
    workspaces: cmds.filter((c) => c === "workspace list").length,
  });
  expect(counted(yield* rig.cmds())).toEqual({ agents: 1, workspaces: 1 });

  // The wide board is built from the same read: the local board already asks for both,
  // and asking twice cost two extra calls a tick and let the two boards reconcile the
  // same tab from two different answers about the same agent.
  yield* board.load(focus({ filter: { kind: "all" } }));

  expect(counted(yield* rig.cmds())).toEqual({ agents: 2, workspaces: 2 });
});

effectTest("no View but Runs reads the wide board, whatever the scope says", function* () {
  yield* rig.addWorkspace("1", "test", rig.projectDir);
  const env = rig.pluginEnv();
  const board = appState(controlSession(env), env);

  // `g` is the Runs view's key, but the scope outlives leaving it: reading a board no
  // View is drawing is a workspace list and a group per workspace for nothing.
  const state = yield* board.load(
    focus({ filter: { kind: "all" }, view: "history", shown: ["runs", "history"] }),
  );

  expect(state.wide).toBeNull();
  expect((yield* rig.cmds()).filter((c) => c === "workspace list")).toHaveLength(1);
});

effectTest("a board reconciles no tab herdr has no agent in", function* () {
  // A finished run's tab is usually closed, and one rename per finished run on every
  // open of the board would be a burst of herdr calls that told nobody anything.
  const run = yield* seed({ workflow: "review", namedAfter: "worktree", stepIds: ["review"] });
  run.record.status = "done";
  run.record.finished_at = run.record.created_at;
  run.step("review").variants.push(variant("rev-1", "1-4", "review-worktree/review"));
  yield* run.save();

  const env = rig.pluginEnv();
  yield* appState(controlSession(env), env).load(focus());

  expect(
    (yield* rig.calls()).filter((c) => c.cmd === "tab rename" && c.argv![2] === "1:2"),
  ).toEqual([]);
});

effectTest("the board lists this Session's agents and runs, and nobody else's", function* () {
  const running = yield* seed({
    workflow: "implement",
    namedAfter: "add-a-picker",
    stepIds: ["build", "review"],
    maxIterations: 5,
  });
  running.record.target_label = "add-a-picker";
  running.step("build").status = "running";
  running.step("build").variants.push(variant("impl-1", "1-4", "implement-add-a-picker/build"));
  yield* running.save();

  const finished = yield* seed({
    workflow: "review",
    namedAfter: "worktree",
    stepIds: ["review"],
  });
  finished.record.target_label = "worktree";
  finished.record.status = "blocked";
  finished.record.outstanding = [
    { severity: "major", title: "t", file: "f", line: 1, detail: "d" },
  ];
  yield* finished.save();

  // A run in its own worktree is still this workspace's: since runs stay in the
  // workspace they were activated from, its cwd is never the board's.
  yield* seed({
    workflow: "plan",
    namedAfter: "in-a-worktree",
    stepIds: ["grill"],
    cwd: "/somewhere/.herdr/worktrees/project/in-a-worktree",
  });
  // The same repo in another workspace; the same workspace id in another herdr
  // session; and the same id under another label.
  yield* seed({ workflow: "plan", namedAfter: "not-mine", stepIds: ["grill"], workspace: "9" });
  yield* seed({
    workflow: "plan",
    namedAfter: "not-mine",
    stepIds: ["grill"],
    session: "/other.sock",
  });
  yield* seed({
    workflow: "plan",
    namedAfter: "not-mine",
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

  const view = yield* board([live("impl-1", "1-4", "working", "Simplify cego.collie plugin")]);

  // What the agent is doing comes off the same `agent list` the statuses do; the board
  // asks herdr nothing extra for it.
  expect(view.agents).toEqual([
    {
      key: "1",
      name: "Implementer",
      agent: "impl-1",
      status: "working",
      run: running.id,
      now: "Simplify cego.collie plugin",
    },
  ]);
  expect(view.active.map((r) => r.title)).toContain("Implement · add-a-picker");
  expect(view.active.some((r) => r.title.includes("in-a-worktree"))).toBe(true);
  expect(view.active).toHaveLength(2);
  expect(view.active.find((r) => r.title === "Implement · add-a-picker")!.detail).toBe(
    "build · iteration 1/5",
  );
  expect(view.recent.map((r) => r.title)).toEqual(["Review · worktree"]);
  expect(view.recent[0]!.detail).toBe("blocked · 1 finding(s) open");

  const text = renderWorkspace(view, "sent the review");
  expect(text.split("\n")[0]).toBe(`${COLLIE_TAB} — ${rig.projectDir.split("/").at(-1)}`);
  expect(text).toContain("1  Implementer");
  expect(text).toContain("Simplify cego.collie plugin");
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
    namedAfter: "worktree",
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
  const run = yield* seed({ workflow: "review", namedAfter: "worktree", stepIds: ["review"] });
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

effectTest("the board says what pruning removed and what it is holding", function* () {
  const env = rig.pluginEnv();
  const view = yield* buildView({
    ...scope(env),
    stateDir: env.stateDir,
    workspaceLabel: "test",
    alive: [],
    worktrees: ["♻ removed collie-app · merged in !14", "kept collie-tui · 2 commit(s) unpushed"],
  });

  const text = renderWorkspace(view);
  expect(text).toContain("Worktrees");
  expect(text).toContain("♻ removed collie-app · merged in !14");
  expect(text).toContain("kept collie-tui · 2 commit(s) unpushed");
  // Nothing to report is nothing on the screen, not an empty section every refresh.
  expect(renderWorkspace(yield* board([]))).not.toContain("Worktrees");
});

effectTest("a run with a question to answer says so, and is counted as needing you", function* () {
  const run = yield* seed({
    workflow: "plan",
    namedAfter: "add-a-picker",
    stepIds: ["grill", "next"],
  });
  run.record.awaiting = "next";
  yield* run.save();
  yield* writeChoice(run.dir, {
    id: "c1",
    kind: "menu",
    run: run.id,
    step: "next",
    header: "What next?",
    footer: "↑↓ move",
    items: [{ id: "Stop here", title: "Stop here" }],
  });

  const view = yield* board([]);

  expect(view.active[0]!.glyph).toBe("⚠");
  expect(view.active[0]!.detail).toBe("next — your turn");
  expect(view.active[0]!.needsYou).toBe(true);
  expect(renderWorkspace(view)).toContain("(none live here)");
});

effectTest("a question left behind by a Driver that is gone is not offered as one", function* () {
  // Recovery classifies it as stale, so the board must not take an answer for it: the
  // next Driver discards the inbox entry, and the human was told it had been sent.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* seed({
    workflow: "plan",
    namedAfter: "add-a-picker",
    stepIds: ["grill", "next"],
  });
  run.record.awaiting = "next";
  yield* run.save();
  yield* writeChoice(run.dir, {
    id: "c1",
    kind: "menu",
    run: run.id,
    step: "next",
    header: "What next?",
    footer: "↑↓ move",
    items: [{ id: "Stop here", title: "Stop here" }],
  });
  // A claim that is there and dead is conclusive at once, so no start grace applies.
  yield* fs.writeFileString(
    path.join(run.dir, "runner.pid"),
    `{"pid":2147483646,"start":null,"at":"2026-09-08T09:00:00.000Z"}\n`,
  );

  const view = yield* board([]);

  expect(view.active[0]!.choice).toBeNull();
  expect(view.active[0]!.needsYou).toBe(false);
});

effectTest("a run awaiting a step with nothing to answer is not one that needs you", function* () {
  // `awaiting` is set for a gate the run is holding at, and for an agent answering a
  // prompt in its own pane: there is nothing on the board to answer for either, so
  // "1 need you" used to send a human to a row with no question under it.
  const run = yield* seed({
    workflow: "plan",
    namedAfter: "add-a-picker",
    stepIds: ["grill", "next"],
  });
  run.record.awaiting = "next";
  yield* run.save();

  const view = yield* board([]);

  expect(view.active[0]!.needsYou).toBe(false);
  // What it is waiting for is still what the row says; it just does not claim to be
  // your turn, and it is still one of the runs that are going.
  expect(view.active[0]!.detail).toBe("next");
  expect(view.active[0]!.choice).toBeNull();
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

effectTest("a register that will not decode reads as empty rather than failing", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* registryPath(rig.stateDir, scope());
  yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });

  // Half-written by a process that died, and hand-edited into the wrong shape. The
  // register is a cache of what herdr was last seen to have, so neither may fail a
  // stop, a hand-off, or the Control Plane's read.
  for (const raw of ["{not json", '[{"role":1}]', ""]) {
    yield* fs.writeFileString(path, raw);
    expect(yield* readRegistry(path)).toEqual([]);
  }
});

/** A fixed clock: durations are the point, so they must not depend on the wall. */
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const FIXED_ISO = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

test("an active row says how long its step has been going, and when the run went quiet", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* seed({ workflow: "implement", namedAfter: "x", stepIds: ["build"] });
      const step = run.record.steps[0]!;
      step.status = "running";
      step.started_at = FIXED_ISO(NOW - 12 * 60_000);
      // A live agent of its own, so the quiet directory does not make it abandoned:
      // that is a different judgement, and this one is about a run still working.
      step.variants.push(variant("impl-1", "1-4", "implement-x/build"));
      yield* run.save();
      // Everything in the run dir written twelve minutes ago, which is what the board
      // reads as "nothing has happened here".
      const quietSince = DateTime.toDateUtc(DateTime.makeUnsafe(NOW - 9 * 60_000));
      for (const name of yield* fs.readDirectory(run.dir)) {
        yield* fs.utimes(`${run.dir}/${name}`, quietSince, quietSince);
      }

      const alive = [live("impl-1", "1-4", "working")];
      const loud = yield* board(alive, NOW, 30 * 60_000);
      expect(loud.active[0]!.detail).toBe("build · 12m");

      // Over the threshold: the row says so, and says how long.
      const quiet = yield* board(alive, NOW, 5 * 60_000);
      expect(quiet.active[0]!.detail).toBe("build · 12m · quiet for 9m");
    }),
  ));

test("a plan run that fanned out says which wave it is on, and its children nest under it", () =>
  runEffect(
    Effect.gen(function* () {
      const child = yield* seed({ workflow: "implement", namedAfter: "x", stepIds: ["build"] });
      const parent = yield* seed({ workflow: "plan", namedAfter: "x", stepIds: ["grill", "next"] });
      child.record.parent = parent.id;
      yield* child.save();
      parent.record.fanout = {
        step: "next",
        title: "Implement now",
        waves: [["cego/api"], ["cego/web"]],
        runs: { "cego/api": child.id },
        mrs: {},
        wave: 1,
        blocked: null,
      };
      parent.record.steps[1]!.status = "running";
      yield* parent.save();

      const view = yield* board([], NOW);
      const row = view.active.find((r) => r.id === parent.id)!;
      // Not "next · 3m": which wave and which repository is the whole of its state.
      expect(row.detail).toBe("wave 1/2 · waiting on cego/api");
      // The parent's row names the repository run it fanned out, which is what nests it.
      expect(view.active.find((r) => r.id === parent.id)!.children).toEqual([child.id]);

      // Over, and the row says how many repositories it built.
      parent.record.fanout = { ...parent.record.fanout, wave: 0 };
      parent.record.status = "done";
      yield* parent.save();
      const done = yield* board([], NOW);
      expect(done.recent.find((r) => r.id === parent.id)!.detail).toContain("2 repos · done");

      // Or which one stopped it, and what became of that run: a repository the operator
      // stopped is not one that failed, and the row used to say so anyway.
      for (const status of ["failed", "stopped", "not started"]) {
        parent.record.fanout = { ...parent.record.fanout, blocked: { repo: "cego/api", status } };
        yield* parent.save();
        const stuck = yield* board([], NOW);
        expect(stuck.recent.find((r) => r.id === parent.id)!.detail).toContain(
          `blocked · cego/api ${status}`,
        );
      }

      // Stopped mid-wave, which is what an interrupted Driver leaves behind: nothing
      // writes `wave: 0` on the way out, so the row would otherwise describe a wait
      // that has ended as though it were still going.
      parent.record.fanout = { ...parent.record.fanout, wave: 2, blocked: null };
      parent.record.status = "blocked";
      yield* parent.save();
      const interrupted = yield* board([], NOW);
      const stoppedRow = interrupted.recent.find((r) => r.id === parent.id)!;
      expect(stoppedRow.detail.startsWith("blocked · in wave 2/2")).toBe(true);
      expect(stoppedRow.detail).not.toContain("waiting on");
    }),
  ));

effectTest(
  "the board key makes the Home and goes to it",
  function* () {
    const env = rig.pluginEnv();

    expect(yield* boardFlow(new Herdr(env), env)).toBe(0);

    expect(yield* opened("workspace")).toHaveLength(1);
    const cmds = yield* rig.cmds();
    // The Home is somewhere else, so reaching it is a workspace switch as well as a tab
    // focus — and it is owned by the token it was just given, never by its label.
    expect(cmds).toContain("workspace create");
    expect(cmds).toContain("workspace.report_metadata");
    expect(cmds).toContain("workspace.focus");
    // And where the shortcut was pressed, so the board opens narrowed to that work.
    const origin = yield* readOrigin(
      yield* originPath(env.stateDir, yield* herdOf(env.socketPath)),
    );
    expect(origin?.workspaceId).toBe("1");
  },
  20_000,
);

effectTest(
  "the board key finds the Home it made rather than making a second",
  function* () {
    const env = rig.pluginEnv();
    expect(yield* boardFlow(new Herdr(env), env)).toBe(0);
    const first = (yield* rig.calls()).length;

    expect(yield* boardFlow(new Herdr(env), env)).toBe(0);

    const later = (yield* rig.calls()).slice(first);
    expect(later.filter((c) => c.cmd === "workspace create")).toHaveLength(0);
    expect(later.map((c) => c.cmd)).toContain("workspace.focus");
  },
  20_000,
);

/** The whole herdr session as groups, for a given set of workspaces and live agents. */
function wide(workspaces: WorkspaceInfo[], alive: AgentInfo[] = [], now?: number) {
  const env = rig.pluginEnv();
  return buildWideView({
    session: env.socketPath,
    stateDir: env.stateDir,
    workspaces,
    alive,
    now,
  });
}

function workspace(workspaceId: string, label: string, cwd = rig.projectDir): WorkspaceInfo {
  return { workspaceId, label, cwd, worktree: null, tokens: {} };
}

/** A run recorded against a workspace, running or finished as the test needs. */
const inWorkspace = Effect.fn("workspaceTest.inWorkspace")(function* (opts: {
  workflow: string;
  namedAfter: string;
  workspaceId: string;
  status?: "running" | "done";
  step?: string;
  iteration?: number;
  agent?: string;
}) {
  const stepId = opts.step ?? "build";
  const iteration = opts.iteration ?? 1;
  const run = yield* seed({
    workflow: opts.workflow,
    namedAfter: opts.namedAfter,
    stepIds: [stepId],
    workspace: opts.workspaceId,
    workspaceLabel: null,
    maxIterations: 5,
  });
  run.record.target_label = opts.namedAfter;
  run.record.status = opts.status ?? "running";
  run.record.iteration = iteration;
  const step = run.step(stepId);
  step.status = opts.status === "done" ? "done" : "running";
  step.iteration = iteration;
  // A step the engine marked `running` has a start, so its row's detail carries an
  // elapsed. The fixture had none, which is what hid a group summary that could not
  // report the round.
  step.started_at = run.record.created_at;
  if (opts.agent) step.variants.push(variant(opts.agent, "1-4", "x"));
  if (opts.status === "done") run.record.finished_at = run.record.created_at;
  yield* run.save();
  return run;
});

effectTest("a workspace label keeps its own punctuation, and loses only the glyph", function* () {
  // The boundary's rule: the glyph and the space after it, and the space is what says
  // it is one — stripping every leading non-alphanumeric took a dotfile repo's dot.
  yield* inWorkspace({ workflow: "plan", namedAfter: "a", workspaceId: "w1" });
  yield* inWorkspace({ workflow: "plan", namedAfter: "b", workspaceId: "w2" });

  const view = yield* wide([workspace("w1", "⚙ Implement · glass"), workspace("w2", ".dotfiles")]);

  expect(view.groups.map((g) => g.label)).toEqual(["Implement · glass", ".dotfiles"]);
});

effectTest("the wide view groups the session's workspaces, in herdr's order", function* () {
  yield* inWorkspace({ workflow: "implement", namedAfter: "glass", workspaceId: "w1" });
  yield* inWorkspace({
    workflow: "review",
    namedAfter: "picker",
    workspaceId: "w2",
    step: "review",
    iteration: 2,
  });

  const view = yield* wide([
    workspace("w1", "⚙ Implement · glass"),
    workspace("w2", "Review · picker"),
    workspace("w3", "Env"),
  ]);

  // In herdr's order, and named by herdr's own label with the status glyph stripped:
  // `w28` is how herdr addresses a workspace, not what a human calls one.
  expect(view.groups.map((g) => g.label)).toEqual(["Implement · glass", "Review · picker"]);
  // A workspace Collie has nothing in is named on the closing line rather than given a
  // group of its own: a herdr session is mostly those.
  expect(view.quiet).toEqual(["Env"]);
  // What the group row says: how many runs are going, and the leading run's step.
  expect(view.groups[0]!.running).toBe(1);
  expect(view.groups[0]!.needsYou).toBe(0);
  // The step alone until it has looped, and the round once it has — the same rule the
  // run's tab label follows, so the two cannot drift.
  expect(view.groups[0]!.summary).toBe("1 running · build");
  expect(view.groups[1]!.summary).toBe("1 running · review · 2/5");
  // What the old summary tripped on: the round is the third thing in a running run's
  // detail, after the step and the elapsed, so a summary made of the first two words
  // of that string could never carry it.
  const detail = view.groups[1]!.active[0]!.detail.split(" · ");
  expect(detail[0]).toBe("review");
  expect(detail[2]).toBe("iteration 2/5");
  expect(view.groups[0]!.glyph).toBe("⚙");
});

effectTest("a workspace wearing a recycled id does not inherit the old one's runs", function* () {
  // herdr compacts workspace ids: yesterday's `w1` was another checkout, and its
  // finished runs are still in the run dirs. Grouping by id alone nested them under
  // today's `w1` and gave its group row the glyph of a run that never happened there.
  const mine = yield* inWorkspace({
    workflow: "implement",
    namedAfter: "glass",
    workspaceId: "w1",
  });
  // herdr's own label, glyph and all: that is what a run records at its start and what
  // `workspace list` answers with later.
  mine.record.workspace_label = "⚙ Implement · glass";
  yield* mine.save();
  const recycled = yield* inWorkspace({
    workflow: "plan",
    namedAfter: "yesterday",
    workspaceId: "w1",
    status: "done",
  });
  recycled.record.workspace_label = "Some other checkout";
  yield* recycled.save();
  // And one from another herdr session, which is not this session's to group either.
  const foreign = yield* inWorkspace({
    workflow: "plan",
    namedAfter: "elsewhere",
    workspaceId: "w1",
    status: "done",
  });
  foreign.record.session = "/other.sock";
  foreign.record.workspace_label = "⚙ Implement · glass";
  yield* foreign.save();

  const view = yield* wide([workspace("w1", "⚙ Implement · glass")]);

  expect(view.groups[0]!.active.map((r) => r.id)).toEqual([mine.id]);
  expect(view.groups[0]!.recent).toEqual([]);
});

effectTest("a group keeps two finished runs, so a quiet workspace says why", function* () {
  for (const name of ["oldest", "middle", "newest"]) {
    yield* inWorkspace({
      workflow: "plan",
      namedAfter: name,
      workspaceId: "w1",
      status: "done",
    });
  }

  const view = yield* wide([workspace("w1", "Collie")]);

  const group = view.groups[0]!;
  expect(group.active).toEqual([]);
  expect(group.recent).toHaveLength(2);
  // Nothing running, so the group wears the newest run's own glyph.
  expect(group.glyph).toBe("✓");
  expect(group.summary).toBe("nothing running · done");
});

effectTest("a run in a workspace this session no longer has is listed Elsewhere", function* () {
  yield* inWorkspace({
    workflow: "implement",
    namedAfter: "gone",
    workspaceId: "w9",
    agent: "impl-9",
  });
  yield* inWorkspace({ workflow: "plan", namedAfter: "here", workspaceId: "w1" });

  const view = yield* wide([workspace("w1", "Collie")]);

  // Last, and named after the checkout it was working in: its workspace's label went
  // with the workspace.
  const elsewhere = view.groups.at(-1)!;
  expect(elsewhere.label).toBe(`Elsewhere · ${rig.projectDir.split("/").at(-1)}`);
  expect(elsewhere.workspaceId).toBeNull();
  expect(elsewhere.active.map((r) => r.title)).toEqual(["Implement · gone"]);
  // Nothing to jump to, and no agents of its own: the panes are in a workspace this
  // session cannot reach.
  expect(elsewhere.agents).toEqual([]);
  expect(elsewhere.summary).toContain("nothing to jump to");
});

effectTest("Elsewhere is omitted when nothing of its own is still running", function* () {
  yield* inWorkspace({
    workflow: "implement",
    namedAfter: "gone",
    workspaceId: "w9",
    status: "done",
  });
  yield* inWorkspace({ workflow: "plan", namedAfter: "here", workspaceId: "w1" });

  const view = yield* wide([workspace("w1", "Collie")]);

  expect(view.groups.map((g) => g.label)).toEqual(["Collie"]);
});

effectTest("a group whose run has a question wears the warning and counts it", function* () {
  const run = yield* inWorkspace({
    workflow: "implement",
    namedAfter: "glass",
    workspaceId: "w1",
    // The step a Choice is asked from is the step that is running, which is what the
    // engine records when it stops to ask.
    step: "next",
  });
  run.record.awaiting = "next";
  yield* run.save();
  yield* writeChoice(run.dir, {
    id: "c1",
    kind: "menu",
    run: run.id,
    step: "next",
    header: "What next?",
    footer: "↑↓ move",
    items: [{ id: "Stop here", title: "Stop here" }],
  });

  const view = yield* wide([workspace("w1", "Implement · glass")]);

  expect(view.groups[0]!.glyph).toBe("⚠");
  expect(view.groups[0]!.needsYou).toBe(1);
  expect(view.groups[0]!.summary).toBe("1 running · 1 need you · next");
});

effectTest("a group keeps every agent it has; the digits are the tree's to hand out", function* () {
  // `buildView` keeps nine agents for the local board, because that is how many digits
  // there are. A group of the wide tree numbers nothing itself — `wideRows` does, down
  // the whole tree — so slicing here dropped a workspace's tenth agent from a board
  // whose whole claim is that it hides nothing.
  const run = yield* inWorkspace({
    workflow: "implement",
    namedAfter: "glass",
    workspaceId: "w1",
  });
  const agents = Array.from({ length: 10 }, (_, i) => `impl-${i + 1}`);
  for (const agent of agents) run.step("build").variants.push(variant(agent, "1-4", "x"));
  yield* run.save();

  const view = yield* wide(
    [workspace("w1", "Implement · glass")],
    agents.map((agent) => live(agent, "1-4", "working", null, "w1")),
  );

  expect(view.groups[0]!.agents.map((a) => a.agent)).toEqual(agents);
  // And none of them carries a digit of its own.
  expect(view.groups[0]!.agents.map((a) => a.key)).toEqual(agents.map(() => ""));
});

effectTest("no group, run or agent row carries a herdr id", function* () {
  yield* inWorkspace({
    workflow: "implement",
    namedAfter: "glass",
    workspaceId: "w28",
    agent: "impl-1",
  });

  const view = yield* wide(
    [workspace("w28", "⚙ Implement · glass"), workspace("w29", "Env")],
    [live("impl-1", "1-4", "working")],
  );

  const words = view.groups.flatMap((g) => [
    g.label,
    g.summary,
    ...g.active.flatMap((r) => [r.title, r.detail]),
    ...g.agents.map((a) => a.name),
    ...view.quiet,
  ]);
  // A herdr id is `w28`, `w28:t3` or `1-4`: none of them is anything a human reads.
  for (const word of words) expect(word).not.toMatch(/\bw\d+(:[a-z]\d+)?\b|\b\d+-\d+\b/);
});

test("the text view carries the marks and the live lines the app draws", () => {
  const view: WorkspaceView = {
    repo: "collie",
    cwd: "/w/collie",
    worktrees: [],
    behind: null,
    now: Date.parse("2026-09-10T12:00:00.000Z"),
    agents: [],
    extraAgents: 0,
    active: [
      {
        id: "r1",
        dir: "/state/runs/r1",
        glyph: "⚙",
        title: "Implement · steering",
        detail: "build",
        at: Date.parse("2026-09-10T11:58:00.000Z"),
        target: null,
        children: [],
        fixable: false,
        choice: null,
        needsYou: false,
        ...NO_OUTCOME,
      },
    ],
    recent: [],
  };

  const text = renderWorkspace(view, undefined, undefined, {
    marks: { r1: { ...NO_MARKS, drift: true, held: true } },
    live: {
      run: "r1",
      cards: [],
      drift: [],
      deliveries: [],
      proposals: [],
      pending: [],
      ownership: { why: "two workspaces carry this Herd's token", candidates: ["w1", "w2"] },
      news: { waiting: 0, uncertain: 0 },
    },
  });

  expect(text).toContain("↯ ⏸");
  expect(text).toContain("collie home reconcile");
  expect(text).toContain("two workspaces carry this Herd's token");
});

test("a legacy pane says Collie moved, and nothing else", () => {
  const text = renderRedirect();
  expect(text).toContain("Collie moved to the Home");
  expect(text.split("\n").filter((line) => line.trim() !== "")).toHaveLength(2);
});

test("a row says what its Run is for, what it has not proved, and what to do about it", () =>
  runEffect(
    Effect.gen(function* () {
      const store = new RunStore(rig.stateDir);
      const run = yield* store.create({
        workflow: "implement",
        cwd: rig.projectDir,
        session: rig.pluginEnv().socketPath,
        workspace: "1",
        workspaceLabel: "test",
        inputs: { plan: "fix the picker", outcome: "bug" },
        inputSources: { plan: "asked" },
        stepIds: ["build", "mr"],
        maxIterations: 1,
        namedAfter: "fix the picker",
      });
      run.record.status = "blocked";
      run.record.finished_at = "2026-09-11T12:00:00.000Z";
      run.record.halt = "evidence_missing";
      run.record.evidence_gaps = ["tests failed", "regression was never run"];
      run.record.obstacle = "tests has failed 3 times in a row the same way (exit 1).";
      run.step("mr").status = "blocked";
      run.step("mr").note = "evidence missing for outcome bug";
      yield* run.save();

      const view = yield* board([]);

      const row = view.recent.find((r) => r.id === run.id)!;
      expect(row.outcome).toBe("bug");
      expect(row.gaps).toBe(2);
      expect(row.obstacle).toContain("failed 3 times in a row");
      // A stopped Run is one a human can pick up; the row says the command that does it.
      expect(row.next).toBe("resume");
      expect(row.delivered).toBeNull();

      // And the text view a narrow pane falls back to says the same four things.
      const text = renderWorkspace(view);
      expect(text).toContain("bug · 2 evidence gap(s)");
      expect(text).toContain("failed 3 times in a row");
      expect(text).toContain(`run resume ${run.id}`);
    }),
  ));

test("a Run whose work shipped by hand says so, without its status being edited", () =>
  runEffect(
    Effect.gen(function* () {
      const store = new RunStore(rig.stateDir);
      const run = yield* store.create({
        workflow: "implement",
        cwd: rig.projectDir,
        session: rig.pluginEnv().socketPath,
        workspace: "1",
        workspaceLabel: "test",
        inputs: { plan: "add a picker" },
        inputSources: { plan: "asked" },
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "add a picker",
      });
      run.record.status = "failed";
      run.record.finished_at = "2026-09-11T12:00:00.000Z";
      yield* run.save();
      yield* recordDisposition(run.dir, {
        at: "2026-09-11T13:00:00.000Z",
        by: "mk",
        kind: "merged",
        ref: "cego/collie!43",
        note: null,
      });

      const view = yield* board([]);

      const row = view.recent.find((r) => r.id === run.id)!;
      // Both facts, on the row a person is actually looking at: how execution ended,
      // and what became of the work. Neither is edited to tidy the other away.
      expect(row.delivered).toBe("merged cego/collie!43");
      expect(row.glyph).toBe("✗");
      expect(row.detail).toContain("failed");
      expect(renderWorkspace(view)).toContain("merged cego/collie!43");
    }),
  ));

test("a filter narrows the rows that are drawn and never what is supervised", () =>
  runEffect(
    Effect.gen(function* () {
      yield* inWorkspace({ workflow: "implement", namedAfter: "one", workspaceId: "1" });
      yield* inWorkspace({ workflow: "review", namedAfter: "two", workspaceId: "2" });

      const view = yield* wide([workspace("1", "one"), workspace("2", "two")]);

      // Every workspace is walked, whatever any view is filtered down to: a board that
      // supervised only what it happened to be drawing would hide what it is not
      // looking at, which is the one thing a board may not do.
      expect(view.groups.map((g) => g.label).sort()).toEqual(["one", "two"]);
      expect(view.groups.flatMap((g) => g.active)).toHaveLength(2);

      // And every row it walked carries the outcome fields, so filtering the list can
      // never be what decides whether a Run's gaps are visible.
      for (const row of view.groups.flatMap((g) => g.active)) {
        expect(row).toHaveProperty("gaps");
        expect(row).toHaveProperty("obstacle");
      }
    }),
  ));
