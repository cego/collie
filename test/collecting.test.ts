import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Collecting, collectingLayer, owedFor, released } from "../src/collecting";
import { runEffect } from "./support/effect";

test("a verify that ended after collection began is owed its tell, even if no poll saw it under way", () => {
  expect(owedFor(100, { under: false, ended: "v1", endedAt: 150 })).toEqual({
    since: 100,
    id: "v1",
  });
  expect(owedFor(100, { under: true, ended: null, endedAt: null })).toBe(null);
  expect(owedFor(100, { under: false, ended: "v0", endedAt: 90 })).toBe(null);
  expect(owedFor(100, { under: false, ended: null, endedAt: null })).toBe(null);
});

test("a tell that never arrived holds the Output whatever else ended a turn", () => {
  const owed = { since: 100, id: "v1" };
  expect(released(null, false, false)).toBe(true);
  expect(released(owed, true, false)).toBe(false);
  expect(released(owed, false, true)).toBe(false);
  expect(released(owed, true, true)).toBe(true);
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
          expect((yield* collecting.verifying("r", "a")).ended).toBe("v1");
        }),
      );
      expect((yield* collecting.verifying("r", "a")).ended).toBe(null);
    }).pipe(Effect.provide(collectingLayer)),
  ));
