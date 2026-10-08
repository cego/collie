// Every subscription the view holds retries by itself: it keeps its last value, says what
// went wrong and when it tries again, backs off, and wakes on Retry now.

import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { untilStarted } from "../desktop/src/bun/chat";
import { ActionFailed } from "../desktop/src/shared/flock";
import { backoff, heldOf, retryWake, retrying } from "../desktop/src/shared/retrying";

/**
 * One subscription per entry: `fail` and `interrupt` end it so, `x!` gives x then fails,
 * and anything else gives itself and stays open.
 */
const scripted = (subscriptions: ReadonlyArray<string>) => {
  let at = 0;
  return Stream.suspend(() => {
    const now = subscriptions[at++] ?? "fail";
    if (now === "fail") return Stream.fail(new ActionFailed({ reason: "the host refused" }));
    if (now === "interrupt") return Stream.fromEffect(Effect.interrupt);
    return now.endsWith("!")
      ? Stream.make(now.slice(0, -1)).pipe(
          Stream.concat(Stream.fail(new ActionFailed({ reason: "the host refused" }))),
        )
      : Stream.make(now).pipe(Stream.concat(Stream.never));
  });
};

const never = retryWake();

test("a failing subscription says why and when it tries again, at 1 s then 2 s, then gives its value", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seen = yield* retrying(scripted(["fail", "fail", "up"]), never.waited).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(seen)).toEqual([
        { _tag: "Retrying", said: "the host refused", attempt: 1, at: 1_000 },
        { _tag: "Retrying", said: "the host refused", attempt: 2, at: 3_000 },
        { _tag: "Value", value: "up" },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a value starts the backoff afresh, and the wait never passes a minute", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seen = yield* retrying(scripted(["fail", "fail", "up!", "up"]), never.waited).pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("3 seconds");
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(seen)).slice(2)).toEqual([
        { _tag: "Value", value: "up" },
        { _tag: "Retrying", said: "the host refused", attempt: 1, at: 4_000 },
        { _tag: "Value", value: "up" },
      ]);
      expect([0, 5, 6, 20].map(backoff)).toEqual([1_000, 32_000, 60_000, 60_000]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("Retry now ends the wait at once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const retry = retryWake();
      const seen = yield* retrying(scripted(["fail", "up"]), retry.waited).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.withLive(Effect.sleep("10 millis"));
      retry.wake();
      expect((yield* Fiber.join(seen))[1]).toEqual({ _tag: "Value", value: "up" });
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a subscription cut off by an interrupt is taken again at once, and says nothing of it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect(
        yield* retrying(scripted(["interrupt", "up"]), never.waited).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      ).toEqual([{ _tag: "Value", value: "up" }]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("what a page holds keeps its last value through trouble", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const seen = yield* heldOf(scripted(["up!", "again"]), never.waited).pipe(
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(seen)).toEqual([
        { value: Option.none(), trouble: null },
        { value: Option.some("up"), trouble: null },
        {
          value: Option.some("up"),
          trouble: { said: "the host refused", attempt: 1, at: 1_000 },
        },
        { value: Option.some("again"), trouble: null },
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a Flock chat whose first start fails starts on the next ask", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let starts = 0;
      const chat = yield* untilStarted(
        Effect.suspend(() =>
          ++starts === 1 ? Effect.fail("not logged in to Claude") : Effect.succeed("started"),
        ),
      );
      expect(Exit.isFailure(yield* Effect.exit(chat))).toBe(true);
      expect(yield* chat).toBe("started");
      expect(yield* chat).toBe("started");
      expect(starts).toBe(2);
    }),
  ));
