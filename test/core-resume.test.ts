// A Run's agents on core brought back after a full stop: the fake core loses every
// terminal, and the host starts each agent of a Run still running again under its name, in
// its checkout, with its harness's resume of the session recorded at launch. The host is
// the real registry, engine and agents; the Codex agent's App Server is the stand-in.

import { launchesAt } from "./support/records";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Layer, Result, Schema, flow } from "effect";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import type { SqlClient } from "effect/sql";
import type { PlatformServices } from "../src/platform";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { fixtures } from "./support/host";
import { TestClock } from "effect/testing";
import { Agents, agentsLayer, type AgentHost, type RunNow } from "../src/agents";
import { endAgent } from "../src/agent-end";
import type { Backend } from "../src/herdr";
import { readLaunches } from "../src/launches";
import {
  Registry,
  foundationLayer,
  registryLayer,
  type Generation,
  type HostServices,
} from "../src/engine";
import type { Store } from "../src/store";
import { agentName } from "../src/naming";
import { deliveredTo } from "./support/records";
import { COMPACT_AT_TOKENS } from "../src/settings";
import { COMPACTION_PORTS, codexPort } from "../src/compactors";
import { isString } from "../src/schema";

const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      yield* fs.makeDirectory(rig.userDir, { recursive: true });
      yield* fs.writeFileString(
        `${rig.userDir}/config.json`,
        '{ "compact_at_tokens": 0, "trust": "never", "terminal_backend": "core" }',
      );
      yield* fs.writeFileString(
        standIn(),
        asJson({
          events: `${rig.root}/codex-server.events`,
          threads: [{ id: THREAD, cwd: rig.projectDir }],
        }),
      );
    }),
  ),
);

/** Every stand-in App Server a launch started, which nothing else stops once the test ends. */
const Started = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Finite, argv: Schema.Array(Schema.String) }),
);
afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const events = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(`${rig.root}/codex-server.events`)),
        Effect.orElseSucceed(() => ""),
      );
      for (const line of Str.split(events, "\n")) {
        const one = Schema.decodeOption(Started)(line);
        if (Option.isSome(one))
          yield* Effect.ignore(Effect.try(() => process.kill(one.value.pid, "SIGKILL")));
      }
      yield* rig.close();
    }),
  ),
);

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

/** Reads until `wanted` holds, paced on the wall clock the fake core's turns take. */
const until = <A, E, R>(read: () => Effect.Effect<A, E, R>, wanted: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; ; tries++) {
      const value = yield* read();
      if (wanted(value)) return value;
      if (tries === 3_000)
        return yield* Effect.die(new Error(`never got there: ${Bun.inspect(value)}`));
      yield* TestClock.withLive(Effect.sleep("20 millis"));
    }
  });

const THREAD = "019a0000-0000-7000-8000-00000000c0de";
const standIn = () => `${rig.root}/codex-server.json`;
const env = () => rig.pluginEnv({ HC_SOCKET: `${rig.root}/hc.sock`, HERDR_SOCKET_PATH: "" });
const dir = () => env().stateDir;

