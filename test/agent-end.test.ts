import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema, flow, Result } from "effect";
import { endAgent } from "../src/agent-end";
import type { EndDeps } from "../src/agent-end";
import { Agents, agentsLayer } from "../src/agents";
import { foundationLayer } from "../src/engine";
import { Herdr, HerdrError } from "../src/herdr";
import type { CompactionPorts, Stopped } from "../src/compaction";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import * as Layer from "effect/Layer";

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
    herdr: new Herdr(rig.pluginEnv()),
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
      expect(lines).toEqual(["impl ended: its Run was stopped"]);
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
      expect(retired.reason).toBe(
        "impl ran out and must stop before another agent takes its work, but it cannot be proven to be this Run's, so it was left running. Close it and resume.",
      );
      expect(yield* terminalKills).toEqual([]);
    }),
  ));
