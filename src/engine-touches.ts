// WARNING: each engine write moves the count, so an unchanged count means the Run's engine state is unchanged.
import { Context, Effect, Layer } from "effect";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import type * as SqlClient from "effect/sql/SqlClient";

export class EngineTouches extends Context.Service<
  EngineTouches,
  {
    readonly of: (execution: string) => number;
    readonly touch: (execution: string) => void;
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

export const touching: (
  inner: MessageStorage.MessageStorage["Service"],
  sql: SqlClient.SqlClient,
  touches: EngineTouches["Service"],
) => MessageStorage.MessageStorage["Service"] = (inner, sql, touches) => {
  // WARNING: a reply names only its request, which recorded its entity when saved.
  const owners = new Map<string, string>();
  const ownerOf = (requestId: bigint) => {
    const known = owners.get(String(requestId));
    if (known !== undefined) {
      return Effect.succeed(known);
    }
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
        if (owner === undefined) {
          touches.forget();
        } else {
          touches.touch(owner);
        }
        if (settled) {
          owners.delete(String(requestId));
        }
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
