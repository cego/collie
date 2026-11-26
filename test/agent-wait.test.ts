import { expect, test } from "bun:test";
import { Clock, Effect, Exit, Ref } from "effect";
import type { Fiber } from "effect";
import { TestClock } from "effect/testing";
import { waitForAgents } from "../src/agent-wait";
import { runEffect } from "./support/effect";

const settled = (fiber: Fiber.Fiber<string, never>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 5; turn++) {
      yield* Effect.yieldNow;
    }
    return fiber.pollUnsafe();
  });

test("a wait that outlives its budget ends at the budget, not at the first poll after it", () =>
  runEffect(
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const waited = yield* waitForAgents({
        budget: 250,
        poll: 100,
        rosterBudget: 10_000,
        working: Effect.succeed(["helper"]),
        stopped: Effect.succeed(false),
        tell: () => Effect.void,
      }).pipe(Effect.forkScoped);
      yield* TestClock.adjust("240 millis");
      expect(yield* settled(waited)).toBeUndefined();
      yield* TestClock.adjust("10 millis");
      const ended = yield* settled(waited);
      expect(Exit.isSuccess(ended!) && ended.value).toBe("overrun");
      expect((yield* Clock.currentTimeMillis) - start).toBe(250);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("a stop ends the wait while a roster read is still in flight", () =>
  runEffect(
    Effect.gen(function* () {
      const stopped = yield* Ref.make(false);
      const waited = yield* waitForAgents({
        budget: 60_000,
        poll: 100,
        rosterBudget: 10_000,
        working: Effect.never,
        stopped: Ref.get(stopped),
        tell: () => Effect.void,
      }).pipe(Effect.forkScoped);
      yield* TestClock.adjust("50 millis");
      expect(yield* settled(waited)).toBeUndefined();
      yield* Ref.set(stopped, true);
      yield* TestClock.adjust("50 millis");
      const ended = yield* settled(waited);
      expect(Exit.isSuccess(ended!) && ended.value).toBe("stopped");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
