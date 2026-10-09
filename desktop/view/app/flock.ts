// The Flock as the view holds it: the main process's `flock` stream, decoded with the
// board's own Schemas and folded into each Machine's Tasks.

import { Atom, AtomRpc } from "@effect/atom-vue";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import { Electroview, type RPCSchema } from "electrobun/view";
import {
  type Channel,
  type FrameSchema,
  clientProtocol,
  type ToMain,
  type ToView,
} from "../../src/shared/channel";
import {
  applyItem,
  DesktopRpcs,
  EMPTY_FLOCK,
  type Flock,
  type FlockItem,
} from "../../src/shared/flock";
import { foldedOf, heldOf, retryWake } from "../../src/shared/retrying";

type Frames = RPCSchema<FrameSchema>;

const toMain = (): Channel<ToMain, ToView> => {
  let receive: (frame: ToView) => void = () => {};
  const view = new Electroview({
    rpc: Electroview.defineRPC<{ bun: Frames; webview: Frames }>({
      handlers: {
        requests: {},
        // SAFETY: only the main process sends on this channel, and it sends nothing but `ToView`.
        messages: { frame: (frame) => receive(frame as ToView) },
      },
    }),
  });
  return {
    send: (frame) => view.rpc?.send.frame(frame),
    listen: (listener) => {
      receive = listener;
    },
  };
};

export class FlockClient extends AtomRpc.Service<FlockClient>()("FlockClient", {
  group: DesktopRpcs,
  protocol: Layer.effect(
    RpcClient.Protocol,
    Effect.suspend(() => clientProtocol(toMain())),
  ),
}) {}

/** Retry now, for every subscription waiting out its backoff. */
export const retry = retryWake();

/** A subscription kept through its failures and taken again by itself. */
const held = <A, E extends Error, R>(subscription: Stream.Stream<A, E, R>) =>
  heldOf(subscription, retry.waited);

/** When the Flock chat starts and ends a turn of Desktop's own; kept alive with the view. */
export const desktopTurnsAtom = FlockClient.runtime
  .atom(
    held(
      Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("desktopTurns", undefined)))),
    ),
  )
  .pipe(Atom.keepAlive);

export const conversationChangesAtom = FlockClient.runtime
  .atom(
    held(
      Stream.unwrap(
        FlockClient.use((client) => Effect.succeed(client("conversationChanges", undefined))),
      ),
    ),
  )
  .pipe(Atom.keepAlive);

/** Kept alive, so the board stays subscribed for as long as the view is open. */
export const flockAtom = FlockClient.runtime
  .atom(
    foldedOf(
      Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("flock", undefined)))),
      retry.waited,
      (held: Option.Option<Flock>, item: FlockItem) =>
        applyItem(
          Option.getOrElse(held, () => EMPTY_FLOCK),
          item,
        ),
    ),
  )
  .pipe(Atom.keepAlive);

/** Desktop's own update news, kept alive so a ready update is heard whenever it is. */
export const updatesAtom = FlockClient.runtime
  .atom(
    held(Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("updates", undefined))))),
  )
  .pipe(Atom.keepAlive);

/** How the board's window is drawn, told again as its zoom is decided again. */
export const drawnAtom = FlockClient.runtime.atom(
  held(Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("drawn", undefined))))),
);

/** Which credentials Desktop holds, kept alive so a token due for renewal is always heard. */
export const credentialsAtom = FlockClient.runtime
  .atom(
    held(
      Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("credentials", undefined)))),
    ),
  )
  .pipe(Atom.keepAlive);
/** The Flock's settings; asking syncs every connected Machine first. */
export const flockSettingsAtom = FlockClient.runtime.atom(
  held(
    Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("flockSettings", undefined)))),
  ),
);
/** A Run's details while some record shows them, keyed by `runDetailKey`. */
export const runDetailAtom = Atom.family((key: string) =>
  FlockClient.runtime.atom(
    held(
      Stream.unwrap(
        FlockClient.use((client) =>
          Effect.succeed(client("runDetail", Schema.decodeSync(RunOn)(key))),
        ),
      ),
    ),
  ),
);

const RunOn = Schema.fromJsonString(
  Schema.Struct({ installation: Schema.String, runId: Schema.String }),
);
export const runDetailKey = Schema.encodeSync(RunOn);
