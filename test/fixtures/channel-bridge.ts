import { dlopen } from "bun:ffi";
import { BunRuntime } from "@effect/platform-bun";
import * as BunStdio from "@effect/platform-bun/BunStdio";
import { Effect, Layer, Schema, Stream } from "effect";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { BRIDGE_READY, FrontDoorRpcs, IdentityRpc, PROTOCOL } from "../../src/board-model";

const [channel, generation] = process.argv.slice(2);
const identity = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.String,
      generation: Schema.String,
      pid: Schema.Int,
    }),
  ),
);
const rpc = <Tag extends "board" | "toasts" | "read" | "runDetail">(tag: Tag) =>
  // SAFETY: each key selects the RPC carrying that tag.
  FrontDoorRpcs.requests.get(tag)! as Extract<
    RpcGroup.Rpcs<typeof FrontDoorRpcs>,
    { readonly _tag: Tag }
  >;
const Rpcs = RpcGroup.make(rpc("board"), rpc("toasts"), rpc("read"), rpc("runDetail"), IdentityRpc);
const handlers = Rpcs.toLayer({
  board: () =>
    Stream.make({
      _tag: "Snapshot" as const,
      installation: "fixture-vm",
      build: "0.132.3",
      protocol: PROTOCOL,
      herds: [],
      tasks: [],
      seq: 0,
    }).pipe(Stream.concat(Stream.never)),
  toasts: () => Stream.never,
  identity: () =>
    Effect.succeed({
      build: "0.132.3",
      pid: process.pid,
      dir: "/fixture",
      installation: "fixture-vm",
      protocol: PROTOCOL,
    }),
  runDetail: () => Stream.make(null).pipe(Stream.concat(Stream.never)),
  read: ({ input }) =>
    Effect.suspend(() => {
      if (input.break === "exit") process.exit(23);
      if (input.break === "socket") {
        const libc = dlopen(
          process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
          {
            shutdown: { args: ["i32", "i32"], returns: "i32" },
          },
        );
        // Bun duplicates stdout; shutdown ends the socket through both descriptors.
        libc.symbols.shutdown(1, 1);
        libc.close();
      }
      if (input.break === "rpc") process.stdout.write("broken-json\n");
      return input.break === undefined
        ? identity({ channel: channel!, generation: generation!, pid: process.pid }).pipe(
            Effect.orDie,
          )
        : Effect.never;
    }),
});

process.stdout.write(`${BRIDGE_READY}\n`);
RpcServer.layer(Rpcs).pipe(
  Layer.provide(handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide([RpcSerialization.layerNdjson, BunStdio.layer]),
  Layer.launch,
  BunRuntime.runMain,
);
