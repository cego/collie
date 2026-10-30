// Every end of a Run's agent, through the one module that ends one (ADR-0059 D1, D4).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema, flow, Result } from "effect";
import { endAgent, type EndDeps } from "../src/agent-end";
import { Agents, agentsLayer } from "../src/agents";
import { foundationLayer } from "../src/engine";
import { sweep, taskWorkspacesSweeper } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import { Launched } from "../src/launches";
import { runFacts } from "./support/records";
import { task as view } from "./support/task";
import type { CompactionPorts, Stopped } from "../src/compaction";
import { runEffect } from "./support/effect";
import { FakeHerdr, Rig } from "./support/recorder";
import * as Layer from "effect/Layer";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const asLaunch = flow(Schema.encodeResult(Schema.fromJsonString(Launched)), Result.getOrThrow);

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

/** A Codex-like harness whose work runs in a server, stopped to `state`. */
const served = (state: Stopped["state"], stops: string[]): CompactionPorts => ({
  served: {
    gate: Effect.void,
    install: () => Effect.succeed({ args: [] }),
    request: () => Effect.die("unused"),
    poll: () => Effect.die("unused"),
    usage: () => Effect.die("unused"),
    stop: (target) =>
      Effect.sync(() => {
        stops.push(target.agent);
        return {
          state,
          turns: [{ thread: "th-1", turn: "tu-1", transcript: null }],
          reason: state === "quiet" ? null : "turn tu-1 still running after 30s",
          signalled: [],
          left: [],
          noted: [],
        } satisfies Stopped;
      }),
  },
});

