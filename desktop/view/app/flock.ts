// The Flock as the view holds it: the main process's `flock` stream, decoded with the
// board's own Schemas and folded into each Machine's Tasks.

import { Atom, AtomRpc } from "@effect/atom-vue";
import { Effect, Layer, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import { Electroview, type RPCSchema } from "electrobun/view";
import {
  type Channel,
  type FrameSchema,
  clientProtocol,
  type ToMain,
  type ToView,
} from "../../src/shared/channel";
import { DesktopRpcs, flockOf } from "../../src/shared/flock";

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

/** When the Flock chat starts and ends a turn of Desktop's own; kept alive with the view. */
export const desktopTurnsAtom = FlockClient.runtime
  .atom(
    Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("desktopTurns", undefined)))),
  )
  .pipe(Atom.keepAlive);

/** Kept alive, so the board stays subscribed for as long as the view is open. */
export const flockAtom = FlockClient.runtime
  .atom(
    flockOf(Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("flock", undefined))))),
  )
  .pipe(Atom.keepAlive);
