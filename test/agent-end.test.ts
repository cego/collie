import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { endAgent } from "../src/agent-end";
import type { EndDeps } from "../src/agent-end";
import { Agents, agentsLayer } from "../src/agents";
import type { AgentHost } from "../src/agents";
import { foundationLayer } from "../src/engine";
import { Herdr, HerdrError } from "../src/herdr";
import type { CompactionPorts, Stopped } from "../src/compaction";
import { readControl, withControlLock } from "../src/compaction";
import { COMPACTION_PORTS } from "../src/compactors";
import { recheckPark } from "../src/park-recheck";
import { fastForward, runEffect, runEffect as runLive } from "./support/effect";
import { Rig } from "./support/recorder";
import * as Layer from "effect/Layer";
import { IGNORES_TERM, SURVIVES_HANGUP, paneTree } from "./support/pane-tree";
import { processOf, startedOf } from "../src/processes";
import { passedOver } from "../src/heal";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startCore();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const served: (state: Stopped["state"], stops: Array<string>) => CompactionPorts = (
  state,
  stops,
) => ({
  served: {
    gate: Effect.void,
    install: () => Effect.succeed({ args: [] }),
    request: () => Effect.die("unused"),
    poll: () => Effect.die("unused"),
    usage: () => Effect.die("unused"),
    stop: (target) =>
      Effect.sync(() => {
        stops.push(target.agent);
        const returned: Stopped = {
          state,
          turns: [{ thread: "th-1", turn: "tu-1", transcript: null }],
          reason: state === "quiet" ? null : "turn tu-1 still running after 30s",
          signalled: [],
          left: [],
          noted: [],
        };
        return returned;
      }),
  },
});

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

const arranged = (agent: string) =>
  new Herdr(rig.pluginEnv()).agentLaunch({
    name: agent,
    argv: ["claude"],
    cwd: rig.projectDir,
    env: {},
    labels: { run: "r1", operation: "build" },
  });

const depsOf = (over: Partial<EndDeps> = {}) => {
  const lines: Array<string> = [];
  const deps: EndDeps = {
    herdr: over.herdr ?? new Herdr(rig.pluginEnv()),
    ports: {},
    stateDir: rig.stateDir,
    log: (line) => Effect.sync(() => void lines.push(line)),
    ...over,
  };
  return { deps, lines };
};

const terminalKills = Effect.map(
  Effect.suspend(() => rig.calls()),
  (calls) =>
    Arr.map(
      Arr.filter(calls, (call) => call.cmd === "terminal.kill"),
      (call) => call.params?.terminal,
    ),
);

test("a Claude agent ends: its core terminal closes and the end is logged", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      const { deps, lines } = depsOf();
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Run was stopped",
        "close",
      );
      expect(ended._tag).toBe("Closed");
      expect(yield* terminalKills).toEqual([terminalId]);
      expect(lines).toEqual([
        "impl: Quiet not confirmed: no process of its pane could be named",
        "impl ended: its Run was stopped",
      ]);
    }),
  ));

test("an agent ended before its compaction completes records it cancelled, and nothing waits on it afterwards", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.stateDir}/compaction/impl`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/control.json`,
        asJson({
          agent: "impl",
          harness: "claude",
          cwd: rig.projectDir,
          dir,
          attempt: {
            id: "impl-1",
            run: "r1",
            step: "02-ui",
            deadline: 1,
            asked: 1,
            session: "s-1",
          },
        }),
      );
      const { deps, lines } = depsOf({ ports: { claude: COMPACTION_PORTS.claude! } });
      yield* endAgent(deps, { agent: "impl", terminalId }, "its Run was stopped", "close");
      const record = yield* readControl(rig.stateDir, "impl");
      const written = yield* fs.readFileString(`${dir}/events.jsonl`);
      expect(record?.attempt).toBeNull();
      expect(written).toContain('"kind":"cancelled"');
      expect(lines).toContain("impl: compaction impl-1 was cancelled (its Run was stopped)");
    }),
  ));

test("a close that fails leaves the agent's compaction as it found it, so nothing is cancelled that may still finish", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.stateDir}/compaction/impl`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/control.json`,
        asJson({
          agent: "impl",
          harness: "claude",
          cwd: rig.projectDir,
          dir,
          attempt: {
            id: "impl-1",
            run: "r1",
            step: "02-ui",
            deadline: 1,
            asked: 1,
            session: "s-1",
          },
        }),
      );
      const { deps } = depsOf({
        ports: { claude: COMPACTION_PORTS.claude! },
        herdr: {
          agentList: () => new Herdr(rig.pluginEnv()).agentList(),
          terminalRoot: (pane) => new Herdr(rig.pluginEnv()).terminalRoot(pane),
          terminalKill: () =>
            Effect.fail(new HerdrError({ message: "the pane refused", detail: "" })),
        },
      });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Run was stopped",
        "close",
      ).pipe(Effect.result);
      expect(ended._tag).toBe("Failure");
      const record = yield* readControl(rig.stateDir, "impl");
      expect(record?.attempt?.id).toBe("impl-1");
      const events = yield* fs
        .readFileString(`${dir}/events.jsonl`)
        .pipe(Effect.orElseSucceed(() => ""));
      expect(events).not.toContain('"kind":"cancelled"');
    }),
  ));

