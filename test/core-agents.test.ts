// A Run's agents on a Machine set to herdr-core: launched, given their work, read and
// stopped through core's own API on the rig's fake core, which takes a prompt the way a
// harness does. The rest of the host is real: the dispatcher, its ledger and the engine.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import type * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { PlatformServices } from "../src/platform";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { foundationLayer } from "../src/engine";
import type { Collecting } from "../src/collecting";
import { Store } from "../src/store";
import { hostLockOf } from "../src/lock";
import { agentName } from "../src/naming";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { asRun, enveloped } from "./support/enveloped";
import { forgeHttpOnPath } from "./support/forge";
import type { FakeHc } from "./support/fake-hc";
import { until } from "./support/host";
import { deliveriesOf, herdOf, machineHerd } from "../src/steering";
import { liveHerds } from "../src/herds";
import { askWith, piTools } from "./support/pi";
import { isString } from "../src/schema";

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

/** A review, then a fix, by one OpenCode agent: its first prompt goes at launch, its second as a send. */
const opencodeWork = enveloped({
  name: "core-opencode",
  input: {},
  success: Schema.Array(Verdict),
});
const opencodeBody = opencodeWork.toLayer((payload) =>
  Effect.gen(function* () {
    const step = (operation: string) =>
      agentWork({
        operation,
        role: "implementer",
        agent: "builder",
        harness: "opencode",
        workflow: "core-opencode",
        cwd: rig.projectDir,
        instructions: `${operation} the diff.`,
        output: Verdict,
      });
    return [yield* step("review"), yield* step("fix")];
  }).pipe(asRun(payload)),
);

/** What an OpenCode launch on core carries, as the fake core logged it. */
const OpenCodeLaunch = Schema.Struct({
  argv: Schema.Array(Schema.String),
  env: Schema.Struct({
    OPENCODE_CONFIG_CONTENT: Schema.fromJsonString(
      Schema.Struct({
        theme: Schema.String,
        plugin: Schema.Array(Schema.String),
        mcp: Schema.Struct({
          collie: Schema.Struct({ type: Schema.String, enabled: Schema.Boolean }),
        }),
      }),
    ),
  }),
});
const LaunchedSession = Schema.fromJsonString(
  Schema.Struct({
    at: Schema.Finite,
    agentSession: Schema.Struct({ kind: Schema.String, value: Schema.String }),
  }),
);

/** The part of an OpenCode plugin OpenCode calls, as the reporter exports it. */
interface OpenCodePlugin {
  readonly CollieStatus: () => Promise<{
    readonly event: (input: { readonly event: Schema.Json }) => Promise<void>;
  }>;
}

const PiLaunch = Schema.Struct({ argv: Schema.Array(Schema.String) });

/** One step by a pi agent, which asks the human before it writes anything. */
const piWork = enveloped({ name: "core-pi", input: {}, success: Verdict });
const piBody = piWork.toLayer((payload) =>
  agentWork({
    operation: "review",
    role: "reviewer",
    agent: "builder",
    harness: "pi",
    workflow: "core-pi",
    cwd: rig.projectDir,
    instructions: "Review the diff.",
    output: Verdict,
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
  // The helper a pi agent's question tool runs, from source.
  self: [process.execPath, `${import.meta.dir}/../src/main.ts`],
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

test("an OpenCode agent on core is launched with its reporter and its first prompt, and sent nothing before it reports idle", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const core = yield* rig.startCore();
      yield* onMachine("core");
      const sessionFile = `${dir}/agents/r1/review.session`;
      // The reporter writes the session id once OpenCode opens the session, before any Output.
      yield* rig.queueOutputs([
        { writes: [{ path: sessionFile, text: "ses_review" }], output: { verdict: "clean" } },
        { verdict: "fixed" },
      ]);
      const result = yield* session(
        opencodeWork.execute({ runId: "r1", input: {} }).pipe(Effect.result),
        {
          ...coreOnly(core),
          OPENCODE_CONFIG_CONTENT: '{"theme":"night","plugin":["their-plugin"]}',
        },
        opencodeBody,
      );
      expect(result._tag === "Success" && result.success).toEqual([
        { verdict: "clean" },
        { verdict: "fixed" },
      ]);

      const onCore = coreCalls(yield* rig.calls());
      const agent = agentName("r1", "builder", null, 1);
      const runs = Arr.filter(onCore, (call) => call.cmd === "terminal.run");
      expect(Arr.map(runs, (call) => call.params?.name)).toEqual([agent]);
      const { argv, env } = yield* Schema.decodeUnknownEffect(OpenCodeLaunch)(runs[0]?.params);
      expect(argv[0]).toBe("opencode");
      expect(argv[argv.indexOf("--prompt") + 1]).toEqual(
        expect.stringContaining("review.prompt.md"),
      );
      const content = env.OPENCODE_CONFIG_CONTENT;
      expect(content.theme).toBe("night");
      expect(content.mcp.collie).toEqual({ type: "local", enabled: true });
      expect(content.plugin).toHaveLength(2);
      expect(content.plugin[0]).toBe("their-plugin");
      yield* fs.remove(sessionFile);
      const reporter = yield* Effect.promise(
        (): Promise<OpenCodePlugin> =>
          import(pipe(content.plugin[1] ?? "", Str.replace("file://", ""))),
      );
      const hooks = yield* Effect.promise(() => reporter.CollieStatus());
      yield* Effect.promise(() =>
        hooks.event({
          event: { type: "session.created", properties: { info: { id: "ses_new" } } },
        }),
      );
      expect(yield* fs.readFileString(sessionFile)).toBe("ses_new");

      const sends = Arr.filter(onCore, (call) => call.cmd === "terminal.send");
      expect(Arr.map(sends, (call) => call.params?.terminal)).toEqual([agent]);
      expect(sends[0]?.params?.text).toEqual(expect.stringContaining("fix.prompt.md"));
      const firstIdle = Arr.findFirstIndex(
        onCore,
        (call) =>
          call.cmd === "reported" &&
          call.params?.terminal === agent &&
          call.params?.state === "idle",
      ).pipe(Option.getOrElse(() => Infinity));
      expect(position(onCore, "terminal.send")).toBeGreaterThan(firstIdle);

      const launched = yield* Schema.decodeEffect(LaunchedSession)(
        yield* fs.readFileString(`${dir}/agents/r1/review.launch.json`),
      );
      expect(launched.agentSession).toEqual({ kind: "opencode", value: "ses_review" });
    }),
  ));