const hostOf = (): AgentHost => ({
  dir: dir(),
  env: env(),
  herdr: new FakeHerdr(env()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 60_000,
  help: () => Effect.succeed("  --autocompact <auto|tokens>"),
  version: () => Effect.succeed("2.1.309 (Claude Code)"),
  self: [process.execPath, `${import.meta.dir}/../src/main.ts`],
  ports: {
    codex: {
      ...codexPort(`bun ${import.meta.dir}/support/codex-server.ts ${standIn()}`),
      gate: Effect.void,
    },
    opencode: {
      ...COMPACTION_PORTS.opencode!,
      gate: Effect.void,
      // Never a real `opencode serve` to make a first session on.
      install: (ctx) =>
        COMPACTION_PORTS.opencode!.install({ ...ctx, session: ctx.session ?? "ses_notes" }),
    },
  },
});

/** One host's lifetime over the state directory: a second one is what a restart is. */
const hosted = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | Registry
    | Store
    | HostServices
    | MessageStorage.MessageStorage
    | SqlClient.SqlClient
    | PlatformServices
  >,
  host: AgentHost = hostOf(),
) =>
  run.pipe(
    Effect.provide(
      registryLayer(dir(), {
        placing: { herdr: new FakeHerdr(env()), env: env() },
        userDir: rig.userDir,
      }).pipe(
        Layer.provideMerge(agentsLayer(host)),
        Layer.provideMerge(
          foundationLayer({
            dir: dir(),
            userDir: rig.userDir,
            placing: { herdr: new FakeHerdr(env()), env: env() },
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const started = (harnesses: string, request: string) =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const generation: Generation = yield* registry.load(`${fixtures}/relaunched.workflow.ts`);
    const run = yield* registry.start({
      generation,
      request,
      project: rig.projectDir,
      input: {},
      text: { harnesses },
      task: null,
    });
    return run.runId;
  });

const finished = (runId: string) =>
  Effect.flatMap(Registry, (registry) =>
    until(
      () => registry.view(runId),
      (view) => view?.status.status === "complete" || view?.status.status === "failed",
    ),
  );

const coreCalls = (calls: ReadonlyArray<Call>) =>
  Arr.filter(calls, (call) => call.transport === "core");

/** Where core has the agent idle again after it was given its step, its Output still out. */
const idleAfterItsStep = (agent: string, given: "sent" | "at launch" = "sent") =>
  until(
    () => Effect.map(rig.calls(), coreCalls),
    (calls) => {
      const sent = Arr.findFirstIndex(calls, (call) =>
        given === "sent"
          ? call.cmd === "terminal.send" && call.params?.terminal === agent
          : call.cmd === "terminal.run" && call.params?.name === agent,
      ).pipe(Option.getOrElse(() => Infinity));
      return Arr.some(
        calls,
        (call, at) =>
          at > sent &&
          call.cmd === "reported" &&
          call.params?.terminal === agent &&
          call.params?.state === "idle",
      );
    },
  );

/** The session an agent's launch recorded, once it has: the launch is written before it. */
const recordedSession = (runId: string, operation: string) =>
  until(
    () =>
      launchesAt(dir(), runId).pipe(
        Effect.map((launches) =>
          Option.flatMapNullishOr(
            Arr.findFirst(launches, (one) => one.operation === operation),
            (one) => one.agentSession,
          ),
        ),
      ),
    Option.isSome,
  ).pipe(Effect.map(Option.getOrThrow));

const Launch = Schema.Struct({
  name: Schema.String,
  cwd: Schema.String,
  argv: Schema.Array(Schema.String),
});
/** The `terminal.run` calls from `from` on, by agent. */
const launchesSince = (calls: ReadonlyArray<Call>, from: number) =>
  Effect.forEach(
    Arr.filter(coreCalls(calls).slice(from), (call) => call.cmd === "terminal.run"),
    (call) => Schema.decodeUnknownEffect(Launch)(call.params),
  ).pipe(Effect.orDie);

const sendsSince = (calls: ReadonlyArray<Call>, from: number, cmd = "terminal.send") =>
  Arr.map(
    Arr.filter(coreCalls(calls).slice(from), (call) => call.cmd === cmd),
    (call) => ({
      terminal: call.params?.terminal,
      text: isString(call.params?.text) ? call.params.text : "",
    }),
  );

const after = (argv: ReadonlyArray<string>, flag: string) => argv[argv.indexOf(flag) + 1];

test(
  "a core holder loss mid-Run starts each agent of the Run again in its own session, tells the one whose work is out to carry on, and the Run completes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([
          { verdict: "reviewed" },
          { verdict: "planned" },
          { verdict: "noted" },
          null,
          { verdict: "fixed" },
        ]);
        const result = yield* hosted(
          Effect.gen(function* () {
            const runId = yield* started("claude,codex,pi,opencode", "r1");
            const named = (operation: string) => agentName(runId, operation, null, 1);
            // OpenCode's reporter writes the session it opened, as the plugin would.
            yield* until(
              () => fs.exists(`${dir()}/agents/${runId}/opencode.status.js`),
              (there) => there,
            );
            yield* fs.writeFileString(`${dir()}/agents/${runId}/opencode.session`, "ses_notes");
            yield* idleAfterItsStep(named("opencode"), "at launch");
            const sessions = {
              claude: yield* recordedSession(runId, "claude"),
              codex: yield* recordedSession(runId, "codex"),
              opencode: yield* recordedSession(runId, "opencode"),
              pi: yield* recordedSession(runId, "pi"),
            };
            const before = coreCalls(yield* rig.calls()).length;

            yield* core.lose;
            const view = yield* finished(runId);
            return { runId, named, sessions, before, view };
          }),
          // Compaction's controls are what give OpenCode a server to be prompted on.
          { ...hostOf(), compactAtTokens: COMPACT_AT_TOKENS },
        );
        const { runId, named, sessions, before, view } = result;
        expect(view?.status.status).toBe("complete");
        expect(sessions.claude.kind).toBe("claude");
        expect(sessions.codex).toEqual({ kind: "codex", value: THREAD });
        expect(sessions.opencode).toEqual({ kind: "opencode", value: "ses_notes" });
        expect(sessions.pi.kind).toBe("pi");

        const calls = yield* rig.calls();
        const again = yield* launchesSince(calls, before);
        expect(Arr.map(again, (launch) => launch.name).sort()).toEqual(
          Arr.map(["claude", "codex", "opencode", "pi"], named).sort(),
        );
        const of = (operation: string) =>
          Option.getOrThrow(Arr.findFirst(again, (launch) => launch.name === named(operation)));
        for (const operation of ["claude", "codex", "opencode", "pi"])
          expect(of(operation).cwd).toBe(rig.projectDir);
        expect(after(of("claude").argv, "--resume")).toBe(sessions.claude.value);
        expect(of("claude").argv).not.toContain("--session-id");
        expect(of("codex").argv.slice(0, 3)).toEqual(["codex", "resume", THREAD]);
        // Codex refuses permission overrides on a remote resume; the thread keeps its own.
        expect(of("codex").argv).not.toContain("--approve-for-me");
        expect(after(of("opencode").argv, "--session")).toBe("ses_notes");
        // OpenCode ignores a --prompt given with a session that has a conversation.
        expect(of("opencode").argv).not.toContain("--prompt");
        expect(after(of("pi").argv, "--session-id")).toBe(sessions.pi.value);

        // OpenCode takes no keys until its TUI is drawn, so its server is prompted instead.
        expect(sendsSince(calls, before)).toEqual([]);
        const posted = sendsSince(calls, before, "prompt_async");
        expect(Arr.map(posted, (send) => send.terminal)).toEqual([named("opencode")]);
        expect(posted[0]?.text).toContain("Carry on with your step from where you were");
        expect(posted[0]?.text).toContain(`agents/${runId}/opencode.prompt.md`);
        const ledger = yield* deliveredTo(dir(), runId);
        const carried = Arr.filter(
          ledger,
          (delivery) =>
            delivery.agent === named("opencode") &&
            (posted[0]?.text ?? "").includes(`collie-delivery:${delivery.id}`),
        );
        expect(Arr.map(carried, (delivery) => [delivery.cause.kind, delivery.state])).toEqual([
          ["step", "submitted"],
        ]);
      }),
    ),
  120_000,
);

