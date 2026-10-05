// Desktop's main process: one window on the view, every Machine's board relayed to it as
// Effect RPC over Electrobun's message channel, and the Flock chat beside them.

import { hostname } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Config,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Result,
  Schema,
  Scope,
  Stream,
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
import { ActionFailed, DesktopRpcs, type FlockItem, machineNames } from "../shared/flock";
import { type FlockConversation, openFlockChat, refusal } from "./chat";
import { chatDoor } from "./flock-tools";
import { readSettings, writeSettings } from "./settings";
import {
  act,
  bridgeCommand,
  doorTo,
  offersOn,
  workflowsOn,
  endChildren,
  flockStream,
  herdrMachines,
  openDoors,
  type Route,
  remoteRoute,
} from "./machine";

type Frames = RPCSchema<FrameSchema>;

/** A window on the view, and the channel its RPC rides. */
const windowOn = (url: string, title: string, frame: BrowserWindow["frame"]) => {
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
  const window = new BrowserWindow({ title, url, renderer: "cef", frame, rpc });
  const channel: Channel<ToView, ToMain> = {
    send: (frame) => window.webview.rpc?.send.frame(frame),
    listen: (listener) => {
      receive = listener;
    },
  };
  return { window, channel };
};

const VIEW = "views://mainview/index.html";
const board = windowOn(VIEW, "Collie", { width: 1200, height: 800, x: 120, y: 80 });

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

/** Where Desktop keeps what is its own on this computer, the Flock chat's session among it. */
const StateDir = Config.String("XDG_STATE_HOME").pipe(
  Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.local/state`))),
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
    { machine: { name: local }, open: openDoors((as) => bridgeCommand(collie, local, as)) },
    ...remote,
  ];
  // Each route's Doors know its Machine, so the chat's tools can name it.
  const named = routes.map((route) => ({
    ...route,
    open: Effect.map(route.open, (doors) => ({ ...doors, machine: route.machine })),
  }));
  const scope = yield* Effect.scope;
  const doors = new Map<string, Effect.Success<(typeof named)[number]["open"]>>();
  const own = (yield* Path.Path).join(yield* StateDir, "collie-desktop");
  let settings = yield* readSettings(own);
  // Opened by the view's first ask, in Desktop's own scope; its session starts with the first message.
  const chat = yield* openFlockChat({
    dir: own,
    conversation: `flock@${local}`,
    proactive: () => settings.proactive,
    machines: () => {
      const shown = [...doors].map(([installation, { machine }]) => ({ ...machine, installation }));
      const names = machineNames(shown);
      return [...doors].map(([installation, held]) => ({
        name: names.get(installation) ?? held.machine.name,
        door: chatDoor(held.chat),
      }));
    },
  }).pipe(Scope.provide(scope), Effect.result, Effect.cached);
  // ponytail: a chat that could not start stays so until Desktop restarts.
  const withChat = <A>(use: (opened: FlockConversation) => Effect.Effect<A>, unstarted: A) =>
    chat.pipe(
      Effect.flatMap(Result.match({ onSuccess: use, onFailure: () => Effect.succeed(unstarted) })),
    );
  let popped:
    | { readonly window: BrowserWindow; readonly closed: Deferred.Deferred<void> }
    | undefined;
  const handlers = DesktopRpcs.toLayer({
    // Every board change may have left News, so each one nudges the chat to look.
    flock: () =>
      Stream.merge(Stream.fromIterable(unlisted), flockStream(named, doors)).pipe(
        Stream.tap(() => withChat((opened) => opened.nudge, undefined)),
      ),
    act: ({ installation, action, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie));
        const door = yield* doorTo(doors, installation).pipe(
          Effect.mapError((failed) => new ActionFailed({ reason: failed.reason, request })),
        );
        return yield* act(door.desktop, request, action);
      }),
    openLink: ({ url }) => Effect.sync(() => void Utils.openExternal(url)),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door.desktop, runId))),
    workflows: ({ installation, project }) =>
      doorTo(doors, installation).pipe(
        Effect.flatMap((door) => workflowsOn(door.desktop, project)),
      ),
    say: ({ text, about }) =>
      Stream.unwrap(
        Effect.map(chat, (opened) =>
          Result.match(opened, {
            onSuccess: (conversation) => conversation.send(text, about),
            onFailure: (cause) =>
              Stream.make(refusal(`The Flock chat could not start: ${String(cause)}`)),
          }),
        ),
      ),
    answer: ({ toolCallId, answers }) =>
      withChat((opened) => opened.answer(toolCallId, answers), undefined),
    transcript: () => withChat((opened) => opened.transcript, []),
    conversations: () => withChat((opened) => opened.conversations, { current: "", earlier: [] }),
    reopen: ({ session }) => withChat((opened) => opened.reopen(session), undefined),
    // Annotated because it serves its own window through `servedOn`, which needs these handlers.
    popOut: (): Effect.Effect<void, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
      Effect.gen(function* () {
        if (popped === undefined) {
          const opened = windowOn(`${VIEW}#chat`, "Flock chat", {
            width: 480,
            height: 800,
            x: 1340,
            y: 80,
          });
          const closed = Deferred.makeUnsafe<void>();
          opened.window.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
          popped = { window: opened.window, closed };
          yield* Layer.launch(servedOn(opened.channel)).pipe(
            Effect.raceFirst(Deferred.await(closed)),
            Effect.ensuring(Effect.sync(() => (popped = undefined))),
            Effect.forkIn(scope),
          );
        } else popped.window.activate();
        yield* Deferred.await(popped.closed);
      }),
    popIn: () => Effect.sync(() => popped?.window.close()),
    desktopTurns: () =>
      Stream.unwrap(withChat((opened) => Effect.succeed(opened.desktopTurns), Stream.empty)),
    settings: () => Effect.sync(() => settings),
    setSettings: (changed) =>
      writeSettings(own, changed).pipe(
        Effect.andThen(
          Effect.sync(() => {
            settings = changed;
          }),
        ),
        Effect.orDie,
      ),
  });
  const servedOn = (channel: Channel<ToView, ToMain>) =>
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(channel))),
    );
  return yield* Layer.launch(servedOn(board.channel));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// Quitting may end the process before any scope closes, and an SSH master would outlive it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
