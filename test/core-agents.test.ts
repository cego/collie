// A Run's agents on a Machine set to herdr-core: launched, given their work, read and
// stopped through core's own API on the rig's fake core, which takes a prompt the way a
// harness does. The rest of the host is real: the dispatcher, its ledger and the engine.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { PlatformServices } from "../src/platform";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { foundationLayer } from "../src/engine";
import type { Collecting } from "../src/collecting";
import type { Store } from "../src/store";
import { agentName } from "../src/naming";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { asRun, enveloped } from "./support/enveloped";
import { forgeHttpOnPath } from "./support/forge";
import type { FakeHc } from "./support/fake-hc";
import { until } from "./support/host";
import { deliveriesOf, machineHerd } from "../src/steering";

let rig: Rig;
let dir: string;

beforeEach(() =>
  runLive(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() => runLive(rig.close()));

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const Verdict = Schema.Struct({ verdict: Schema.String });

const work = enveloped({ name: "core-work", input: {}, success: Verdict });
const body = work.toLayer((payload) =>
  agentWork({
    operation: "review",
    role: "reviewer",
    workflow: "core-work",
    cwd: rig.projectDir,
    instructions: "Review the diff.",
    output: Verdict,
  }).pipe(asRun(payload)),
);

/** A review, then a fix by another agent: two launches in one Run. */
const twoAgents = enveloped({ name: "core-two", input: {}, success: Schema.Array(Verdict) });
const twoAgentsBody = twoAgents.toLayer((payload) =>
  Effect.gen(function* () {
    const step = (operation: string, role: string) =>
      agentWork({
        operation,
        role,
        workflow: "core-two",
        cwd: rig.projectDir,
        instructions: `${operation} the diff.`,
        output: Verdict,
      });
    return [yield* step("review", "reviewer"), yield* step("fix", "implementer")];
  }).pipe(asRun(payload)),
);

const CLAUDE_HELP = "  --autocompact <auto|tokens>           Auto-compact window size";

/** This Machine set to `backend`, with the fake core where core's own socket would be. */
const onMachine = (backend: "herdr" | "core") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const userDir = rig.pluginEnv().userDir;
    yield* fs.makeDirectory(userDir, { recursive: true });
    yield* fs.writeFileString(
      `${userDir}/config.json`,
      `{ "compact_at_tokens": 0, "trust": "never", "terminal_backend": "${backend}" }`,
    );
  });

const hostOf = (env: Record<string, string>): AgentHost => ({
  dir,
  env: rig.pluginEnv(env),
  herdr: new FakeHerdr(rig.pluginEnv(env)),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
  help: () => Effect.succeed(CLAUDE_HELP),
  version: () => Effect.succeed("2.1.309 (Claude Code)"),
});