test(
  "a host started after core lost a running Run's agents starts each again in its own session, and none of a finished Run's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([
          { verdict: "reviewed" },
          null,
          { verdict: "done" },
          { verdict: "fixed" },
        ]);
        const { running, done, named } = yield* hosted(
          Effect.gen(function* () {
            const running = yield* started("claude,pi", "r1");
            const named = (runId: string, operation: string) =>
              agentName(runId, operation, null, 1);
            yield* idleAfterItsStep(named(running, "pi"));
            const done = yield* started("claude", "r2");
            yield* finished(done);
            return { running, done, named };
          }),
        );
        const sessions = {
          claude: yield* recordedSession(running, "claude"),
          pi: yield* recordedSession(running, "pi"),
        };
        yield* core.lose;
        const before = coreCalls(yield* rig.calls()).length;

        const view = yield* hosted(finished(running));
        expect(view?.status.status).toBe("complete");
        const calls = yield* rig.calls();
        const again = yield* launchesSince(calls, before);
        expect(Arr.map(again, (launch) => launch.name).sort()).toEqual(
          [named(running, "claude"), named(running, "pi")].sort(),
        );
        expect(Arr.some(again, (launch) => launch.name === named(done, "claude"))).toBe(false);
        const of = (operation: string) =>
          Option.getOrThrow(
            Arr.findFirst(again, (launch) => launch.name === named(running, operation)),
          );
        expect(of("claude").cwd).toBe(rig.projectDir);
        expect(after(of("claude").argv, "--resume")).toBe(sessions.claude.value);
        expect(after(of("pi").argv, "--session-id")).toBe(sessions.pi.value);
        expect(Arr.map(sendsSince(calls, before), (send) => send.terminal)).toEqual([
          named(running, "pi"),
        ]);
      }),
    ),
  120_000,
);

