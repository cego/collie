import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import * as Arr from "effect/Array";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Envelope from "effect/cluster/Envelope";
import * as Snowflake from "effect/cluster/Snowflake";
import * as SqlMessageStorage from "effect/cluster/SqlMessageStorage";
import * as Digest from "effect/crypto/Digest";
import * as Reactivity from "effect/reactivity/Reactivity";

const sqlite = SqliteClient.layer({ filename: ":memory:" }).pipe(Layer.provide(Reactivity.layer));
const requestId = Snowflake.Snowflake(BigInt(1));
const suspendedReplyId = Snowflake.Snowflake(BigInt(3));
const address = {
  shardId: { group: "default", id: 1 },
  entityType: "Workflow/release",
  entityId: "release-set",
};
const request = {
  _tag: "Request",
  requestId: String(requestId),
  address,
  tag: "activity",
  payload: { name: "web.merged", attempt: 1 },
  headers: {},
} satisfies Envelope.PartialRequestEncoded;

test("a conditional SQL activity reset does not replay the interrupt that suspended it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* SqlMessageStorage.makeEncoded();
      yield* storage.saveEnvelope({
        envelope: request,
        primaryKey: "web.merged/1",
        deliverAt: null,
      });
      yield* storage.saveEnvelope({
        envelope: { _tag: "Interrupt", id: "2", requestId: String(requestId), address },
        primaryKey: null,
        deliverAt: null,
      });
      yield* storage.saveReply({
        _tag: "WithExit",
        id: String(suspendedReplyId),
        requestId: String(requestId),
        exit: { _tag: "Success", value: { _tag: "Suspended" } },
      });
      yield* storage.saveEnvelope({
        envelope: { _tag: "Interrupt", id: "4", requestId: String(requestId), address },
        primaryKey: null,
        deliverAt: null,
      });

      yield* storage.clearReplies(requestId, { expectedReplyId: suspendedReplyId });

      const replay = yield* storage.unprocessedMessages(["default:1"], 0);
      expect(Arr.map(replay, ({ envelope }) => envelope._tag)).toEqual(["Request"]);
      expect(yield* storage.repliesFor([String(requestId)])).toEqual([]);
    }).pipe(Effect.provide([sqlite, Digest.layerWebCrypto])),
  ));

test("a stale conditional SQL reset preserves a newer interrupt and completed reply", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const storage = yield* SqlMessageStorage.makeEncoded();
      yield* storage.saveEnvelope({
        envelope: request,
        primaryKey: "web.merged/1",
        deliverAt: null,
      });
      yield* storage.saveReply({
        _tag: "WithExit",
        id: String(suspendedReplyId),
        requestId: String(requestId),
        exit: { _tag: "Success", value: { _tag: "Suspended" } },
      });
      yield* storage.clearReplies(requestId, { expectedReplyId: suspendedReplyId });
      yield* storage.saveEnvelope({
        envelope: { _tag: "Interrupt", id: "4", requestId: String(requestId), address },
        primaryKey: null,
        deliverAt: null,
      });

      yield* storage.clearReplies(requestId, { expectedReplyId: suspendedReplyId });

      const replay = yield* storage.unprocessedMessages(["default:1"], 0);
      expect(Arr.map(replay, ({ envelope }) => envelope._tag)).toEqual(["Request", "Interrupt"]);
      const completed = {
        _tag: "WithExit",
        id: "5",
        requestId: String(requestId),
        exit: {
          _tag: "Success",
          value: { _tag: "Complete", exit: { _tag: "Success", value: "merged" } },
        },
      } as const;
      yield* storage.saveReply(completed);

      yield* storage.clearReplies(requestId, { expectedReplyId: suspendedReplyId });

      expect(yield* storage.repliesFor([String(requestId)])).toEqual([completed]);
      expect(yield* storage.unprocessedMessages(["default:1"], 0)).toEqual([]);
    }).pipe(Effect.provide([sqlite, Digest.layerWebCrypto])),
  ));