const waitFor = <E, R>(reached: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    while (!(yield* reached)) yield* TestClock.withLive(Effect.sleep("10 millis"));
  });

const spend = (ms: number) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + ms;
    yield* waitFor(Effect.map(Clock.currentTimeMillis, (now) => now >= until));
  });

test(
  "a pi agent on core asks with its question tool: two Decisions, its next step held, and one Delivery with both answers",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* onMachine("core");
        yield* fs.writeFileString(
          hostLockOf(rig.pluginEnv().stateDir),
          `{"pid":${process.pid},"start":null}`,
        );
        yield* rig.queueOutputs([null, null, null]);
        const agent = agentName("r1", "builder", null, 1);
        const sends = () =>
          Effect.map(rig.calls(), (calls) =>
            Arr.map(
              Arr.filter(coreCalls(calls), (call) => call.cmd === "terminal.send"),
              (call) => (isString(call.params?.text) ? call.params.text : ""),
            ),
          );
        yield* session(
          Effect.gen(function* () {
            yield* piWork.execute({ runId: "r1", input: {} }, { discard: true });
            yield* waitFor(Effect.map(sends(), (sent) => sent.length === 1));
            const [run] = Arr.filter(
              coreCalls(yield* rig.calls()),
              (call) => call.cmd === "terminal.run",
            );
            const { argv } = yield* Schema.decodeUnknownEffect(PiLaunch)(run?.params);
            expect(argv[0]).toBe("pi");
            const launched = yield* Schema.decodeEffect(LaunchedSession)(
              yield* fs.readFileString(`${dir}/agents/r1/review.launch.json`),
            );
            const chosen = argv[argv.indexOf("--session-id") + 1];
            expect(chosen).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
            expect(launched.agentSession).toEqual({ kind: "pi", value: chosen ?? "" });

            const tools = yield* piTools(argv[argv.indexOf("-e") + 1] ?? "");
            // The tool's helper stamps its question on the wall clock, which this test's clock
            // runs ahead of: a question stamped before its work was given is not that work's.
            yield* waitFor(Effect.sync(() => Date.now() > launched.at));
            const told = yield* askWith(
              tools,
              "call_1",
              [
                {
                  question: "Which database?",
                  header: "Database",
                  options: [{ label: "Postgres" }],
                },
                { question: "Which checks?", header: "Checks", options: [{ label: "lint" }] },
              ],
              launched.agentSession.value,
            );
            expect(told).toContain("End your turn now");
            const store = yield* Store;
            yield* waitFor(Effect.map(store.asked("r1"), (asked) => asked.length === 2));
            expect(Arr.map(yield* store.asked("r1"), (asked) => asked.answer)).toEqual([
              null,
              null,
            ]);

            yield* Effect.forkChild(
              (yield* Agents).launch({
                runId: "r1",
                operation: "fix",
                role: "reviewer",
                workflow: "core-pi",
                task: null,
                agent: "builder",
                cwd: rig.projectDir,
                prompt: "Fix it.",
                output: `${dir}/agents/r1/fix.json`,
                skill: null,
                harness: "pi",
                model: null,
                effort: null,
                permissions: null,
              }),
            );
            yield* spend(30_000);
            expect(yield* sends()).toHaveLength(1);

            for (const [decision, value] of [
              ["ask-review-1", "SQLite"],
              ["ask-review-2", "lint and typecheck"],
            ] as const)
              yield* store.settle({ run: "r1", decision, value, request: "a" });
            yield* waitFor(Effect.map(sends(), (sent) => sent.length === 3));
            const [step, answers, next] = yield* sends();
            expect(step).toContain("/review.prompt.md");
            expect(answers).toContain(
              "Your questions are answered: Database: SQLite; Checks: lint and typecheck",
            );
            expect(next).toContain("/fix.prompt.md");
            expect(
              Arr.map(
                Arr.filter(coreCalls(yield* rig.calls()), (call) => call.cmd === "terminal.send"),
                (call) => call.params?.terminal,
              ),
            ).toEqual([agent, agent, agent]);
          }),
          coreOnly(core),
          piBody,
        );
      }),
    ),
  120_000,
);

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

test("a core Machine's Herd is listed beside the herdr sessions still running there", () =>
  runEffect(
    Effect.gen(function* () {
      const other = `${rig.root}/other.sock`;
      const env = rig.pluginEnv({
        FAKE_HERDR_SESSIONS: `[{ "name": "other", "socket_path": "${other}" }]`,
      });
      const herds = Effect.map(
        liveHerds(new FakeHerdr(env), env),
        Arr.map(({ herd }) => herd),
      );
      yield* onMachine("herdr");
      expect(yield* herds).toEqual([yield* herdOf(other)]);
      yield* onMachine("core");
      expect(yield* herds).toEqual([yield* herdOf(other), yield* machineHerd(env)]);
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