/** The control record of a served agent, whose server is this process. */
const serverFor = (agent: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${rig.stateDir}/compaction/${agent}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/control.json`,
      asJson({
        agent,
        harness: "served",
        cwd: rig.projectDir,
        dir,
        endpoint: "ws://127.0.0.1:1",
        pid: process.pid,
        command: "bun",
        started: null,
        attempt: null,
      }),
    );
  });

/** The agent's pane in a workspace that has another pane besides. */
const arranged = (agent: string, pane: string, alone = false) =>
  Effect.gen(function* () {
    yield* rig.addWorkspace("w1", "Project | Task", rig.projectDir);
    if (!alone) yield* rig.addPane("p0", "t0", rig.projectDir, null, "w1");
    yield* rig.addPane(pane, `t-${pane}`, rig.projectDir, "claude", "w1");
    yield* rig.addAgent(agent, pane);
  });

const depsOf = (over: Partial<EndDeps> = {}) => {
  const lines: string[] = [];
  const deps: EndDeps = {
    herdr: new FakeHerdr(rig.pluginEnv()),
    ports: {},
    stateDir: rig.stateDir,
    cwd: rig.projectDir,
    log: (line) => Effect.sync(() => void lines.push(line)),
    ...over,
  };
  return { deps, lines };
};

const paneCloses = Effect.map(
  Effect.suspend(() => rig.calls()),
  (calls) =>
    Arr.map(
      Arr.filter(calls, (call) => call.cmd === "pane close"),
      (call) => call.argv?.at(2),
    ),
);

test("a Claude agent ends: nothing runs outside its pane, its pane closes, and the end is logged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      const { deps, lines } = depsOf();
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Run was stopped",
        "close",
      );
      expect(ended._tag).toBe("Closed");
      expect(yield* paneCloses).toEqual(["p1"]);
      expect(lines).toEqual(["impl ended: its Run was stopped"]);
    }),
  ));

test("a Codex agent that does not become Quiet keeps its pane, in ADR-0059's words", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* serverFor("impl");
      const stops: string[] = [];
      const { deps, lines } = depsOf({ ports: served("acknowledged", stops) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Run was stopped",
        "close",
      );
      expect(stops).toEqual(["impl"]);
      expect(ended).toMatchObject({ _tag: "NotQuiet" });
      expect(ended.reason).toStartWith(
        "impl is not stopped: acknowledged, turn tu-1 still running after 30s — thread th-1 turn tu-1",
      );
      expect(yield* paneCloses).toEqual([]);
      expect(Arr.some(lines, (line) => pipe_(line, Str.includes("ended")))).toBe(false);
    }),
  ));

test("an agent whose launch recorded no terminal is unprovable, and left running", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* serverFor("impl");
      const stops: string[] = [];
      const { deps } = depsOf({ ports: served("quiet", stops) });
      const ended = yield* endAgent(deps, { agent: "impl" }, "its Run was stopped", "close");
      expect(ended).toEqual({
        _tag: "Unprovable",
        reason: "impl cannot be proven to be this Run's, so it was left running",
      });
      expect(stops).toEqual([]);
      expect(yield* paneCloses).toEqual([]);
    }),
  ));

/** A herdr that lists every agent without the terminal it runs in. */
class NoTerminals extends FakeHerdr {
  override agentList() {
    return super
      .agentList()
      .pipe(Effect.map((agents) => Arr.map(agents, (agent) => ({ ...agent, terminalId: null }))));
  }
}

test("an agent herdr lists with no terminal is unprovable, and left running", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      const { deps } = depsOf({ herdr: new NoTerminals(rig.pluginEnv()) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Run was stopped",
        "close",
      );
      expect(ended._tag).toBe("Unprovable");
      expect(yield* paneCloses).toEqual([]);
    }),
  ));

test("another process under the agent's name is left alone, without a word", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* rig.reincarnate("impl");
      yield* serverFor("impl");
      const stops: string[] = [];
      const { deps, lines } = depsOf({ ports: served("quiet", stops) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Run was stopped",
        "close",
      );
      expect(ended).toMatchObject({ _tag: "Closed", ended: false });
      expect(stops).toEqual([]);
      expect(yield* paneCloses).toEqual([]);
      expect(lines).toEqual([]);
    }),
  ));

const SESSION = { kind: "claude", value: "s-impl" };

/** A pane herdr restored on the session `impl` recorded, after `impl` was started again elsewhere. */
const restoredUnderReusedName = Effect.gen(function* () {
  yield* arranged("impl", "p1");
  yield* rig.reincarnate("impl");
  yield* serverFor("impl");
  yield* rig.addRestored({
    paneId: "p9",
    workspaceId: "w1",
    terminalId: "t-new",
    session: SESSION,
  });
});

test("a restored pane whose work is in it ends as the agent its session proves, though another has its name", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restoredUnderReusedName;
      const stops: string[] = [];
      const { deps, lines } = depsOf({ ports: served("quiet", stops) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl", agentSession: SESSION, harness: "claude" },
        "idle for 61 min",
        "close",
      );
      expect(ended).toEqual({ _tag: "Closed", ended: true });
      expect(stops).toEqual([]);
      expect(yield* paneCloses).toEqual(["p9"]);
      expect(lines).toEqual(["impl ended: idle for 61 min"]);
    }),
  ));

test("a restored pane whose work runs in a server it cannot reach, its name's controls being another's, is not Quiet and stays", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restoredUnderReusedName;
      const stops: string[] = [];
      const { deps, lines } = depsOf({ ports: served("quiet", stops) });
      for (const harness of ["served", undefined]) {
        const ended = yield* endAgent(
          deps,
          { agent: "impl", terminalId: "term-impl", agentSession: SESSION, harness },
          "idle for 61 min",
          "close",
        );
        expect(ended).toEqual({
          _tag: "NotQuiet",
          reason:
            "impl could not be stopped (its controls are those of the agent started on its name since)",
        });
      }
      expect(stops).toEqual([]);
      expect(yield* paneCloses).toEqual([]);
      expect(lines).toEqual([]);
    }),
  ));

test("without a matching session, an agent started again on the name is still left alone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* rig.reincarnate("impl");
      yield* rig.addRestored({
        paneId: "p9",
        workspaceId: "w1",
        terminalId: "t-new",
        session: { kind: "claude", value: "s-other" },
      });
      const { deps, lines } = depsOf();
      const launched = { agent: "impl", terminalId: "term-impl", agentSession: SESSION };
      expect(yield* endAgent(deps, launched, "idle", "close")).toEqual({
        _tag: "Closed",
        ended: false,
      });
      expect(yield* endAgent(deps, launched, "idle", "caller")).toEqual({
        _tag: "Replaced",
        reason: "impl was started again since, and is not this Run's to end",
      });
      expect(yield* paneCloses).toEqual([]);
      expect(lines).toEqual([]);
    }),
  ));

test("the workspace is kept when the agent's pane is its last", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1", true);
      const { deps } = depsOf();
      yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Run was stopped",
        "close",
      );
      const cmds = yield* rig.cmds();
      const kept = cmds.indexOf("tab create");
      expect(kept).toBeGreaterThanOrEqual(0);
      expect(kept).toBeLessThan(cmds.indexOf("pane close"));
      const created = Option.getOrUndefined(
        Arr.findFirst(yield* rig.calls(), (call) => call.cmd === "tab create"),
      );
      expect(created?.argv).toEqual(expect.arrayContaining(["--workspace", "w1"]));
    }),
  ));

test("where the caller closes the panes, none closes while one agent of several is not Quiet", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* rig.addPane("p2", "t-p2", rig.projectDir, "codex", "w1");
      yield* rig.addAgent("review", "p2");
      yield* serverFor("review");
      const stops: string[] = [];
      const { deps, lines } = depsOf({ ports: served("acknowledged", stops) });
      const quiet = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Task's workspace closed",
        "caller",
      );
      const busy = yield* endAgent(
        deps,
        { agent: "review", terminalId: "term-review" },
        "its Task's workspace closed",
        "caller",
      );
      expect(quiet._tag).toBe("Closed");
      expect(busy._tag).toBe("NotQuiet");
      expect(stops).toEqual(["review"]);
      expect(yield* paneCloses).toEqual([]);
      // Its end is the caller's to log, once its pane has closed.
      expect(Arr.filter(lines, (line) => pipe_(line, Str.includes("ended")))).toEqual([]);
    }),
  ));

test("where the caller closes the panes, another process under the agent's name keeps them open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      yield* rig.reincarnate("impl");
      const { deps } = depsOf();
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl" },
        "its Task's workspace closed",
        "caller",
      );
      expect(ended).toEqual({
        _tag: "Replaced",
        reason: "impl was started again since, and is not this Run's to end",
      });
    }),
  ));

const launchedImpl = {
  agent: "impl",
  output: "out.json",
  reused: false,
  runId: "r1",
  operation: "build",
  role: "implementer",
  workflow: "implement",
  harness: "claude",
} as const;

test("a Fallback's close parks on an agent it cannot prove is this Run's, and closes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl", "p1");
      const retired = yield* Agents.pipe(
        Effect.flatMap((agents) => agents.retire(launchedImpl, "build: impl ran out")),
        Effect.flip,
        Effect.provide(
          agentsLayer({
            dir: rig.stateDir,
            env: rig.pluginEnv(),
            herdr: new FakeHerdr(rig.pluginEnv()),
            harness: "claude",
            model: "opus",
            permissions: "auto",
            compactAtTokens: 0,
            help: () => Effect.succeed(""),
          }).pipe(
            Layer.provideMerge(
              foundationLayer({
                dir: rig.stateDir,
              }),
            ),
          ),
        ),
        Effect.scoped,
      );
      expect(retired.reason).toBe(
        "impl ran out and must stop before another agent takes its work, but it cannot be proven to be this Run's, so it was left running. Close it and resume.",
      );
      expect(yield* paneCloses).toEqual([]);
    }),
  ));

/** The launch record of `launched` in its Run's directory. */
const recorded = (launched: Launched) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${rig.stateDir}/agents/${launched.runId}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/${launched.operation}.launch.json`, asLaunch(launched));
  });

