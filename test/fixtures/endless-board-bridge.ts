// A bridge whose host streams board changes without end, and answers a record only once its
// board stream has stopped being read, or at once on a channel that never asked for a board.

import { BunRuntime } from "@effect/platform-bun";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import * as Arr from "effect/Array";
import { Effect, Layer, Stream } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { BRIDGE_READY, FrontDoorRpcs } from "../../src/board-model";

const served = ["board", "toasts", "runDetail"];
const Rpcs = FrontDoorRpcs.omit(
  // SAFETY: every other tag of the group, whatever it holds today.
  ...(Arr.filter([...FrontDoorRpcs.requests.keys()], (tag) => !served.includes(tag)) as [
    "refresh",
  ]),
);

let sent = 0;
/** Once the board's count of sent changes holds still, its reader has stopped taking them. */
const boardStalled = Effect.gen(function* () {
  for (let waited = 0; ; waited++) {
    const before = sent;
    yield* Effect.sleep("200 millis");
    if (sent > 0 ? sent === before : waited >= 5) return;
  }
});

const handlers = Rpcs.toLayer(
  // SAFETY: the client asks only what `served` names.
  {
    board: () =>
      Stream.iterate(0, (seq) => seq + 1).pipe(
        Stream.map((seq) => ({ _tag: "Remove" as const, seq, id: `t-${seq}` })),
        Stream.tap(() => Effect.sync(() => sent++)),
      ),
    toasts: () => Stream.never,
    runDetail: () =>
      Stream.fromEffect(Effect.as(boardStalled, null)).pipe(Stream.concat(Stream.never)),
  } as never,
);

process.stdout.write(`${BRIDGE_READY}\n`);
RpcServer.layer(Rpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide([RpcSerialization.layerNdjson, BunStdio.layer]),
  Layer.launch,
  BunRuntime.runMain,
);
