// Desktop's main process: one window on the view, and every Machine's board relayed to it
// as Effect RPC over Electrobun's message channel.

import { hostname } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Crypto, Effect, FileSystem, Layer, Result, Schema, Stream } from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import Electrobun, { BrowserView, BrowserWindow, type RPCSchema, Utils } from "electrobun/bun";
import {
  type Channel,
  type FrameSchema,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../shared/channel";
import { appWindowFor } from "./browser";
import { ActionFailed, DesktopRpcs, type FlockItem } from "../shared/flock";
import {
  act,
  bridgeCommand,
  type Door,
  doorTo,
  offersOn,
  runDetailOn,
  runFileOn,
  workflowsOn,
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

// The view holds the Bun bridge, so nothing may navigate the window off it. Set on the
// webview: as a window option, Linux CEF ignores it.
window.webview.setNavigationRules(["^*", "views://mainview/index.html", "about:srcdoc"]);

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
  // herdr's list is the only list of Machines there is.
  const listed = yield* herdrMachines("herdr").pipe(Effect.result);
  const [enabled, unlisted] = Result.match(listed, {
    onSuccess: (machines) => [machines, []] as const,
    onFailure: (reason): readonly [[], FlockItem[]] => [
      [],
      [{ _tag: "Lost", machine: { name: "herdr's machines" }, reason }],
    ],
  });
  const remote = yield* Effect.forEach(enabled, (machine, at) =>
    remoteRoute("ssh", `${controls}/${at}`, machine, local),
  );
  const routes: ReadonlyArray<Route> = [
    { machine: { name: local }, open: openBridge(bridgeCommand(collie, local)) },
    ...remote,
  ];
  const doors = new Map<string, Door>();
  const handlers = DesktopRpcs.toLayer({
    flock: () => Stream.merge(Stream.fromIterable(unlisted), flockStream(routes, doors)),
    act: ({ installation, action, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie));
        const door = yield* doorTo(doors, installation).pipe(
          Effect.mapError((failed) => new ActionFailed({ reason: failed.reason, request })),
        );
        return yield* act(door, request, action);
      }),
    openLink: ({ url }) =>
      appWindowFor(url).pipe(
        Effect.flatMap(Effect.fromNullishOr),
        Effect.flatMap((command) =>
          Effect.try(() =>
            Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref(),
          ),
        ),
        Effect.catch(() => Effect.sync(() => void Utils.openExternal(url))),
      ),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door, runId))),
    workflows: ({ installation, project }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => workflowsOn(door, project))),
    runDetail: ({ installation, runId }) =>
      Stream.unwrap(Effect.map(doorTo(doors, installation), (door) => runDetailOn(door, runId))),
    runFile: ({ installation, runId, ref, offset }) =>
      doorTo(doors, installation).pipe(
        Effect.flatMap((door) => runFileOn(door, runId, ref, offset)),
      ),
  });
  return yield* Layer.launch(
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(toView))),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// Quitting may end the process before any scope closes, and an SSH master would outlive it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
