// The Flock as the view holds it: the main process's `flock` stream, decoded with the
// board's own Schemas and folded into each Machine's Tasks.

import { Atom, AtomRpc } from "@effect/atom-vue";
import { Effect, Layer, Schema, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
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

/** Desktop's own update news, kept alive so a ready update is heard whenever it is. */
export const updatesAtom = FlockClient.runtime
  .atom(Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("updates", undefined)))))
  .pipe(Atom.keepAlive);

/** How the board's window is drawn, told again as its zoom is decided again. */
export const drawnAtom = FlockClient.runtime.atom(
  Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("drawn", undefined)))),
);

/** Which credentials Desktop holds, kept alive so a token due for renewal is always heard. */
export const credentialsAtom = FlockClient.runtime
  .atom(
    Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("credentials", undefined)))),
  )
  .pipe(Atom.keepAlive);
/** The Flock's settings; asking syncs every connected Machine first. */
export const flockSettingsAtom = FlockClient.runtime.atom(
  Stream.unwrap(FlockClient.use((client) => Effect.succeed(client("flockSettings", undefined)))),
);
/** A Run's details while some record shows them, keyed by `runDetailKey`. */
export const runDetailAtom = Atom.family((key: string) => {
  const { installation, runId } = Schema.decodeSync(RunOn)(key);
  return FlockClient.runtime.atom(
    Stream.unwrap(
      FlockClient.use((client) => Effect.succeed(client("runDetail", { installation, runId }))),
    ),
  );
});

const RunOn = Schema.fromJsonString(
  Schema.Struct({ installation: Schema.String, runId: Schema.String }),
);
export const runDetailKey = Schema.encodeSync(RunOn);
