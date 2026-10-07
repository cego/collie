// A finished Run's live agents still take steering (ADR-0041), through the host an
// installation runs: the Dispatcher, the ledger and the receipt a running Run gets, and a
// status nothing rewrites.

import { expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Crypto, Effect, FileSystem, Schema, type Scope } from "effect";
import { readEnv } from "../src/env";
import { resetExecutors } from "../src/executors";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { carryOutAsked } from "../src/run-actions";
import { DELIVERY_TOKEN } from "../src/dispatcher";
import { runDir } from "../src/engine";
import { attachFiles, type FlowPrompts } from "../src/flows";
import { appendLine, deliveriesOf, ledgerPath, readLedger } from "../src/steering";
import { Herdr } from "../src/herdr";
import { stopHost, until } from "./support/host";
import { hosted, hostedRun } from "./support/hosted";
import { collie, proves, type World } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const FakeState = Schema.fromJsonString(
  Schema.Struct({
    agents: Schema.Array(Schema.Struct({ name: Schema.String, pane_id: Schema.String })),
  }),
);
const CallLine = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, argv: Schema.Array(Schema.String) }),
);

/** A `told` Run that has succeeded with its agent still alive, and the env chat acts in. */
const finishedWithAgent = Effect.fn("test.finishedWithAgent")(function* (world: World) {
  resetExecutors();
  const env = readEnv({
    HERDR_PLUGIN_ROOT: world.install,
    HERDR_PLUGIN_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
    HOME: world.home,
    COLLIE_CWD: world.project,
  });
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const started = yield* client
    .start({ project: world.project, id: "told", request, input: { work: "the picker" } })
    .pipe(Effect.orDie);
  const view = yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (one) => one !== null && isSettled(one),
  );
  expect(view?.status.status).toBe("complete");
  const fs = yield* FileSystem.FileSystem;
  const herdr = Schema.decodeUnknownSync(FakeState)(
    yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
  );
  const agent = herdr.agents[0]!;
  return { env, client, runId: started.runId, agent };
});

const deliver = (runId: string, agent: string, text: string) => ({
  kind: "deliver" as const,
  run: runId,
  agent,
  text,
  mode: "boundary" as const,
});

let asked = 0;
/** Chat, under a request id of each call's own: one id twice is one operation. */
const chat = () => ({ origin: "chat" as const, requestId: `req-chat-${++asked}` });

/** A world whose fake agent answers its one prompt with an Output, and is then left alive. */
const steerable = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
  /** What the fake agent answers its prompts with; none leaves it working for good. */
  answers: ReadonlyArray<{ readonly verdict: string }> = [{ verdict: "built" }],
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs.writeFileString(outputs, encode(answers)).pipe(Effect.orDie);
        // The host a client spawns inherits this process's environment: it has to own this
        // world's state, never the operator's.
        const set = {
          FAKE_HERDR_OUTPUTS: outputs,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const before = Object.fromEntries(Object.keys(set).map((key) => [key, Bun.env[key]]));
            Object.assign(Bun.env, set);
            return before;
          }),
          (before) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(before))
                if (value === undefined) delete Bun.env[key];
                else Bun.env[key] = value;
            }),
        );
        return yield* body(world).pipe(Effect.ensuring(stopHost(world.state)));
      }),
    ["told.workflow.ts"],
  );

test(
  "a chat that clears an override is recorded with the human's words",
  () =>
    steerable("collie-finished-override-", (world) =>
      Effect.gen(function* () {
        const finished = yield* finishedWithAgent(world);
        const { runId, agent } = finished;
        // Cleared here rather than by the host, so it has to reach this world's herdr.
        const env = { ...finished.env, binPath: Bun.env.HERDR_BIN_PATH! };
        const live = yield* new Herdr(env).agentList().pipe(Effect.orDie);
        const terminal = live.find((one) => one.name === agent.name)!.terminalId!;
        const ledger = yield* ledgerPath(world.state, terminal);
        yield* appendLine(ledger, {
          kind: "manual_override",
          at: "2026-10-05T10:00:00.000Z",
          incarnation: terminal,
          by: "hook:UserPromptSubmit",
        });
        const voiced = { ...chat(), conversation: "native", said: "let Collie steer it again" };
        const [done] = yield* carryOutAsked(
          env,
          [{ kind: "clear_override", run: runId, agent: agent.name }],
          voiced,
        );
        expect(done).toMatchObject({ kind: "clear_override", state: "applied" });
        expect((yield* readLedger(ledger)).at(-1)).toMatchObject({
          kind: "override_cleared",
          conversation: "native",
          said: "let Collie steer it again",
        });
      }),
    ),
  120_000,
);