test(
  "an OpenCode agent started again that never reports idle is not told to carry on, and its Run says so",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([null]);
        const { runId, agent } = yield* hosted(
          Effect.gen(function* () {
            const runId = yield* started("opencode", "r1");
            const agent = agentName(runId, "opencode", null, 1);
            yield* until(
              () => fs.exists(`${dir()}/agents/${runId}/opencode.status.js`),
              (there) => there,
            );
            yield* fs.writeFileString(`${dir()}/agents/${runId}/opencode.session`, "ses_notes");
            yield* idleAfterItsStep(agent, "at launch");
            yield* recordedSession(runId, "opencode");
            return { runId, agent };
          }),
        );
        core.startBlocked();
        yield* core.lose;
        const before = coreCalls(yield* rig.calls()).length;

        const runLog = `${dir()}/agents/${runId}/agents.log`;
        const logged = yield* hosted(
          until(
            () => fs.readFileString(runLog).pipe(Effect.orElseSucceed(() => "")),
            Str.includes(`${agent}: not resumed`),
          ),
          { ...hostOf(), readyMs: 200 },
        );
        expect(logged).toContain("OpenCode reported no idle");
        const calls = yield* rig.calls();
        expect(Arr.map(yield* launchesSince(calls, before), (launch) => launch.name)).toEqual([
          agent,
        ]);
        expect(sendsSince(calls, before)).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "an OpenCode agent started again with compaction off is told to carry on through core once it reports idle, and the Run completes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([null, { verdict: "fixed" }]);
        const { runId, agent, before } = yield* hosted(
          Effect.gen(function* () {
            const runId = yield* started("opencode", "r1");
            const agent = agentName(runId, "opencode", null, 1);
            yield* until(
              () => fs.exists(`${dir()}/agents/${runId}/opencode.status.js`),
              (there) => there,
            );
            yield* fs.writeFileString(`${dir()}/agents/${runId}/opencode.session`, "ses_notes");
            yield* idleAfterItsStep(agent, "at launch");
            yield* until(
              () => readLaunches(runId),
              (launches) => Arr.some(launches, (one) => one.agentSession !== undefined),
            );
            return { runId, agent, before: coreCalls(yield* rig.calls()).length };
          }),
        );
        yield* core.lose;
        const view = yield* hosted(finished(runId));
        expect(view?.status.status).toBe("complete");
        const sent = sendsSince(yield* rig.calls(), before);
        expect(Arr.map(sent, (send) => send.terminal)).toEqual([agent]);
        expect(sent[0]?.text).toContain("Carry on with your step from where you were");
      }),
    ),
  120_000,
);

/** A running Run's recovery, as the host gives it, with nobody to ask. */
const runningNow: RunNow = {
  running: Effect.succeed(true),
  authority: Effect.succeed({ created: null, roaming: false, started: null }),
  questions: { ask: () => Effect.void, asked: Effect.succeed([]), close: () => Effect.void },
};

