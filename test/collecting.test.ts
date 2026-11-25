import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect } from "effect";
import { Collecting, collectingLayer, owedEver, owedFor, released } from "../src/collecting";
import { runEffect } from "./support/effect";

const ended = (...ids: ReadonlyArray<[string, number]>) => ({
  under: false,
  ended: Arr.map(ids, ([id, at]) => ({ id, at, began: 0 })),
  untold: [],
});

test("a rewrite after the verify ended keeps that verify owed for the rest of the turn", () => {
  const hold = ended(["v1", 150]);
  expect(owedFor(200, hold)).toEqual([]);
  expect(owedEver(["v1"], 200, hold)).toEqual(["v1"]);
  expect(released(owedEver(["v1"], 200, hold), false, () => true)).toBe(false);
});

test("a verify that began after the Output was written is not one it waits on", () => {
  const hold = {
    under: false,
    ended: [{ id: "v1", began: 120, at: 150 }],
    untold: [],
  };
  expect(owedFor(100, hold)).toEqual([]);
  expect(owedFor(130, hold)).toEqual(["v1"]);
});

test("every verify that ended after the Output was written is owed its tell, not only the last", () => {
  const hold = ended(["v1", 150], ["v2", 160]);
  expect(owedFor(100, hold)).toEqual(["v1", "v2"]);
  expect(released(owedFor(100, hold), true, (one) => one === "v2")).toBe(false);
  expect(released(owedFor(100, hold), true, () => true)).toBe(true);
});

test("a verify that ended before the Output was written is not something that Output waits on", () => {
  expect(owedFor(200, ended(["v1", 150]))).toEqual([]);
  expect(released(owedFor(200, ended(["v1", 150])), false, () => false)).toBe(false);
});

test("an Output is not taken until the agent is idle and its tell was taken", () => {
  const owed = owedFor(100, ended(["v1", 150]));
  expect(released(owed, false, () => true)).toBe(false);
  expect(released(owed, true, () => false)).toBe(false);
  expect(released(owed, true, () => true)).toBe(true);
});

test("a collection that has not ended is never released", () => {
  expect(released([], false, () => true)).toBe(false);
  expect(released([], true, () => true)).toBe(true);
});

test("a finished agent's verify is retired once no collection needs it", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
          expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(1);
        }),
      );
      expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(0);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a collection of another agent keeps no agent's verify alive", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      const held = yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
          yield* collecting.during("r", "b", Effect.succeed(null));
          expect(yield* collecting.has("r", "a")).toBe(true);
          expect(yield* collecting.has("r", "b")).toBe(false);
          return (yield* collecting.verifying("r", "a")).ended.length;
        }),
      );
      expect(held).toBe(1);
      expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(0);
      expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a launch's own collection is counted apart from the agent's", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
          yield* collecting.during(
            "r",
            "a",
            Effect.gen(function* () {
              expect(yield* collecting.has("r", "a", "launch-1")).toBe(true);
              expect(yield* collecting.has("r", "a")).toBe(true);
            }),
            "launch-1",
          );
          expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
          expect(yield* collecting.has("r", "a")).toBe(true);
        }),
        "launch-2",
      );
      expect(yield* collecting.has("r", "a", "launch-2")).toBe(false);
      expect(yield* collecting.has("r", "a")).toBe(false);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a verify whose tell could not be sent is not released by the absence of a tell", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
      expect((yield* collecting.verifying("r", "a")).untold).toEqual([]);
      yield* collecting.markUntold("r", "a", "v1");
      expect((yield* collecting.verifying("r", "a")).untold).toEqual(["v1"]);
    }).pipe(Effect.provide(collectingLayer)),
  ));
