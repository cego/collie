import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, FileSystem, Result, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Foreground, foregroundFileSystem, makeForeground, servedNow } from "../src/foreground";
import { timingFirstValues } from "../src/host";

test("a fresh-board dependency still clears inherited priority until its wait ends", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const foreground = yield* makeForeground;
        const inspect = yield* Deferred.make<void>();
        yield* foreground.serve(
          Effect.gen(function* () {
            const inherited = yield* Deferred.await(inspect).pipe(
              Effect.map(() => servedNow()),
              Effect.forkChild,
            );
            yield* foreground.wait(
              Deferred.succeed(inspect, undefined).pipe(
                Effect.andThen(Fiber.join(inherited)),
                Effect.tap((priority) => Effect.sync(() => expect(priority).toBe(false))),
              ),
            );
            expect(servedNow()).toBe(true);
          }),
        );
      }),
    ),
  ));

test("physical I/O releases the requesting hold and restores it with priority", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const foreground = yield* makeForeground;
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const io = yield* Deferred.make<string>();
          const resumed = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const fs = foregroundFileSystem(
            FileSystem.makeNoop({
              readFileString: () =>
                Effect.gen(function* () {
                  expect(servedNow()).toBe(true);
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Deferred.await(io);
                }),
            }),
          );
          const answer = yield* foreground
            .serve(
              Effect.gen(function* () {
                const value = yield* fs.readFileString("record");
                expect(servedNow()).toBe(true);
                yield* Deferred.succeed(resumed, undefined);
                yield* Deferred.await(finish);
                return value;
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const background = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(background.pollUnsafe()).toBeDefined();
          yield* Deferred.succeed(io, "fresh record");
          yield* Deferred.await(resumed);
          const held = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(held.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(answer)).toBe("fresh record");
          yield* Fiber.join(held);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  ));

test("overlapping physical reads restore one hold only after both finish, preserving other leases", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const foreground = yield* makeForeground;
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const pending = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          const first = yield* Deferred.make<string>();
          const second = yield* Deferred.make<string>();
          const finish = yield* Deferred.make<void>();
          const otherEntered = yield* Deferred.make<void>();
          const otherFinish = yield* Deferred.make<void>();
          const fs = foregroundFileSystem(
            FileSystem.makeNoop({
              readFileString: (path) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(path === "first" ? pending : entered, undefined);
                  return yield* Deferred.await(path === "first" ? first : second);
                }),
            }),
          );
          const other = yield* foreground
            .serve(
              Deferred.succeed(otherEntered, undefined).pipe(
                Effect.andThen(Deferred.await(otherFinish)),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(otherEntered);
          const answer = yield* foreground
            .serve(
              Effect.gen(function* () {
                const reading = yield* fs.readFileString("first").pipe(Effect.forkChild);
                const alsoReading = yield* fs.readFileString("second").pipe(Effect.forkChild);
                yield* Fiber.join(reading);
                yield* Fiber.join(alsoReading);
                yield* Deferred.await(finish);
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(pending);
          yield* Deferred.await(entered);
          const isolated = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(isolated.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(otherFinish, undefined);
          yield* Fiber.join(other);
          yield* Fiber.join(isolated);
          yield* Deferred.succeed(first, "first value");
          const stillWaiting = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(stillWaiting.pollUnsafe()).toBeDefined();
          yield* Deferred.succeed(second, "second value");
          yield* clock.adjust("1 millis");
          const restored = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(restored.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.join(answer);
          yield* Fiber.join(restored);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  ));

test.each(["value", "error", "cancel"] as const)(
  "a delayed physical read preserves %s after its stream lease expires",
  (outcome) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const foreground = yield* makeForeground;
          const clock = yield* TestClock.make();
          yield* Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const cleaned = yield* Deferred.make<void>();
            const missing = FileSystem.makeNoop({}).readFileString("missing");
            const failure = yield* missing.pipe(
              Effect.map((value) => [value]),
              Effect.result,
            );
            const fs = foregroundFileSystem(
              FileSystem.makeNoop({
                readFileString: () =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(outcome === "error" ? missing : Effect.succeed("fresh")),
                    Effect.ensuring(Deferred.succeed(cleaned, undefined)),
                  ),
              }),
            );
            let priority: boolean | undefined;
            const handlers = timingFirstValues({
              verify: () =>
                Stream.fromEffect(
                  fs.readFileString("record").pipe(
                    Effect.onExit(() =>
                      Effect.sync(() => {
                        priority = servedNow();
                      }),
                    ),
                  ),
                ),
            });
            const answer = yield* handlers
              .verify()
              .pipe(Stream.runCollect, Effect.result, Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* clock.adjust("251 millis");
            expect(answer.pollUnsafe()).toBeUndefined();
            if (outcome === "cancel") yield* Fiber.interrupt(answer);
            else {
              yield* Deferred.succeed(release, undefined);
              expect(yield* Fiber.join(answer)).toEqual(
                outcome === "error" ? failure : Result.succeed(["fresh"]),
              );
            }
            yield* Deferred.await(cleaned);
            expect(priority).toBe(false);
            const background = yield* foreground.boundary.pipe(Effect.forkScoped);
            yield* clock.adjust("1 millis");
            expect(background.pollUnsafe()).toBeDefined();
          }).pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.provideService(Foreground, foreground),
          );
        }),
      ),
    ),
);
