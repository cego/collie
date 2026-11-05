import { expect, test } from "bun:test";
import { Array as Arr } from "effect";
import {
  CAP_BYTES,
  EMPTY_KEPT,
  POINT_MS,
  closed,
  keptKeys,
  opened,
  pointed,
  settled,
  sized,
  type KeptSet,
} from "../src/shared/kept-records";

const openAll = (keys: ReadonlyArray<string>, from: KeptSet = EMPTY_KEPT) =>
  Arr.reduce(keys, from, (set, key) => opened(closed(set), key));

test("opening ten records keeps the open one and the last eight, and lets go of the oldest", () => {
  const keys = Arr.makeBy(10, (at) => `r-${at}`);
  const set = openAll(keys);
  expect([...keptKeys(set)].sort()).toEqual(Arr.drop(keys, 1).sort());
  expect(keptKeys(set).has("r-0")).toBe(false);
});

test("a closed record stays kept", () => {
  expect([...keptKeys(closed(opened(EMPTY_KEPT, "r-1")))]).toEqual(["r-1"]);
});

test("over the byte cap the least recently opened goes first, and never the open record", () => {
  const set = openAll(["a", "b", "c"]);
  const big = Arr.reduce(["a", "b"], set, (kept, key) => sized(kept, key, CAP_BYTES / 2 - 1));
  expect([...keptKeys(big)].sort()).toEqual(["a", "b", "c"]);
  const over = sized(big, "c", 4);
  expect([...keptKeys(over)].sort()).toEqual(["b", "c"]);
  const huge = sized(over, "c", CAP_BYTES * 2);
  expect([...keptKeys(huge)]).toEqual(["c"]);
});

test("a card pointed at for 150 ms is kept, and one pointed away from sooner is not", () => {
  const at = pointed(EMPTY_KEPT, "p", 1_000);
  expect(keptKeys(settled(at, 1_000 + POINT_MS - 50)).has("p")).toBe(false);
  expect(keptKeys(settled(pointed(at, null, 1_100), 1_000 + POINT_MS)).has("p")).toBe(false);
  expect(keptKeys(settled(at, 1_000 + POINT_MS)).has("p")).toBe(true);
});

test("a record pointed at and then opened is kept once, as the open one", () => {
  const set = opened(settled(pointed(EMPTY_KEPT, "p", 0), POINT_MS), "p");
  expect([...keptKeys(set)]).toEqual(["p"]);
  expect([...keptKeys(closed(set))]).toEqual(["p"]);
});
