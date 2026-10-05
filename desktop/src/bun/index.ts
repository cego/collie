// Desktop's main process: one window on the view, and every Machine's board relayed to it
// as Effect RPC over Electrobun's message channel.

import { hostname } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, FileSystem, Layer, Schema, Stream } from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import Electrobun, { BrowserView, BrowserWindow, type RPCSchema } from "electrobun/bun";
import {
  type Channel,
  type FrameSchema,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../shared/channel";
import { DesktopRpcs } from "../shared/flock";
import {
  bridgeCommand,
  endChildren,
  flockStream,
  herdrMachines,
  openBridge,
  type Route,
  remoteRoute,
} from "./machine";

type Frames = RPCSchema<FrameSchema>;

let receive: (frame: ToMain) => void = () => {};
const rpc = BrowserView.defineRPC<{ bun: Frames; webview: Frames }>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {},
    messages: {
      // SAFETY: only the view sends on this channel, and the view sends nothing but `ToMain`.
      frame: (frame) => receive(frame as ToMain),
    },
  },
});

const window = new BrowserWindow({
  title: "Collie",
  url: "views://mainview/index.html",
  renderer: "cef",
  frame: { width: 1200, height: 800, x: 120, y: 80 },
  rpc,
});

const toView: Channel<ToView, ToMain> = {
  send: (frame) => window.webview.rpc?.send.frame(frame),
  listen: (listener) => {
    receive = listener;
  },
};

/** How `collie` is run here: in a login shell, as SSH would on another Machine. */
const Collie = Config.schema(
  Schema.fromJsonString(Schema.Array(Schema.String)),
  "COLLIE_DESKTOP_COLLIE",
).pipe(
  Config.orElse(() =>
    Config.String("SHELL").pipe(
      Config.withDefault("/bin/sh"),
      Config.map((shell) => [shell, "-lc", 'exec collie "$@"', "collie"]),
    ),
  ),
);

const main = Effect.gen(function* () {
  const local = hostname();
  const collie = yield* Collie;
  const fs = yield* FileSystem.FileSystem;
  // Short, because a control socket's path is capped at about 100 bytes.
  const controls = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ssh-" });
  const listed = yield* herdrMachines("herdr").pipe(Effect.result);
  const remote = yield* Effect.forEach(
    listed._tag === "Success" ? listed.success : [],
    (machine, at) => remoteRoute("ssh", `${controls}/${at}`, machine, local),
  );
  const routes: ReadonlyArray<Route> = [
    { machine: { name: local }, open: openBridge(bridgeCommand(collie, local)) },
    ...remote,
  ];
  const unlisted = Stream.fromIterable(
    listed._tag === "Failure"
      ? [{ _tag: "Lost" as const, name: "herdr's machines", reason: listed.failure }]
      : [],
  );
  const handlers = DesktopRpcs.toLayer({
    flock: () => Stream.merge(unlisted, flockStream(routes)),
  });
  return yield* Layer.launch(
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(toView))),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// Quitting may end the process before any scope closes, and an SSH master outlives it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
