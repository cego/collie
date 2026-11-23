// Restarts a trial's host once, when its Run's record first shows a step's delivery as sent:
//   bun run tools/trial-restart.ts <state-dir> <run> <step> <out.json>
// It blocks on the host's board stream, reads the Run's deliveries on each change to the
// board, and writes that change's sequence number and the delivery to <out.json> before
// `collie host restart`. `collie` is the trial's, from PATH.
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { DateTime, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { FrontDoorRpcs, type TaskUpserted } from "../src/board-model";
import { exec } from "../test/support/command";
import { runEffect } from "../test/support/effect";

const [stateDir, run, step, out] = Bun.argv.slice(2);
if (stateDir === undefined || run === undefined || step === undefined || out === undefined)
  throw new Error("usage: trial-restart.ts <state-dir> <run> <step> <out.json>");

const Delivery = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  state: Schema.String,
  cause: Schema.Struct({ kind: Schema.String, ref: Schema.String }),
});
const Deliveries = Schema.fromJsonString(
  Schema.Struct({ data: Schema.Struct({ deliveries: Schema.Array(Delivery) }) }),
);
const Restart = Schema.fromJsonString(
  Schema.Struct({
    run: Schema.String,
    step: Schema.String,
    seq: Schema.Int,
    delivery: Delivery,
    restartAt: Schema.String,
  }),
);

const sentDelivery = Effect.gen(function* () {
  const ran = yield* exec(["collie", "--json", "run", "deliveries", run]);
  const read = yield* Schema.decodeEffect(Deliveries)(ran.stdout).pipe(Effect.orDie);
  return Arr.findFirst(
    read.data.deliveries,
    (one) =>
      one.cause.kind === "step" &&
      one.cause.ref === step &&
      (one.state === "submitted" || one.state === "acknowledged"),
  );
});

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
      const found = yield* door.board().pipe(
        Stream.filter((message): message is TaskUpserted => message._tag === "Upsert"),
        Stream.mapEffect((message) =>
          Effect.map(
            sentDelivery,
            Option.map((delivery) => ({ seq: message.seq, delivery })),
          ),
        ),
        Stream.filter(Option.isSome),
        Stream.runHead,
      );
      if (Option.isNone(found))
        throw new Error("the board stream ended before the delivery was sent");
      const restartAt = DateTime.formatIso(yield* DateTime.now);
      yield* fs.writeFileString(
        out,
        yield* Schema.encodeEffect(Restart)({ run, step, ...found.value.value, restartAt }),
      );
      const restarted = yield* exec(["collie", "--json", "host", "restart"]);
      yield* fs.writeFileString(`${out}.restart`, `${restarted.stdout}${restarted.stderr}`);
    }),
  ),
);