test(
  "a host started on a Machine set to herdr starts again an agent core lost after the Machine switched to core",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([null]);
        const config = `${rig.userDir}/config.json`;
        const backend = (name: string) =>
          fs.writeFileString(
            config,
            `{ "compact_at_tokens": 0, "trust": "never", "terminal_backend": "${name}" }`,
          );
        yield* backend("herdr");
        const again = yield* hosted(
          Effect.gen(function* () {
            // Long enough for the host to have read the setting it started on.
            yield* TestClock.withLive(Effect.sleep("500 millis"));
            yield* backend("core");
            const runId = yield* started("pi", "r1");
            const agent = agentName(runId, "pi", null, 1);
            yield* idleAfterItsStep(agent);
            const before = coreCalls(yield* rig.calls()).length;
            yield* core.lose;
            const launches = yield* until(
              () => Effect.flatMap(rig.calls(), (calls) => launchesSince(calls, before)),
              (launches) => launches.length > 0,
            );
            return { agent, launches };
          }),
        );
        expect(Arr.map(again.launches, (launch) => launch.name)).toEqual([again.agent]);
      }),
    ),
  120_000,
);

test(
  "an agent ended on purpose stays ended when core reports its exit before the end is done",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.startCore();
        yield* rig.queueOutputs([null]);
        const { ended, left } = yield* hosted(
          Effect.gen(function* () {
            const runId = yield* started("pi", "r1");
            const agent = agentName(runId, "pi", null, 1);
            yield* idleAfterItsStep(agent);
            const agents = yield* Agents;
            const recoveries: Array<Fiber.Fiber<void>> = [];
            class ExitSeenWhileClosing extends FakeHerdr {
              override paneClose(paneId: string, backend?: Backend) {
                return super.paneClose(paneId, backend).pipe(
                  Effect.andThen(Effect.forkChild(agents.resumeLost(runId, runningNow))),
                  Effect.map((recovery) => {
                    recoveries.push(recovery);
                  }),
                );
              }
            }
            const herdr = new ExitSeenWhileClosing(env());
            const launched = Option.getOrThrow(
              Arr.findLast(yield* readLaunches(runId), (one) => one.agent === agent),
            );
            const ended = yield* endAgent(
              { herdr, stateDir: dir(), ports: {}, log: () => Effect.void, cwd: rig.projectDir },
              launched,
              "it ran out",
              "close",
            );
            yield* Fiber.joinAll(recoveries);
            return { ended, left: yield* herdr.agentList() };
          }),
        );
        expect(ended).toEqual({ _tag: "Closed", ended: true });
        expect(left).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "an agent ended while core's recovery is starting it again stays ended",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const core = yield* rig.startCore();
        yield* rig.queueOutputs([null]);
        const launching = Deferred.makeUnsafe<void>();
        const go = Deferred.makeUnsafe<void>();
        let held = false;
        class HeldLaunch extends FakeHerdr {
          override agentLaunch(opts: Parameters<FakeHerdr["agentLaunch"]>[0]) {
            if (!held) return super.agentLaunch(opts);
            return Deferred.succeed(launching, undefined).pipe(
              Effect.andThen(Deferred.await(go)),
              Effect.andThen(super.agentLaunch(opts)),
            );
          }
        }
        const { ended, left } = yield* hosted(
          Effect.gen(function* () {
            const runId = yield* started("pi", "r1");
            const agent = agentName(runId, "pi", null, 1);
            yield* idleAfterItsStep(agent);
            const launched = Option.getOrThrow(
              Arr.findLast(yield* readLaunches(runId), (one) => one.agent === agent),
            );
            held = true;
            yield* core.lose;
            yield* Deferred.await(launching);
            const herdr = new FakeHerdr(env());
            const ending = yield* Effect.forkChild(
              endAgent(
                {
                  herdr,
                  stateDir: dir(),
                  ports: {},
                  log: () => Effect.void,
                  cwd: rig.projectDir,
                },
                launched,
                "it ran out",
                "close",
              ),
            );
            // Room for an end that does not wait on the recovery to finish before it.
            yield* TestClock.withLive(Effect.sleep("500 millis"));
            yield* Deferred.succeed(go, undefined);
            const ended = yield* Fiber.join(ending);
            yield* until(
              () =>
                fs
                  .readFileString(`${dir()}/agents/${runId}/agents.log`)
                  .pipe(Effect.orElseSucceed(() => "")),
              Str.includes("started again on core"),
            );
            return { ended, left: yield* herdr.agentList() };
          }),
          { ...hostOf(), herdr: new HeldLaunch(env()) },
        );
        expect(ended).toEqual({ _tag: "Closed", ended: true });
        expect(left).toEqual([]);
      }),
    ),
  120_000,
);
