import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { makeForeground, servedNow } from "../src/foreground";
import { shell } from "../src/mr";

test("waiting for a command releases its request's hold and restores it without changing the answer", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const foreground = yield* makeForeground;
        const clock = yield* TestClock.make();
        yield* Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const exited = yield* Deferred.make<void>();
          const resumed = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const cleaning = yield* Deferred.make<void>();
          const allowClose = yield* Deferred.make<void>();
          const closed = yield* Deferred.make<void>();
          const spawner = ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(allowClose)),
                  Effect.andThen(Deferred.succeed(closed, undefined)),
                ),
              );
              return ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                stdout: Stream.make(new TextEncoder().encode("answer\n")),
                stderr: Stream.make(new TextEncoder().encode("warning\n")),
                all: Stream.empty,
                exitCode: Effect.gen(function* () {
                  expect(servedNow()).toBe(true);
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(exited);
                  return ChildProcessSpawner.ExitCode(3);
                }),
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                stdin: Sink.drain,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.never,
              });
            }),
          );
          const answer = yield* foreground
            .serve(
              Effect.gen(function* () {
                const result = yield* shell("command", [], "/");
                expect(servedNow()).toBe(true);
                yield* Deferred.succeed(resumed, undefined);
                yield* Deferred.await(finish);
                return result;
              }),
            )
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.forkScoped,
            );
          yield* Deferred.await(entered);
          const background = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(background.pollUnsafe()).toBeDefined();
          yield* Deferred.succeed(exited, undefined);
          yield* Deferred.await(cleaning);
          const cleanup = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(cleanup.pollUnsafe()).toBeDefined();
          yield* Deferred.succeed(allowClose, undefined);
          yield* Deferred.await(resumed);
          yield* Deferred.await(closed);
          const held = yield* foreground.boundary.pipe(Effect.forkScoped);
          yield* clock.adjust("1 millis");
          expect(held.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(finish, undefined);
          expect(yield* Fiber.join(answer)).toEqual({
            code: 3,
            stdout: "answer\n",
            stderr: "warning\n",
          });
          yield* Fiber.join(held);
        }).pipe(Effect.provideService(Clock.Clock, clock));
      }),
    ),
  ));