test("a Codex agent that does not become Quiet keeps its terminal, in ADR-0059's words", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      yield* serverFor("impl");
      const stops: Array<string> = [];
      const { deps, lines } = depsOf({ ports: served("acknowledged", stops) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Run was stopped",
        "close",
      );
      expect(stops).toEqual(["impl"]);
      expect(ended).toMatchObject({ _tag: "NotQuiet" });
      expect(ended._tag === "NotQuiet" && ended.reason).toStartWith(
        "impl is not stopped: acknowledged, turn tu-1 still running after 30s — thread th-1 turn tu-1",
      );
      expect(yield* terminalKills).toEqual([]);
      expect(Arr.some(lines, (line) => pipe_(line, Str.includes("ended")))).toBe(false);
    }),
  ));

test("an agent whose launch recorded no terminal is unprovable, and left running", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl");
      yield* serverFor("impl");
      const stops: Array<string> = [];
      const { deps } = depsOf({ ports: served("quiet", stops) });
      const ended = yield* endAgent(deps, { agent: "impl" }, "its Run was stopped", "close");
      expect(ended).toEqual({
        _tag: "Unprovable",
        reason: "impl cannot be proven to be this Run's, so it was left running",
      });
      expect(stops).toEqual([]);
      expect(yield* terminalKills).toEqual([]);
    }),
  ));

test("a managed agent's work becomes Quiet before its core terminal ends", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      yield* serverFor("impl");
      const stops: Array<string> = [];
      const herdr = new Herdr(rig.pluginEnv());
      const { deps, lines } = depsOf({
        ports: served("quiet", stops),
        herdr: {
          agentList: () => herdr.agentList(),
          terminalRoot: (address) => herdr.terminalRoot(address),
          terminalKill: (terminal) =>
            Effect.gen(function* () {
              expect(stops).toEqual(["impl"]);
              yield* herdr.terminalKill(terminal);
            }),
        },
      });
      expect(yield* endAgent(deps, { agent: "impl", terminalId }, "stopped", "close")).toEqual({
        _tag: "Closed",
        ended: true,
      });
      expect(yield* terminalKills).toEqual([terminalId]);
      expect(lines).toContain("impl ended: stopped");
    }),
  ));

test("an unreadable core agent list closes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      const { deps } = depsOf({
        herdr: {
          agentList: () => Effect.fail(new HerdrError({ message: "core unavailable", detail: "" })),
          terminalKill: () => Effect.die("no terminal may close without ownership proof"),
          terminalRoot: () => Effect.die("no root is read without ownership proof"),
        },
      });
      const ended = yield* endAgent(deps, { agent: "impl", terminalId }, "stopped", "close").pipe(
        Effect.result,
      );
      expect(Result.isFailure(ended) && ended.failure._tag).toBe("AgentsUnlisted");
      expect(yield* terminalKills).toEqual([]);
    }),
  ));

test("another process under the agent's name is left alone, without a word", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl");
      const terminalId = "previous-terminal";

      yield* serverFor("impl");
      const stops: Array<string> = [];
      const { deps, lines } = depsOf({ ports: served("quiet", stops) });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Run was stopped",
        "close",
      );
      expect(ended).toMatchObject({ _tag: "Closed", ended: false });
      expect(stops).toEqual([]);
      expect(yield* terminalKills).toEqual([]);
      expect(lines).toEqual([]);
    }),
  ));

test("where the caller ends the terminals, none closes while one agent of several is not Quiet", () =>
  runEffect(
    Effect.gen(function* () {
      const terminalId = yield* arranged("impl");
      const reviewTerminal = yield* arranged("review");
      yield* serverFor("review");
      const stops: Array<string> = [];
      const { deps, lines } = depsOf({ ports: served("acknowledged", stops) });
      const quiet = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Task ended",
        "caller",
      );
      const busy = yield* endAgent(
        deps,
        { agent: "review", terminalId: reviewTerminal },
        "its Task ended",
        "caller",
      );
      expect(quiet._tag).toBe("Closed");
      expect(busy._tag).toBe("NotQuiet");
      expect(stops).toEqual(["review"]);
      expect(yield* terminalKills).toEqual([]);
      expect(Arr.filter(lines, (line) => pipe_(line, Str.includes("ended")))).toEqual([]);
    }),
  ));

