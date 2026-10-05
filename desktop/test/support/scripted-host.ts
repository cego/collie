// A Machine's host as Desktop meets it, behind a bridge: login-shell noise, the ready
// marker, then `FrontDoorRpcs` over stdio. Its installation, Herds and TaskViews are
// whatever the file named first on its command line holds, read again every 100 ms.
//
// Usage: bun scripted-host.ts <board.json> bridge --as desktop --client <computer>

import { BunFileSystem, BunRuntime, BunStdio } from "@effect/platform-bun";
import { Effect, FileSystem, Layer, Schedule, Schema, Stream } from "effect";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { BRIDGE_READY, FrontDoorRpcs, PROTOCOL } from "../../../src/board-model";
import { boardMessages } from "../../../src/board-stream";
import { ScriptedMachine } from "./scripted-machine";

const [board, ...bridge] = Bun.argv.slice(2);
if (board === undefined || bridge.slice(0, 3).join(" ") !== "bridge --as desktop") {
  process.stderr.write(`scripted host: started as ${Bun.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

const MachineFile = Schema.fromJsonString(ScriptedMachine);

const BoardOnly = FrontDoorRpcs.omit(
  "declare",
  "start",
  "answer",
  "control",
  "resume",
  "runDetail",
  "runFile",
  "confirm",
  "propose",
  "act",
  "reconcile",
  "settleDelivery",
  "decline",
  "dispose",
  "steerAbout",
  "followUp",
  "invoke",
);

const handlers = BoardOnly.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = fs
      .readFileString(board)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(MachineFile)), Effect.orDie);
    const { installation, herds } = yield* read;
    return {
      board: () =>
        boardMessages({
          head: { installation, build: "scripted", protocol: PROTOCOL, herds },
          build: Effect.map(read, ({ tasks }) => tasks),
          changed: Stream.fromSchedule(Schedule.spaced("100 millis")),
        }),
    };
  }),
);

process.stdout.write(`Welcome to the scripted Machine\n${BRIDGE_READY}\n`);

Layer.launch(
  RpcServer.layer(BoardOnly).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolStdio),
    Layer.provide([RpcSerialization.layerNdjson, BunStdio.layer, BunFileSystem.layer]),
  ),
).pipe(BunRuntime.runMain);
