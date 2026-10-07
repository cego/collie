// Effect RPC between Desktop's main process and its view, over any channel that carries
// JSON values. In the app that channel is Electrobun's own RPC, one `frame` message each way.

import { Effect, Option, Queue, Schema } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as RpcSerialization from "effect/rpc/RpcSerialization";

/** One end of the channel: what it sends, and what it hears from the other end. */
export interface Channel<Out, In> {
  readonly send: (frame: Out) => void;
  readonly listen: (receive: (frame: In) => void) => void;
}

/**
 * Sent by a view when it starts, so the main process ends what a view before a reload
 * left running and never mixes that view's request ids with the new one's.
 */
export interface Hello {
  readonly _tag: "Hello";
}
const HELLO: Hello = { _tag: "Hello" };

export type ToMain = RpcMessage.FromClientEncoded | Hello;
export type ToView = RpcMessage.FromServerEncoded;

/** What each end tells Electrobun its RPC carries: one `frame` message each way. */
export type FrameSchema = { requests: {}; messages: { frame: ToMain | ToView } };

// SAFETY: Electrobun JSON-encodes its messages already, so a frame goes as a value and the
// codec only has to make the protocol's `unknown` holes JSON-safe, as Effect's worker
// protocol does.
const codecFor = Schema.toCodecJson as RpcSerialization.CodecFor;

export const clientProtocol = (channel: Channel<ToMain, ToView>) =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const inbox = yield* Queue.unbounded<ToView>();
      channel.listen((frame) => Queue.offerUnsafe(inbox, frame));
      // ponytail: every response goes to every client; the view runs one client, and a
      // second one would need its request ids kept apart.
      yield* Queue.take(inbox).pipe(
        Effect.flatMap((response) =>
          Effect.forEach(clientIds, (id) => writeResponse(id, response), { discard: true }),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      channel.send(HELLO);
      return {
        send: (_clientId: number, request: RpcMessage.FromClientEncoded) =>
          Effect.sync(() => channel.send(request)),
        supportsAck: true,
        supportsTransferables: false,
        codecFor,
      };
    }),
  );

export const serverProtocol = (channel: Channel<ToView, ToMain>) =>
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const inbox = yield* Queue.unbounded<ToMain>();
      const disconnects = yield* Queue.unbounded<number>();
      // ponytail: one view at a time; a Desktop with several windows keys clients by window.
      let clientId = 0;
      channel.listen((frame) => Queue.offerUnsafe(inbox, frame));
      yield* Queue.take(inbox).pipe(
        Effect.flatMap((message) => {
          if (message._tag !== "Hello") return writeRequest(clientId, message);
          Queue.offerUnsafe(disconnects, clientId++);
          return Effect.void;
        }),
        Effect.forever,
        Effect.forkScoped,
      );
      return {
        disconnects,
        send: (id: number, response: ToView) =>
          Effect.sync(() => {
            if (id === clientId) channel.send(response);
          }),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set([clientId])),
        initialMessage: Effect.succeed(Option.none()),
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor,
      };
    }),
  );