test("where the caller ends the terminals, another process under the agent's name keeps them open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged("impl");
      const terminalId = "previous-terminal";

      const { deps } = depsOf();
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId },
        "its Task ended",
        "caller",
      );
      expect(ended).toEqual({
        _tag: "Replaced",
        reason: "impl was started again since, and is not this Run's to end",
      });
    }),
  ));

const paneOn = (shell: number) =>
  Effect.gen(function* () {
    (yield* rig.startCore()).runsAs(shell);
    return yield* arranged("impl");
  });

const agentsWith = (stopMs: number) =>
  agentsLayer({
    dir: rig.stateDir,
    env: rig.pluginEnv(),
    herdr: new Herdr(rig.pluginEnv()),
    harness: "claude",
    model: "opus",
    permissions: "auto",
    compactAtTokens: 0,
    help: () => Effect.succeed(""),
    stopMs,
  }).pipe(Layer.provideMerge(foundationLayer({ dir: rig.stateDir })));

test("a Claude agent whose terminal leaves a child running after its close ends Closed only once the escalation has stopped it", () =>
  runEffect(
    Effect.gen(function* () {
      const tree = yield* paneTree(SURVIVES_HANGUP);
      const terminalId = yield* paneOn(tree.shell);
      const { deps } = depsOf({ stopMs: 3000 });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId, harness: "claude" },
        "it ran out",
        "close",
      );
      expect(yield* processOf(tree.child)).toBeNull();
      expect(ended).toEqual({ _tag: "Closed", ended: true });
      expect(yield* terminalKills).toEqual([terminalId]);
    }).pipe(Effect.scoped),
  ));

test("a Pi agent whose terminal leaves a child that will not stop is not Quiet, and its Fallback parks on predecessor-not-quiet, which no Heal takes", () =>
  runEffect(
    Effect.gen(function* () {
      const tree = yield* paneTree(IGNORES_TERM);
      const terminalId = yield* paneOn(tree.shell);
      const retired = yield* Agents.pipe(
        Effect.flatMap((agents) =>
          agents.retire({ ...launchedImpl, harness: "pi", terminalId }, "ran out"),
        ),
        Effect.flip,
        Effect.provide(agentsWith(500)),
        Effect.scoped,
      );
      expect(yield* processOf(tree.child)).not.toBeNull();
      expect(retired.cause).toBe("predecessor-not-quiet");
      expect(retired.reason).toContain(`impl is not Quiet: pid ${tree.child} of its pane`);
      expect(
        passedOver({
          cause: "predecessor-not-quiet",
          isHeal: false,
          on: true,
          waitsOnYou: false,
          recoveries: [],
        }),
      ).toBe("only what its recheck reads can clear its cause");
    }).pipe(Effect.scoped),
  ));

