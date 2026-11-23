import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { writeConfigValue } from "../src/config";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import type { FakeHc } from "./support/fake-hc";
import { until } from "./support/host";
import { collie, proves } from "./support/world";

const Logged = Schema.fromJsonString(
  Schema.Struct({
    transport: Schema.String,
    cmd: Schema.String,
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
);

const logged = (core: FakeHc) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(core.logPath).pipe(Effect.orElseSucceed(() => ""));
    return Arr.filterMap(Str.split(text, "\n"), (line) => Schema.decodeResult(Logged)(line));
  });

const runsOf = (calls: ReadonlyArray<typeof Logged.Type>, name: string) =>
  Arr.filter(calls, (call) => call.cmd === "terminal.run" && call.params?.name === name);

test("a host starts the board and chat as core terminals of their own, and each again when it ends", () =>
  proves(
    "collie-front-terminals-",
    (world, core) =>
      Effect.gen(function* () {
        yield* connect(world.state, {
          hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
        });
        const started = yield* until(
          () => logged(core),
          (calls) =>
            runsOf(calls, "collie-board").length > 0 && runsOf(calls, "collie-chat").length > 0,
        );
        for (const name of ["collie-board", "collie-chat"]) {
          expect(runsOf(started, name)[0]?.params).toMatchObject({ name, no_parent: true });
        }

        yield* writeConfigValue(world.config, "chat_harness", "pi");
        yield* core.exit("collie-board", 0);
        const restarted = yield* until(
          () => logged(core),
          (calls) => runsOf(calls, "collie-board").length === 2,
        );
        expect(runsOf(restarted, "collie-chat")).toHaveLength(1);
        yield* core.exit("collie-chat", 0);
        const after = yield* until(
          () => logged(core),
          (calls) => runsOf(calls, "collie-chat").length === 2,
        );
        expect(runsOf(after, "collie-board")).toHaveLength(2);
        expect(runsOf(after, "collie-chat")[1]?.params?.argv).toEqual(
          expect.arrayContaining(["pi"]),
        );
      }).pipe(Effect.orDie),
    [],
  ));

test("a chat core cannot start is tried again after a wait that grows, not on the removal its failure caused", () =>
  proves(
    "collie-chat-backoff-",
    (world, core) =>
      Effect.gen(function* () {
        core.startable("claude", false);
        yield* connect(world.state, {
          hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
        });
        yield* until(
          () => logged(core),
          (calls) => runsOf(calls, "collie-chat").length > 0,
        );
        yield* Effect.sleep("3 seconds");
        // WARNING: a failed start must not retry at once: core's removal event would retry dozens of times a second.
        const failed = runsOf(yield* logged(core), "collie-chat").length;
        expect(failed).toBeLessThanOrEqual(3);

        core.startable("claude", true);
        yield* until(
          () => logged(core),
          (calls) => runsOf(calls, "collie-chat").length > failed,
        );
        yield* Effect.sleep("2 seconds");
        expect(runsOf(yield* logged(core), "collie-chat")).toHaveLength(failed + 1);
      }).pipe(Effect.orDie),
    [],
  ));

test("the board and chat start on a core whose own PATH is bare, on the PATH the host passes them", () =>
  proves(
    "collie-bare-core-",
    (world, core) =>
      Effect.gen(function* () {
        core.barePath();
        yield* connect(world.state, {
          hostEnv: { HC_SOCKET: core.socketPath, HERDR_SOCKET_PATH: `${world.home}/herdr.sock` },
        });
        yield* until(
          () => logged(core),
          (calls) =>
            runsOf(calls, "collie-board").length > 0 && runsOf(calls, "collie-chat").length > 0,
        );
        yield* Effect.sleep("2 seconds");
        const calls = yield* logged(core);
        expect(runsOf(calls, "collie-board")).toHaveLength(1);
        expect(runsOf(calls, "collie-chat")).toHaveLength(1);
      }).pipe(Effect.orDie),
    [],
  ));

test("a whole Run uses core for its agents and Home, without a legacy layout record", () =>
  proves(
    "collie-no-home-",
    (world, core) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs.writeFileString(outputs, `[{ "verdict": "done" }]`);
        const start = yield* collie(
          world,
          ["run", "start", "relaunched", "--input", "harnesses=claude"],
          {
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

        const calls = yield* logged(core);
        expect(Arr.every(calls, (call) => call.transport === "core")).toBe(true);
        expect(
          Arr.some(
            calls,
            (call) => call.cmd === "terminal.run" && call.params?.name === `${runId}-claude-r1`,
          ),
        ).toBe(true);
        expect(runsOf(calls, "collie-board")).toHaveLength(1);
        const herds = yield* fs
          .readDirectory(`${world.state}/herd`)
          .pipe(Effect.orElseSucceed(() => []));
        for (const herd of herds) {
          expect(yield* fs.exists(`${world.state}/herd/${herd}/home.json`)).toBe(false);
        }
      }).pipe(Effect.orDie),
    ["relaunched.workflow.ts"],
  ));