test(
  "a succeeded Run's live agent takes a delivery, with its token and a ledger receipt",
  () =>
    steerable("collie-finished-deliver-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "merge it")], chat());
        expect(done).toMatchObject({ kind: "deliver", state: "applied" });

        const steered = (yield* deliveriesOf(world.state, runId)).filter(
          (one) => one.delivery.cause.kind === "steer",
        );
        expect(steered).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        const prompts = (yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(CallLine)(line))
          .filter((call) => call.cmd === "agent prompt" && call.argv[2] === agent.name);
        expect(prompts.at(-1)?.argv.join(" ")).toContain(
          `${DELIVERY_TOKEN}${steered[0]!.delivery.id}`,
        );
        expect(prompts.at(-1)?.argv.join(" ")).toContain("merge it");
      }),
    ),
  120_000,
);

test(
  "a finished Run whose agent is gone fails the delivery and names its follow-up offer",
  () =>
    steerable("collie-finished-gone-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        yield* Effect.promise(() =>
          Bun.$`${Bun.env.HERDR_BIN_PATH!} pane close ${agent.pane_id}`.quiet(),
        );

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
        expect(done?.state).toBe("failed");
        expect(done?.note).toContain('follow-up offer "carry-on"');
        expect(done?.note).toContain("giving the message as its input");
      }),
    ),
  120_000,
);

test(
  "a stop closes a succeeded Run's live pane and leaves it succeeded",
  () =>
    steerable("collie-finished-stop-", (world) =>
      Effect.gen(function* () {
        const { env, client, runId, agent } = yield* finishedWithAgent(world);

        const [done] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(done).toMatchObject({ kind: "stop", state: "applied" });
        expect(done?.note).toContain(`Closed ${agent.name}`);
        const fs = yield* FileSystem.FileSystem;
        const herdr = Schema.decodeUnknownSync(FakeState)(
          yield* fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(Effect.orDie),
        );
        expect(herdr.agents.map((one) => one.name)).not.toContain(agent.name);

        const view = yield* client.run({ runId }).pipe(Effect.orDie);
        expect(view?.status.status).toBe("complete");
        expect(view?.controls).toEqual([]);

        const again = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(again[0]?.note).toBe(`Nothing of ${runId} was running.`);
      }),
    ),
  120_000,
);

test(
  "a succeeded Run's agent is still told after its module was removed",
  () =>
    steerable("collie-finished-unregistered-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${world.user}/told.workflow.ts`).pipe(Effect.orDie);
        // A host started again finds no module to register the Run's generation under.
        yield* stopHost(world.state);

        const [done] = yield* carryOutAsked(env, [deliver(runId, agent.name, "merge it")], chat());
        expect(done).toMatchObject({ kind: "deliver", state: "applied" });
      }),
    ),
  120_000,
);

test(
  "a steer that reached nobody on a running Run is failed, never applied",
  () =>
    hosted("collie-running-undelivered-", ({ world, env }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "add a picker");
        const [done] = yield* carryOutAsked(env, [deliver(run.id, "nobody", "hurry up")], chat());
        expect(done?.state).toBe("failed");
        expect(done?.note).toContain("Nothing was delivered");
      }),
    ),
  120_000,
);

