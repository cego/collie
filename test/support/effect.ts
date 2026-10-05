import * as BunServices from "@effect/platform-bun/BunServices";
import { Clock, Config, Effect, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";

const runtime = ManagedRuntime.make(BunServices.layer);

export function runEffect<A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> {
  return runtime.runPromise(effect);
}

/**
 * The process a host a test starts may live no longer than, as the test preload set it:
 * handed to every program a test runs with an environment of its own.
 */
export const watchedBy = Config.String("COLLIE_HOST_WATCH_PID").pipe(Config.withDefault(""));

/**
 * Runs `effect` on a test clock that a fiber of its own keeps moving, `tick` of it for
 * each millisecond of real time, from the wall clock's now: a session on it reads what
 * sessions on the real clock wrote, so a lock or a timestamp of theirs is not in its
 * future. Its timers fire in order and many times faster, finalizers' included, and the
 * file and database IO between them still takes the real time it takes.
 */
export const fastForward = <A, E, R>(effect: Effect.Effect<A, E, R>, tick = 25) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    yield* clock.setTime(yield* Clock.currentTimeMillis);
    yield* Effect.forkScoped(
      Effect.forever(clock.adjust(tick).pipe(Effect.andThen(Effect.sleep(1)))),
    );
    return yield* effect.pipe(Effect.provideService(Clock.Clock, clock));
  }).pipe(Effect.scoped);