/** The core this Machine's agents run on, and nothing of herdr's: no herdr session is open. */
const coreOnly = (core: FakeHc) => ({ HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: "" });

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | Collecting | Store | PlatformServices
  >,
  env: Record<string, string>,
  workflows: typeof body = body,
) =>
  run.pipe(
    Effect.provide(
      workflows.pipe(
        Layer.provideMerge(agentsLayer(hostOf(env)).pipe(Layer.provide(forgeHttpOnPath))),
        Layer.provideMerge(foundationLayer({ dir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const coreCalls = (calls: ReadonlyArray<Call>) =>
  Arr.filter(calls, (call) => call.transport === "core");
const position = (calls: ReadonlyArray<Call>, cmd: string) =>
  Arr.findFirstIndex(calls, (call) => call.cmd === cmd).pipe(Option.getOrElse(() => -1));

test("a Run on a core Machine launches, prompts, reads and stops its Claude agent through core alone", () =>
  runEffect(
    Effect.gen(function* () {
      const core = yield* rig.startCore();
      yield* onMachine("core");
      yield* rig.queueOutputs([{ verdict: "clean" }]);
      const env = coreOnly(core);
      const result = yield* session(
        Effect.gen(function* () {
          const done = yield* work.execute({ runId: "r1", input: {} }).pipe(Effect.result);
          yield* (yield* Agents).halt("r1");
          return done;
        }),
        env,
      );
      expect(result._tag === "Success" && result.success).toEqual({ verdict: "clean" });

      const calls = yield* rig.calls();
      expect(Arr.filter(calls, (call) => call.transport !== "core")).toEqual([]);
      const onCore = coreCalls(calls);
      const agent = agentName("r1", "review", null, 1);
      const runs = Arr.filter(onCore, (call) => call.cmd === "terminal.run");
      expect(runs).toHaveLength(1);
      const launched = runs[0]?.params ?? {};
      expect(launched).toMatchObject({
        name: agent,
        labels: { run: "r1", operation: "review" },
        cwd: rig.projectDir,
        no_parent: true,
      });
      expect(launched).not.toHaveProperty("keep");
      expect(launched).not.toHaveProperty("on");
      const send = Option.getOrUndefined(
        Arr.findFirst(onCore, (call) => call.cmd === "terminal.send"),
      );
      expect(send?.params).toMatchObject({ terminal: agent });
      expect(send?.params?.text).toEqual(expect.stringContaining("review.prompt.md"));
      const ran = position(onCore, "terminal.run");
      const sent = position(onCore, "terminal.send");
      const read = position(onCore, "events.subscribe");
      const killed = position(onCore, "terminal.kill");
      expect(ran).toBeGreaterThanOrEqual(0);
      expect(sent).toBeGreaterThan(ran);
      expect(read).toBeGreaterThan(sent);
      expect(killed).toBeGreaterThan(read);
      expect(Arr.filter(onCore, (call) => call.cmd === "terminal.get")).toEqual([]);
    }),
  ));

test("a Machine switched to core mid-Run keeps its running agent on herdr and starts its next one on core", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.startSocket();
      const core = yield* rig.startCore();
      yield* onMachine("herdr");
      const userDir = rig.pluginEnv().userDir;
      // The reviewer is working on herdr when its Machine is switched, and its Output needs a repair.
      yield* rig.queueOutputs([
        {
          writes: [
            {
              path: `${userDir}/config.json`,
              text: `{ "compact_at_tokens": 0, "trust": "never", "terminal_backend": "core" }`,
            },
          ],
          output: { verdict: 7 },
        },
        { verdict: "clean" },
        { verdict: "fixed" },
      ]);
      const result = yield* session(
        twoAgents.execute({ runId: "r1", input: {} }).pipe(Effect.result),
        { HC_SOCKET: core.socketPath },
        twoAgentsBody,
      );
      expect(result._tag === "Success" && result.success).toEqual([
        { verdict: "clean" },
        { verdict: "fixed" },
      ]);

      const calls = yield* rig.calls();
      const reviewer = agentName("r1", "review", null, 1);
      const fixer = agentName("r1", "fix", null, 1);
      const prompts = Arr.filter(
        Arr.map(calls, (call, at) => ({ call, at })),
        ({ call }) => call.cmd === "agent prompt",
      );
      expect(Arr.map(prompts, ({ call }) => call.argv?.[2])).toEqual([reviewer, reviewer]);
      expect(pipe(prompts[1]?.call.argv?.[3] ?? "", Str.includes("repair"))).toBe(true);
      expect(Arr.filter(calls, (call) => call.cmd === "agent start")).toHaveLength(1);
      const runs = Arr.filter(
        Arr.map(calls, (call, at) => ({ call, at })),
        ({ call }) => call.cmd === "terminal.run",
      );
      expect(Arr.map(runs, ({ call }) => call.params?.name)).toEqual([fixer]);
      expect(runs[0]!.at).toBeGreaterThan(prompts[1]!.at);
      expect(
        Arr.map(
          Arr.filter(coreCalls(calls), (call) => call.cmd === "terminal.send"),
          (call) => call.params?.terminal,
        ),
      ).toEqual([fixer]);
    }),
  ));

test("a send core refuses because its agent is blocked is held as herdr's agent_blocked is, and goes once it is idle", () =>
  runEffect(
    Effect.gen(function* () {
      const core = yield* rig.startCore();
      yield* onMachine("core");
      yield* rig.queueOutputs([{ verdict: "clean" }]);
      core.startBlocked();
      const running = yield* Effect.forkChild(
        session(work.execute({ runId: "r1", input: {} }).pipe(Effect.result), coreOnly(core)),
      );
      const held = yield* until(
        () => deliveriesOf(rig.stateDir, "r1"),
        (found) => Arr.some(found, ({ delivery }) => delivery.state === "deferred"),
      );
      expect(
        Arr.map(
          Arr.filter(held, ({ delivery }) => delivery.state === "deferred"),
          ({ delivery }) => delivery.code,
        ),
      ).toEqual(["agent_blocked"]);
      yield* core.report(agentName("r1", "review", null, 1), "idle");
      const result = yield* Fiber.join(running);
      expect(result._tag === "Success" && result.success).toEqual({ verdict: "clean" });
      const sends = Arr.filter(
        coreCalls(yield* rig.calls()),
        (call) => call.cmd === "terminal.send",
      );
      expect(sends.length).toBeGreaterThanOrEqual(2);
    }),
  ));

test("a send core says did not start gets one Enter, and the Run's log says so", () =>
  runEffect(
    Effect.gen(function* () {
      const core = yield* rig.startCore();
      yield* onMachine("core");
      yield* rig.queueOutputs([{ verdict: "clean" }]);
      core.stallNextSend();
      const result = yield* session(
        work.execute({ runId: "r1", input: {} }).pipe(Effect.result),
        coreOnly(core),
      );
      expect(result._tag === "Success" && result.success).toEqual({ verdict: "clean" });
      const onCore = coreCalls(yield* rig.calls());
      const keys = Arr.filter(onCore, (call) => call.cmd === "terminal.keys");
      expect(Arr.map(keys, (call) => call.params?.keys)).toEqual([["enter"]]);
      expect(position(onCore, "terminal.keys")).toBeGreaterThan(position(onCore, "terminal.send"));
      const log = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/r1/agents.log`)),
      );
      expect(log).toContain("did not start a turn on core, so Enter was pressed once");
    }),
  ));

test("a core Machine's Herd is its core session's, whichever herdr session it is in", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.startSocket();
      const herds = Effect.all([
        machineHerd(rig.pluginEnv({ HC_SOCKET: `${rig.root}/one.sock` })),
        machineHerd(rig.pluginEnv({ HC_SOCKET: `${rig.root}/two.sock` })),
      ]);
      yield* onMachine("herdr");
      const [herdrOne, herdrTwo] = yield* herds;
      expect(herdrOne).toBe(herdrTwo);
      yield* onMachine("core");
      const [coreOne, coreTwo] = yield* herds;
      expect(coreOne).not.toBe(coreTwo);
      expect(coreOne).not.toBe(herdrOne);
    }),
  ));
