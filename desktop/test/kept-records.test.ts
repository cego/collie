import { expect, test } from "bun:test";
import { Array as Arr, Option } from "effect";
import type { RunDetail } from "../../src/board-model";
import { mainFlow } from "../../test/support/flow";
import type { KeptRecord } from "../src/shared/flock";
import {
  CAP_BYTES,
  EMPTY_KEPT,
  POINT_MS,
  closed,
  keptHolder,
  keptKeys,
  opened,
  pointed,
  settled,
  sized,
  type KeptSet,
  withFlowKept,
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

const holding = () => {
  const held = new Set<string>();
  const sizes = new Map<string, (bytes: number) => void>();
  const due: Array<{ at: number; run: () => void }> = [];
  let now = 0;
  const holder = keptHolder(
    (key, sized) => {
      held.add(key);
      sizes.set(key, sized);
      return () => held.delete(key);
    },
    () => now,
    (ms, run) => due.push({ at: now + ms, run }),
  );
  const advance = (ms: number) => {
    now += ms;
    for (const one of Arr.filter(due, ({ at }) => at <= now)) one.run();
  };
  return { holder, held, sizes, advance };
};

test("a record closed is still held, and the oldest past eight is let go", () => {
  const { holder, held } = holding();
  for (const key of Arr.makeBy(10, (at) => `r-${at}`)) holder.opened(key);
  expect([...held].sort()).toEqual(Arr.makeBy(9, (at) => `r-${at + 1}`).sort());
  holder.closed("r-9");
  expect(held.has("r-9")).toBe(true);
  expect(held.has("r-1")).toBe(false);
});

test("a card pointed at for 150 ms is held, and one left sooner is not", () => {
  const { holder, held, advance } = holding();
  holder.pointed("soon");
  advance(100);
  holder.pointed(null);
  advance(100);
  expect(held.has("soon")).toBe(false);
  holder.pointed("rested");
  advance(POINT_MS);
  expect(held.has("rested")).toBe(true);
});

test("a held record's frame over the cap lets the least recently opened go, never the open one", () => {
  const { holder, held, sizes } = holding();
  for (const key of ["a", "b"]) {
    holder.opened(key);
    holder.closed(key);
  }
  holder.opened("c");
  sizes.get("c")!(CAP_BYTES - 10);
  sizes.get("a")!(20);
  expect([...held].sort()).toEqual(["b", "c"]);
});

test("a kept record's frame sent without the Flow it already had keeps that Flow", () => {
  // SAFETY: the test reads only a frame's title and Flow.
  const bare = (title: string) => ({ title }) as RunDetail;
  const record = (detail: RunDetail): KeptRecord => ({ detail, asOf: null, bytes: 1 });
  const head = record({ ...bare("head"), flow: mainFlow() });
  const later = withFlowKept(Option.some(head), record(bare("later")));
  expect(later.detail?.title).toBe("later");
  expect(later.detail?.flow).toBe(head.detail!.flow);
  expect(withFlowKept(Option.none(), record(bare("first"))).detail?.flow).toBeUndefined();
  const none: KeptRecord = { detail: null, asOf: null, bytes: 0 };
  expect(withFlowKept(Option.some(head), none)).toBe(none);
});