const runLog = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${rig.stateDir}/agents/${runId}/agents.log`)),
    Effect.orElseSucceed(() => ""),
  );

test("the Task workspace sweep's ends are on the Run's log", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wT", "Project | Picker", rig.projectDir);
      yield* rig.addPane("wT-p1", "wT-t1", rig.projectDir, null, "wT");
      yield* rig.addPane("wT-p2", "wT-t1", rig.projectDir, "claude", "wT");
      yield* rig.addAgent("impl", "wT-p2", "t-wT-p2");
      yield* recorded({ ...launchedImpl, terminalId: "t-wT-p2" });
      const now = yield* Clock.currentTimeMillis;
      const swept = yield* sweep(
        [
          taskWorkspacesSweeper({
            stateDir: rig.stateDir,
            sessions: [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }],
            tasks: [
              {
                id: "task-1",
                workspace: "wT",
                label: "Project | Picker",
                cwd: rig.projectDir,
                root_pane: "wT-p1",
                created_at: "2026-10-07T00:00:00.000Z",
              },
            ],
            views: [view({ id: "task-1", state: "done", landed: true })],
            runs: [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
            seen: new Map([["task-1", now - 2 * 60 * 60_000]]),
          }),
        ],
        rig.stateDir,
        "host",
      );
      expect(Arr.map(swept.remove, (item) => item.target)).toEqual(["wT"]);
      expect(yield* runLog("r1")).toContain("impl ended: its Task's workspace closed");
    }),
  ));
