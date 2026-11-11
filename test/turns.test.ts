import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Queue, Result, Scheduler, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Foreground, makeForeground, servedNow } from "../src/foreground";
import { timingFirstValues } from "../src/host";
import { TurnScheduler } from "../src/turns";

test("a served fiber's turns come before those of busy background fibers", () => {
  let steps = 0;
  const busy = Effect.forever(Effect.suspend(() => (steps++, Effect.yieldNow)));
  return Effect.runPromise(
    Effect.gen(function* () {
      const foreground = yield* makeForeground;
      const background = yield* Effect.forEach(Arr.range(1, 3), () => Effect.forkChild(busy));
      yield* Effect.yieldNow;
      const before = steps;
      yield* foreground.serve(Effect.forEach(Arr.range(1, 50), () => Effect.yieldNow));
      const taken = steps - before;
      yield* Effect.forEach(background, Fiber.interrupt);
      return taken;
    }).pipe(
      Effect.forkChild,
      Effect.flatMap(Fiber.join),
      Effect.provideService(Scheduler.Scheduler, new TurnScheduler(servedNow)),
      Effect.map((taken) => expect(taken).toBeLessThan(10)),
    ),
  );
});

test("verify and read answers hold background slices only until their first value", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const foreground = yield* makeForeground;
        const clock = yield* TestClock.make();
        return yield* Effect.gen(function* () {
          const slices = yield* Queue.unbounded<void>();
          const passed = yield* Queue.unbounded<void>();
          let boundaries = 0;
          yield* Effect.forever(
            Effect.gen(function* () {
              yield* Queue.take(slices);
              yield* foreground.boundary;
              boundaries++;
              yield* Queue.offer(passed, undefined);
            }),
          ).pipe(Effect.forkScoped);
          yield* Queue.offer(slices, undefined);
          yield* Queue.take(passed);

          const verifying = yield* Deferred.make<void>();
          const releaseVerify = yield* Deferred.make<void>();
          const first = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const reading = yield* Deferred.make<void>();
          const releaseRead = yield* Deferred.make<void>();
          const handlers = timingFirstValues({
            verify: () =>
              Stream.callback<string>((queue) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(verifying, undefined);
                  yield* Deferred.await(releaseVerify);
                  yield* Queue.offer(queue, "Started");
                  yield* Deferred.await(finish);
                  expect(servedNow()).toBe(false);
                  yield* Queue.offer(queue, "Result");
                  yield* Queue.end(queue);
                }),
              ),
            read: () =>
              Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRead)),
                Effect.as("record"),
              ),
          });
          const verify = yield* handlers.verify().pipe(
            Stream.tap((value) =>
              value === "Started" ? Deferred.succeed(first, undefined) : Effect.void,
            ),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(verifying);
          yield* Queue.offer(slices, undefined);
          yield* clock.adjust("1 millis");
          expect(boundaries).toBe(1);

          yield* Deferred.succeed(releaseVerify, undefined);
          yield* Deferred.await(first);
          yield* Queue.take(passed);
          expect(boundaries).toBe(2);
          expect(verify.pollUnsafe()).toBeUndefined();

          const read = yield* handlers.read().pipe(Effect.forkScoped);
          yield* Deferred.await(reading);
          yield* Queue.offer(slices, undefined);
          yield* clock.adjust("1 millis");
          expect(boundaries).toBe(2);
          yield* Deferred.succeed(releaseRead, undefined);
          expect(yield* Fiber.join(read)).toBe("record");
          yield* Queue.take(passed);
          expect(boundaries).toBe(3);
          expect(verify.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(verify)).toEqual(["Started", "Result"]);
        }).pipe(
          Effect.provideService(Foreground, foreground),
          Effect.provideService(Clock.Clock, clock),
        );
      }),
    ),
  ));

test.each(["toasts", "measure"] as const)(
  "%s releases its stream lease while its producer continues with the same values and error",
  (name) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const foreground = yield* makeForeground;
          const clock = yield* TestClock.make();
          return yield* Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const slices = yield* Queue.unbounded<void>();
            let boundaries = 0;
            yield* Effect.forever(
              Queue.take(slices).pipe(
                Effect.andThen(foreground.boundary),
                Effect.andThen(Effect.sync(() => boundaries++)),
              ),
            ).pipe(Effect.forkScoped);
            const source = Stream.callback<string, string>((queue) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                expect(servedNow()).toBe(false);
                yield* Queue.offer(queue, "message");
                yield* Queue.fail(queue, "late failure");
              }),
            );
            const handlers = timingFirstValues({ toasts: () => source, measure: () => source });
            const seen: string[] = [];
            const following = yield* handlers[name]().pipe(
              Stream.tap((value) => Effect.sync(() => seen.push(value))),
              Stream.runDrain,
              Effect.result,
              Effect.forkScoped,
            );
            yield* Deferred.await(entered);
            yield* Queue.offer(slices, undefined);
            yield* clock.adjust("1 millis");
            expect(boundaries).toBe(0);
            yield* clock.adjust("250 millis");
            expect(boundaries).toBe(1);
            yield* Queue.offer(slices, undefined);
            yield* clock.adjust("1 millis");
            expect(boundaries).toBe(2);
            expect(following.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(release, undefined);
            expect(yield* Fiber.join(following)).toEqual(Result.fail("late failure"));
            expect(seen).toEqual(["message"]);
          }).pipe(
            Effect.provideService(Foreground, foreground),
            Effect.provideService(Clock.Clock, clock),
          );
        }),
      ),
    ),
);

test.each(["read", "verify"] as const)(
  "%s keeps priority and does not wait on its own boundary when restoring the host context",
  (name) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const foreground = yield* makeForeground;
          const clock = yield* TestClock.make();
          return yield* Effect.gen(function* () {
            const hosted = yield* Effect.context<never>();
            const answer = Effect.gen(function* () {
              const prioritized = servedNow();
              yield* (yield* Foreground).boundary;
              return prioritized;
            }).pipe(Effect.provideContext(hosted));
            const handlers = timingFirstValues({
              read: () => answer,
              verify: () => Stream.fromEffect(answer),
            });
            const answering =
              name === "read"
                ? handlers.read()
                : handlers.verify().pipe(
                    Stream.runFold(
                      () => false,
                      (_, value) => value,
                    ),
                  );
            const reading = yield* answering.pipe(Effect.forkScoped);
            yield* clock.adjust("1 millis");
            expect(reading.pollUnsafe()).toBeDefined();
            expect(yield* Fiber.join(reading)).toBe(true);
          }).pipe(
            Effect.provideService(Foreground, foreground),
            Effect.provideService(Clock.Clock, clock),
          );
        }),
      ),
    ),
);