test("an agent whose pane has already gone still has the session its start recorded stopped", () =>
  runEffect(
    Effect.gen(function* () {
      const tree = yield* paneTree(SURVIVES_HANGUP);
      const root = {
        pid: tree.shell,
        started: (yield* startedOf(tree.shell))!,
      };
      process.kill(tree.shell, "SIGHUP");
      while ((yield* processOf(tree.shell)) !== null) {
        yield* Effect.sleep(10);
      }
      const { deps, lines } = depsOf({ stopMs: 3000 });
      const ended = yield* endAgent(
        deps,
        { agent: "impl", terminalId: "term-impl", harness: "claude", root },
        "it ran out",
        "close",
      );
      expect(yield* processOf(tree.child)).toBeNull();
      expect(ended).toEqual({ _tag: "Closed", ended: true });
      expect(lines).toEqual(["impl ended: it ran out"]);
    }).pipe(Effect.scoped),
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
      yield* arranged("impl");
      const retired = yield* Agents.pipe(
        Effect.flatMap((agents) => agents.retire(launchedImpl, "build: impl ran out")),
        Effect.flip,
        Effect.provide(
          agentsLayer({
            dir: rig.stateDir,
            env: rig.pluginEnv(),
            herdr: new Herdr(rig.pluginEnv()),
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
      expect(retired.cause).toBe("predecessor-unproven");
      expect(retired.reason).toBe(
        "impl ran out and must stop before another agent takes its work, but it cannot be proven to be this Run's, so it was left running. Close it and resume.",
      );
      expect(yield* terminalKills).toEqual([]);
    }),
  ));

const retireLayer = (over: Partial<AgentHost> = {}) =>
  agentsLayer({
    dir: rig.stateDir,
    env: rig.pluginEnv(),
    herdr: over.herdr ?? new Herdr(rig.pluginEnv()),
    harness: "claude",
    model: "opus",
    permissions: "auto",
    compactAtTokens: 0,
    help: () => Effect.succeed(""),
    stopMs: 500,
    ...over,
  }).pipe(Layer.provideMerge(foundationLayer({ dir: rig.stateDir })));

const retireFlipped = (
  launched: { readonly terminalId?: string; readonly harness?: string },
  over?: Partial<AgentHost>,
) =>
  Agents.pipe(
    Effect.flatMap((agents) =>
      agents.retire({ ...launchedImpl, ...launched }, "build: impl ran out"),
    ),
    Effect.flip,
    Effect.provide(retireLayer(over)),
    Effect.scoped,
  );

class Unlisting extends Herdr {
  constructor() {
    super(rig.pluginEnv());
  }
  override agentList() {
    const refused: ReturnType<Herdr["agentList"]> = Effect.fail(
      new HerdrError({ message: "core is down", detail: "no answer", code: "unavailable" }),
    );
    return refused;
  }
}

test("a Fallback's close parks herdr-unavailable when core cannot list its agents", () =>
  runEffect(
    Effect.gen(function* () {
      const retired = yield* retireFlipped({ terminalId: "term-impl" }, { herdr: new Unlisting() });
      expect(retired.cause).toBe("herdr-unavailable");
      expect(retired.reason).toContain("core cannot say whether it is running");
      expect(yield* terminalKills).toEqual([]);
    }),
  ));

test("a Fallback's close parks on a pane that will not close with a cause that needs you, and never unknown", () =>
  runEffect(
    Effect.gen(function* () {
      (yield* rig.startCore()).refuse("terminal.kill", "unavailable", "core refused the kill");
      const terminalId = yield* arranged("impl");
      const stopped = yield* retireFlipped({ terminalId });
      expect(stopped.cause).toBe("predecessor-unproven");
      expect(stopped.reason).toContain("would not close");
    }),
  ));

test("a Fallback's close parks on locked controls, which its recheck clears once they are free", () =>
  runLive(
    fastForward(
      Effect.gen(function* () {
        const terminalId = yield* arranged("impl");
        yield* serverFor("impl");
        const ports = served("quiet", []);
        const view = {
          runId: "r1",
          cwd: rig.projectDir,
          branch: null,
          mr: null,
          park: { cause: "predecessor-locked" as const, kind: "rechecks" as const },
        };
        const recheck = {
          agentList: () => Effect.die("a predecessor's recheck asks core nothing"),
        };
        const held = yield* withControlLock(
          rig.stateDir,
          "impl",
          Effect.gen(function* () {
            const retired = yield* retireFlipped({ terminalId }, { ports });
            return {
              retired,
              whileHeld: yield* recheckPark(view, rig.stateDir, recheck).pipe(
                Effect.provide(retireLayer()),
              ),
            };
          }),
        );
        expect(held.retired.cause).toBe("predecessor-locked");
        expect(held.whileHeld).toMatchObject({ cleared: false });
        expect(
          yield* recheckPark(view, rig.stateDir, recheck).pipe(Effect.provide(retireLayer())),
        ).toMatchObject({ cleared: true });
      }),
    ),
  ));

test("a ticket's agent whose pane leaves a child that will not stop parks its boundary on predecessor-not-quiet, saying it finished its ticket", () =>
  runEffect(
    Effect.gen(function* () {
      const tree = yield* paneTree(IGNORES_TERM);
      const terminalId = yield* paneOn(tree.shell);
      const retired = yield* Agents.pipe(
        Effect.flatMap((agents) =>
          agents.retire(
            { ...launchedImpl, harness: "pi", terminalId },
            "02-second.md: impl finished 01-first.md; build-02-second takes its work over",
            "finished 01-first.md",
          ),
        ),
        Effect.flip,
        Effect.provide(agentsWith(500)),
        Effect.scoped,
      );
      expect(yield* processOf(tree.child)).not.toBeNull();
      expect(retired.cause).toBe("predecessor-not-quiet");
      expect(retired.reason).toContain(
        "It finished 01-first.md, and no agent takes its work until it has stopped",
      );
    }).pipe(Effect.scoped),
  ));

test.each([
  "02-second.md: impl finished 01-first.md; build-02-second takes its work over",
  "mr: impl finished 02-second.md; deliver takes its work over",
])(
  "a check a ticket's agent left running in the background is stopped before the close of %s succeeds",
  (line) =>
    runEffect(
      Effect.gen(function* () {
        const tree = yield* paneTree(SURVIVES_HANGUP);
        const terminalId = yield* paneOn(tree.shell);
        yield* Agents.pipe(
          Effect.flatMap((agents) =>
            agents.retire({ ...launchedImpl, terminalId }, line, "finished its ticket"),
          ),
          Effect.provide(agentsWith(3000)),
          Effect.scoped,
        );
        expect(yield* processOf(tree.child)).toBeNull();
        expect(yield* terminalKills).toEqual([terminalId]);
      }).pipe(Effect.scoped),
    ),
);
