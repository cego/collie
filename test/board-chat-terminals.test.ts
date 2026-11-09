// The board and native chat as core terminals a host keeps on its Machine, whatever runs
// its agents: started once when the host starts, and once more under the same name each
// time one ends. herdr is never asked for a tab, pane or popup for either.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Schema } from "effect";
import { writeConfigValue } from "../src/config";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { serveFakeHc } from "./support/fake-hc";
import { until } from "./support/host";
import { collie, proves } from "./support/world";

const Logged = Schema.fromJsonString(
  Schema.Struct({
    transport: Schema.String,
    cmd: Schema.String,
    argv: Schema.optionalKey(Schema.Array(Schema.String)),
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
);

const logged = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(yield* Config.String("FAKE_HERDR_LOG"))
    .pipe(Effect.orElseSucceed(() => ""));
  return Arr.filterMap(Str.split(text, "\n"), (line) => Schema.decodeResult(Logged)(line));
});

const runsOf = (calls: ReadonlyArray<typeof Logged.Type>, name: string) =>
  Arr.filter(calls, (call) => call.cmd === "terminal.run" && call.params?.name === name);

test(
  "a host starts the board and chat as core terminals of their own, and each again when it ends",
  () =>
    proves(
      "collie-front-terminals-",
      (world) =>
        Effect.gen(function* () {
          const core = yield* serveFakeHc(
            `${world.home}/hc.sock`,
            yield* Config.String("FAKE_HERDR_LOG"),
            yield* Effect.scope,
          );
          yield* connect(world.state, {
            hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
          });
          const started = yield* until(
            () => logged,
            (calls) =>
              runsOf(calls, "collie-board").length > 0 && runsOf(calls, "collie-chat").length > 0,
          );
          for (const name of ["collie-board", "collie-chat"])
            expect(runsOf(started, name)[0]?.params).toMatchObject({ name, no_parent: true });

          // A preference changed while chat runs is its next start, never a swap.
          yield* writeConfigValue(world.config, "chat_harness", "pi");
          yield* core.exit("collie-board", 0);
          const restarted = yield* until(
            () => logged,
            (calls) => runsOf(calls, "collie-board").length === 2,
          );
          expect(runsOf(restarted, "collie-chat")).toHaveLength(1);
          yield* core.exit("collie-chat", 0);
          const after = yield* until(
            () => logged,
            (calls) => runsOf(calls, "collie-chat").length === 2,
          );
          expect(runsOf(after, "collie-board")).toHaveLength(2);
          expect(runsOf(after, "collie-chat")[1]?.params?.argv).toEqual(
            expect.arrayContaining(["pi"]),
          );
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "a chat core cannot start is tried again after a wait that grows, not on the removal its failure caused",
  () =>
    proves(
      "collie-chat-backoff-",
      (world) =>
        Effect.gen(function* () {
          const core = yield* serveFakeHc(
            `${world.home}/hc.sock`,
            yield* Config.String("FAKE_HERDR_LOG"),
            yield* Effect.scope,
          );
          // As on a Machine whose core was started where the harness is not on its PATH.
          core.startable("claude", false);
          yield* connect(world.state, {
            hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
          });
          yield* until(
            () => logged,
            (calls) => runsOf(calls, "collie-chat").length > 0,
          );
          yield* Effect.sleep("3 seconds");
          // Each failure makes core say a terminal was removed; retried on that, it is
          // dozens of starts a second, and the host answers nothing else.
          const failed = runsOf(yield* logged, "collie-chat").length;
          expect(failed).toBeLessThanOrEqual(3);

          // Once core can start it, the next try starts it, and a started chat is left be.
          core.startable("claude", true);
          yield* until(
            () => logged,
            (calls) => runsOf(calls, "collie-chat").length > failed,
          );
          yield* Effect.sleep("2 seconds");
          expect(runsOf(yield* logged, "collie-chat")).toHaveLength(failed + 1);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "the board and chat start on a core whose own PATH is bare, on the PATH the host passes them",
  () =>
    proves(
      "collie-bare-core-",
      (world) =>
        Effect.gen(function* () {
          const core = yield* serveFakeHc(
            `${world.home}/hc.sock`,
            yield* Config.String("FAKE_HERDR_LOG"),
            yield* Effect.scope,
          );
          // As a core another Machine's SSH dial started, with no login shell's PATH.
          core.barePath();
          yield* connect(world.state, {
            hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
          });
          yield* until(
            () => logged,
            (calls) =>
              runsOf(calls, "collie-board").length > 0 && runsOf(calls, "collie-chat").length > 0,
          );
          yield* Effect.sleep("2 seconds");
          // Each was started at its first try: neither was refused and tried again.
          const calls = yield* logged;
          expect(runsOf(calls, "collie-board")).toHaveLength(1);
          expect(runsOf(calls, "collie-chat")).toHaveLength(1);
        }).pipe(Effect.orDie),
      [],
    ),
  120_000,
);

test(
  "a whole Run on a Machine set to herdr asks herdr for no board, and no Home is recorded",
  () =>
    proves(
      "collie-no-home-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, `[{ "verdict": "done" }]`);
          const core = yield* serveFakeHc(
            `${world.home}/hc.sock`,
            yield* Config.String("FAKE_HERDR_LOG"),
            yield* Effect.scope,
          );
          const start = yield* collie(
            world,
            ["run", "start", "relaunched", "--input", "harnesses=claude"],
            {
              FAKE_HERDR_OUTPUTS: outputs,
              HC_SOCKET: core.socketPath,
              HERDR_SOCKET_PATH: `${world.home}/herdr.sock`,
            },
          );
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(start.envelope.data);
          const host = yield* connect(world.state);
          yield* until(
            () => host.run({ runId }),
            (view) => view !== null && isSettled(view),
          );
          expect((yield* host.run({ runId }))?.status.status).toBe("complete");

          const calls = yield* logged;
          const onHerdr = Arr.filter(calls, (call) => call.transport !== "core");
          expect(Arr.some(onHerdr, (call) => call.cmd === "agent start")).toBe(true);
          const forTheBoard = Arr.filter(
            onHerdr,
            (call) =>
              /plugin|popup|split|swap|resize/.test(call.cmd) ||
              Arr.some(call.argv ?? [], (arg) => pipe(arg, Str.includes("Collie"))),
          );
          expect(forTheBoard).toEqual([]);
          expect(runsOf(calls, "collie-board")).toHaveLength(1);
          const herds = yield* fs
            .readDirectory(`${world.state}/herd`)
            .pipe(Effect.orElseSucceed((): string[] => []));
          for (const herd of herds)
            expect(yield* fs.exists(`${world.state}/herd/${herd}/home.json`)).toBe(false);
        }).pipe(Effect.orDie),
      ["relaunched.workflow.ts"],
    ),
  120_000,
);
