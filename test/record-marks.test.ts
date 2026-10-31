import { expect, test } from "bun:test";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { relayedRecords } from "../src/record-marks";

const wire = RpcSerialization.ndjson.makeUnsafe();
const line = (message: RpcMessage.FromClientEncoded | RpcMessage.FromServerEncoded) =>
  String(wire.encode(message));

test("the bridge names a record once, at the first answer to its runDetail request", () => {
  const relay = relayedRecords();
  relay.asked(
    line({
      _tag: "Request",
      id: "7",
      tag: "runDetail",
      payload: { runId: "run-a", tail: true, pages: 1, refreshMr: false, parts: true },
      headers: [],
    }) + line({ _tag: "Request", id: "8", tag: "board", payload: {}, headers: [] }),
  );
  const answer = line({ _tag: "Chunk", requestId: "7", values: [{ id: "run-a" }] });

  expect(
    relay.answered(line({ _tag: "Chunk", requestId: "8", values: [{ id: "other" }] })),
  ).toEqual([]);
  expect(
    relay.answered(line({ _tag: "Chunk", requestId: "17", values: [{ id: "other" }] })),
  ).toEqual([]);
  expect(relay.answered(answer)).toEqual(["run-a"]);
  expect(relay.answered(answer)).toEqual([]);
});
