import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Option } from "effect";
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

test("the bridge names a record whose request and answer arrive in fragments", () => {
  const relay = relayedRecords();
  const pieces = (text: string) => Option.getOrElse(Str.match(/[\s\S]{1,5}/g)(text), () => []);
  for (const piece of pieces(
    line({
      _tag: "Request",
      id: "7",
      tag: "runDetail",
      payload: { runId: "run-a", tail: true, pages: 1, refreshMr: false, parts: true },
      headers: [],
    }),
  ))
    relay.asked(piece);
  const named = Arr.flatMap(
    pieces(line({ _tag: "Chunk", requestId: "7", values: [{ id: "run-a" }] })),
    (piece) => relay.answered(piece),
  );
  expect(named).toEqual(["run-a"]);
});
