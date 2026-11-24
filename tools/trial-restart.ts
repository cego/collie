import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Data, DateTime, Effect, FileSystem, Layer, Schedule, Schema, Stream } from "effect";
import type { Duration } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { FrontDoorRpcs } from "../src/board-model";
import type { BoardMessage, TaskUpserted } from "../src/board-model";
import { hostLockOf } from "../src/lock";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";

const Delivery = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  state: Schema.String,
  cause: Schema.Struct({ kind: Schema.String, ref: Schema.String }),
});
type Delivery = typeof Delivery.Type;
const Deliveries = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Struct({ deliveries: Schema.Array(Delivery) }) }),
);
const HostSeen = Schema.Struct({ pid: Schema.Int });
const Restart = Schema.fromJsonString(
  Schema.Struct({
    run: Schema.String,
    step: Schema.String,
    seq: Schema.Int,
    delivery: Delivery,
    requestedAt: Schema.String,
    confirmed: Schema.optionalKey(
      Schema.Struct({ at: Schema.String, before: Schema.Int, after: Schema.Int }),
    ),
  }),
);

class RestartUnconfirmed extends Data.TaggedError("RestartUnconfirmed")<{
  readonly exitCode: number;
  readonly said: string;
}> {}

const collieAt = (stateDir: string, args: ReadonlyArray<string>) =>
  exec(["collie", ...args], { env: { ...process.env, COLLIE_STATE_DIR: stateDir } });

const lockOwner = (stateDir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(hostLockOf(stateDir))),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(HostSeen))),
    Effect.map((seen) => seen.pid),
    Effect.orElseSucceed(() => null),
  );

export const sentOnRunCard = <E, R>(
  board: Stream.Stream<BoardMessage, E, R>,
  run: string,
  sent: Effect.Effect<Option.Option<Delivery>, E, R>,
) =>
  board.pipe(
    Stream.filter(
      (message): message is TaskUpserted =>
        message._tag === "Upsert" &&
        (message.task.run === run || Arr.contains(message.task.runs, run)),
    ),
    Stream.mapEffect((message) =>
      Effect.map(
        sent,
        Option.map((delivery) => ({ seq: message.seq, delivery })),
      ),
    ),
    Stream.filter(Option.isSome),
    Stream.map((found) => found.value),
    Stream.runHead,
  );

// WARNING: A host slow to stop still owns the lock when `collie host restart` answers.
export const restartConfirmed = (stateDir: string, within: Duration.Input) =>
  Effect.gen(function* () {
    const before = yield* lockOwner(stateDir);
    const ran = yield* collieAt(stateDir, ["--json", "host", "restart"]);
    const said = `${ran.stdout}${ran.stderr}`;
    if (ran.exitCode !== 0) {
      return yield* new RestartUnconfirmed({ exitCode: ran.exitCode, said });
    }
    const after = yield* lockOwner(stateDir).pipe(
      Effect.repeat({
        until: (owner) => owner !== null && owner !== before,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(within),
    );
    if (Option.isNone(after) || after.value === null || before === null) {
      return yield* new RestartUnconfirmed({ exitCode: ran.exitCode, said });
    }
    return { before, after: after.value, said };
  });

const sentDelivery = (stateDir: string, run: string, step: string) =>
  Effect.gen(function* () {
    const ran = yield* collieAt(stateDir, ["--json", "run", "deliveries", run]);
    const read = yield* Schema.decodeEffect(Deliveries)(ran.stdout).pipe(Effect.orDie);
    return Arr.findFirst(
      read.data.deliveries,
      (one) =>
        one.cause.kind === "step" &&
        one.cause.ref === step &&
        (one.state === "submitted" || one.state === "acknowledged"),
    );
  });

if (import.meta.main) {
  const [stateDir, run, step, out] = Bun.argv.slice(2);
  if (stateDir === undefined || run === undefined || step === undefined || out === undefined) {
    throw new Error("usage: trial-restart.ts <state-dir> <run> <step> <out.json>");
  }
  await runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const context = yield* Layer.build(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(BunSocket.layerNet({ path: `${stateDir}/host.sock` })),
            Layer.provide(RpcSerialization.layerNdjson),
          ),
        );
        const door = yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
        const found = yield* sentOnRunCard(door.board(), run, sentDelivery(stateDir, run, step));
        if (Option.isNone(found)) {
          throw new Error("the board stream ended before the delivery was sent");
        }
        const requested = {
          run,
          step,
          ...found.value,
          requestedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* fs.writeFileString(out, yield* Schema.encodeEffect(Restart)(requested));
        const restarted = yield* restartConfirmed(stateDir, "30 seconds").pipe(
          Effect.tapError((failed) => fs.writeFileString(`${out}.restart`, failed.said)),
        );
        yield* fs.writeFileString(`${out}.restart`, restarted.said);
        yield* fs.writeFileString(
          out,
          yield* Schema.encodeEffect(Restart)({
            ...requested,
            confirmed: {
              at: DateTime.formatIso(yield* DateTime.now),
              before: restarted.before,
              after: restarted.after,
            },
          }),
        );
      }),
    ),
  );
}
