// What the engine wrote, by execution. Every change to a workflow's state is a message or a
// reply the engine stores, so a count that moves with each one says when a Run's engine
// state may have moved, and a Run whose count stands needs no asking.

import { Context, Effect, Layer } from "effect";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import type * as SqlClient from "effect/sql/SqlClient";

export class EngineTouches extends Context.Service<
  EngineTouches,
  {
    /** Moves whenever the engine stores anything for this execution, or forgets anything. */
    readonly of: (execution: string) => number;
    readonly touch: (execution: string) => void;
    /** Moves every count: something was forgotten, of whichever execution. */
    readonly forget: () => void;
  }
>()("collie/EngineTouches") {}

export const engineTouchesLayer = Layer.sync(EngineTouches)(() => {
  const counts = new Map<string, number>();
  let epoch = 0;
  return {
    of: (execution) => epoch + (counts.get(execution) ?? 0),
    touch: (execution) => void counts.set(execution, (counts.get(execution) ?? 0) + 1),
    forget: () => void epoch++,
  };
});

/** `inner`, telling `touches` of each write it makes, by the execution it is for. */
export const touching = (
  inner: MessageStorage.MessageStorage["Service"],
  sql: SqlClient.SqlClient,
  touches: EngineTouches["Service"],
): MessageStorage.MessageStorage["Service"] => {
  // A reply names only its request; the request named its entity when it was saved.
  const owners = new Map<string, string>();
  const ownerOf = (requestId: bigint) => {
    const known = owners.get(String(requestId));
    if (known !== undefined) return Effect.succeed(known);
    // Saved before this host started.
    return sql<{ readonly entity_id: string }>`
      SELECT entity_id FROM cluster_messages WHERE id = ${String(requestId)}
    `.pipe(
      Effect.map((rows) => rows[0]?.entity_id),
      Effect.orElseSucceed(() => undefined),
    );
  };
  const touchOwner = (requestId: bigint, settled: boolean) =>
    Effect.flatMap(ownerOf(requestId), (owner) =>
      Effect.sync(() => {
        if (owner === undefined) touches.forget();
        else touches.touch(owner);
        if (settled) owners.delete(String(requestId));
      }),
    );
  return {
    ...inner,
    saveRequest: (envelope) =>
      Effect.tap(inner.saveRequest(envelope), () =>
        Effect.sync(() => {
          owners.set(String(envelope.envelope.requestId), envelope.envelope.address.entityId);
          touches.touch(envelope.envelope.address.entityId);
        }),
      ),
    saveEnvelope: (envelope) =>
      Effect.tap(inner.saveEnvelope(envelope), () =>
        Effect.sync(() => touches.touch(envelope.envelope.address.entityId)),
      ),
    saveReply: (reply) =>
      Effect.tap(inner.saveReply(reply), () =>
        touchOwner(reply.reply.requestId, reply.reply._tag === "WithExit"),
      ),
    clearReplies: (requestId, options) =>
      Effect.tap(inner.clearReplies(requestId, options), () => touchOwner(requestId, false)),
    clearAddress: (address) =>
      Effect.tap(inner.clearAddress(address), () => Effect.sync(touches.forget)),
  };
};