test(
  "with its module removed, a succeeded Run's stop sets nothing and its gone agent's request is routed on",
  () =>
    steerable("collie-finished-unregistered-stop-", (world) =>
      Effect.gen(function* () {
        const { env, runId, agent } = yield* finishedWithAgent(world);
        const fs = yield* FileSystem.FileSystem;
        const module = `${world.user}/told.workflow.ts`;
        const saved = yield* fs.readFileString(module).pipe(Effect.orDie);
        yield* fs.remove(module).pipe(Effect.orDie);
        yield* stopHost(world.state);

        const [stopped] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
        expect(stopped).toMatchObject({ kind: "stop", state: "applied" });
        expect(stopped?.note).toContain(`Closed ${agent.name}`);

        const [told] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
        expect(told?.state).toBe("failed");
        expect(told?.note).toContain("has finished and its agent is gone");

        // Back with its module: still the status it finished with, under no control.
        yield* fs.writeFileString(module, saved).pipe(Effect.orDie);
        yield* stopHost(world.state);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const view = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (one) => one !== null && one.diagnostic === null,
        );
        expect(view?.status.status).toBe("complete");
        expect(view?.controls).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "the CLI's hold and release on a finished Run are refused as chat's are",
  () =>
    steerable("collie-finished-hold-", (world) =>
      Effect.gen(function* () {
        const { runId } = yield* finishedWithAgent(world);
        for (const verb of ["hold", "release"]) {
          const said = yield* collie(world, ["run", verb, runId]);
          expect(said.envelope.ok).toBe(false);
          expect(said.envelope.error?.message).toContain(
            "a finished Run has no step left to hold; stop closes its agents",
          );
        }
      }),
    ),
  120_000,
);

test(
  "a stopped Run's closed agent is not told, and the request is routed on",
  () =>
    steerable(
      "collie-stopped-gone-",
      (world) =>
        Effect.gen(function* () {
          resetExecutors();
          const env = readEnv({
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            HOME: world.home,
            COLLIE_CWD: world.project,
          });
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const request = yield* (yield* Crypto.Crypto).randomUUIDv4;
          const { runId } = yield* client
            .start({ project: world.project, id: "told", request, input: { work: "the picker" } })
            .pipe(Effect.orDie);
          const fs = yield* FileSystem.FileSystem;
          // Its one agent is up and working, and nothing will ever come of it.
          const herdr = yield* until(
            () =>
              fs.readFileString(`${Bun.env.FAKE_HERDR_LOG}.state.json`).pipe(
                Effect.map((text) => Schema.decodeUnknownSync(FakeState)(text)),
                Effect.orElseSucceed(() => ({ agents: [] })),
              ),
            (state) => state.agents.length > 0,
          );
          const agent = herdr.agents[0]!;

          const [stopped] = yield* carryOutAsked(env, [{ kind: "stop", run: runId }], chat());
          expect(stopped?.state).toBe("applied");

          const [told] = yield* carryOutAsked(env, [deliver(runId, agent.name, "tag it")], chat());
          expect(told?.state).toBe("failed");
          expect(told?.note).toContain("has finished and its agent is gone");

          const held = yield* collie(world, ["run", "hold", runId]);
          expect(held.envelope.error?.message).toContain("a finished Run has no step left to hold");
        }),
      [],
    ),
  120_000,
);

/** The board's prompts, answering the one question with `typed`. */
const typing = (typed: string): FlowPrompts => ({
  menu: () => Effect.succeed(null),
  ask: () => Effect.succeed(typed),
});

test(
  "the board's Attach files… hands the typed files to the Run's live agent",
  () =>
    steerable("collie-attach-board-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { env, runId } = yield* finishedWithAgent(world);
        yield* fs.writeFileString(`${world.project}/my shot.png`, "png").pipe(Effect.orDie);
        yield* fs.writeFileString(`${world.project}/log.txt`, "log").pipe(Effect.orDie);

        const note = yield* attachFiles(
          { ...env, cwd: world.project },
          typing(`'my shot.png' ${world.project}/log.txt`),
          runId,
        );
        expect(note).toStartWith("Told ");
        const dir = `${runDir(world.state, runId)}/attachments`;
        expect(yield* fs.readFileString(`${dir}/my shot.png`).pipe(Effect.orDie)).toBe("png");
        const told = (yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG!).pipe(Effect.orDie))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(CallLine)(line))
          .filter((call) => call.cmd === "agent prompt")
          .map((call) => call.argv.join(" "))
          .find((text) => text.includes("Attached:"));
        expect(told).toContain(`Attached: ${dir}/my shot.png`);
        expect(told).toContain(`Attached: ${dir}/log.txt`);

        expect(yield* attachFiles(env, typing("/nowhere/at-all.png"), runId)).toContain(
          "attachment /nowhere/at-all.png does not exist",
        );
      }),
    ),
  120_000,
);

test(
  "the board's Attach files… on a Run with no live agent says to use Follow up",
  () =>
    steerable("collie-attach-board-gone-", (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { env, runId, agent } = yield* finishedWithAgent(world);
        yield* Effect.promise(() =>
          Bun.$`${Bun.env.HERDR_BIN_PATH!} pane close ${agent.pane_id}`.quiet(),
        );
        yield* fs.writeFileString(`${world.project}/shot.png`, "png").pipe(Effect.orDie);

        const note = yield* attachFiles(env, typing(`${world.project}/shot.png`), runId);
        expect(note).toContain("Nothing was delivered");
        expect(note).toContain('follow-up offer "carry-on"');
      }),
    ),
  120_000,
);
