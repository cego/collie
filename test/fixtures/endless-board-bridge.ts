import { BunRuntime } from "@effect/platform-bun";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import * as Arr from "effect/Array";
import { Effect, Layer, Stream } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { BRIDGE_READY, FrontDoorRpcs, IdentityRpc, PROTOCOL } from "../../src/board-model";

const served = ["identity", "board", "toasts", "runDetail"];
const Rpcs = FrontDoorRpcs.omit(
  // WARNING: every other tag of the group, whatever it holds today.
  ...(Arr.filter([...FrontDoorRpcs.requests.keys()], (tag) => !served.includes(tag)) as [
    "refresh",
  ]),
).add(IdentityRpc);

let sent = 0;
const boardStalled = Effect.gen(function* () {
  for (let waited = 0; ; waited++) {
    const before = sent;
    yield* Effect.sleep("200 millis");
    if (sent > 0 ? sent === before : waited >= 5) return;
  }
});

const handlers = Rpcs.toLayer(
  // WARNING: the client asks only what `served` names.
  {
    identity: () =>
      Effect.succeed({
        build: "1.0.5",
        pid: process.pid,
        dir: "/fixture",
        installation: "i-1",
        protocol: PROTOCOL,
      }),
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
