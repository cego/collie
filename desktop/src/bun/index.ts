// Desktop's main process: one window on the view, and every Machine's board relayed to it
// as Effect RPC over Electrobun's message channel.

import { hostname } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Config,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import Electrobun, { BrowserView, BrowserWindow, type RPCSchema, Utils } from "electrobun/bun";
import {
  type Channel,
  type FrameSchema,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../shared/channel";
import { ActionFailed, DesktopRpcs, type FlockItem, type UpdateNews } from "../shared/flock";
import {
  act,
  type Door,
  doorTo,
  offersOn,
  workflowsOn,
  endChildren,
  flockStream,
  herdrMachines,
  localRoute,
  type Route,
  remoteRoute,
} from "./machine";
import { electrobunUpdater } from "./electrobun-updater";
import { savedBoards, saving } from "./saved";
import { applyAtLaunch, restartToUpdate, watchForUpdates } from "./updates";
// The version Desktop keeps every Machine on: the Collie it was built from.
import manifest from "../../../herdr-plugin.toml";

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

// Opened once an update readied before the last quit has had its chance to install, so
// installing one never shows a window that closes again.
let window: BrowserWindow<typeof rpc> | undefined;
const openWindow = () =>
  Effect.sync(() => {
    window = new BrowserWindow({
      title: "Collie",
      url: "views://mainview/index.html",
      renderer: "cef",
      frame: { width: 1200, height: 800, x: 120, y: 80 },
      rpc,
    });
  });

const toView: Channel<ToView, ToMain> = {
  send: (frame) => window?.webview.rpc?.send.frame(frame),
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
  const updater = yield* electrobunUpdater;
  yield* applyAtLaunch(updater).pipe(
    Effect.catch((reason) => Effect.logWarning(`Desktop update not installed: ${reason}`)),
  );
  yield* openWindow();
  const updates = yield* SubscriptionRef.make<UpdateNews | null>(null);
  yield* watchForUpdates(updater).pipe(
    Stream.runForEach((news) => SubscriptionRef.set(updates, news)),
    Effect.forkScoped,
  );
  const local = hostname();
  const collie = yield* Collie;
  const fs = yield* FileSystem.FileSystem;
  // Short, because a control socket's path is capped at about 100 bytes.
  const controls = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ssh-" });
  // herdr's list is the only list of Machines there is.
  const listed = yield* herdrMachines("herdr").pipe(Effect.result);
  const now = yield* Clock.currentTimeMillis;
  const [enabled, unlisted] = Result.match(listed, {
    onSuccess: (machines) => [machines, []] as const,
    onFailure: (reason): readonly [[], FlockItem[]] => [
      [],
      [
        {
          _tag: "Lost",
          machine: { profile: "herdr", name: "herdr's machines" },
          state: "unreachable",
          reason,
          at: now,
        },
      ],
    ],
  });
  const remote = yield* Effect.forEach(enabled, (machine, at) =>
    remoteRoute("ssh", `${controls}/${at}`, machine, local),
  );
  const routes: ReadonlyArray<Route> = [localRoute(collie, local), ...remote];
  const profiles = new Set(routes.map(({ machine }) => machine.profile));
  const doors = new Map<string, Door>();
  const boards = `${Utils.paths.userData}/machines`;
  const handlers = DesktopRpcs.toLayer({
    flock: () =>
      Stream.fromIterableEffect(
        // A Machine herdr no longer lists is not Desktop's to show.
        savedBoards(boards).pipe(
          Effect.map((saved) => saved.filter(({ machine }) => profiles.has(machine.profile))),
        ),
      ).pipe(
        Stream.concat(
          Stream.merge(Stream.fromIterable(unlisted), flockStream(routes, doors, manifest.version)),
        ),
        saving(boards),
        Stream.provide(BunServices.layer),
      ),
    act: ({ installation, action, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie));
        const door = yield* doorTo(doors, installation).pipe(
          Effect.mapError((failed) => new ActionFailed({ reason: failed.reason, request })),
        );
        return yield* act(door, request, action);
      }),
    openLink: ({ url }) => Effect.sync(() => void Utils.openExternal(url)),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door, runId))),
    workflows: ({ installation, project }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => workflowsOn(door, project))),
    updates: () =>
      SubscriptionRef.changes(updates).pipe(
        Stream.filter((news): news is UpdateNews => news !== null),
      ),
    restart: () =>
      restartToUpdate(updater).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
        Effect.provide(BunServices.layer),
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
