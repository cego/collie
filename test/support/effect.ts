import * as BunServices from "@effect/platform-bun/BunServices";
import { Clock, Config, Effect, ManagedRuntime, Scope } from "effect";
import { TestClock } from "effect/testing";
import { GIT_QUIET } from "./git-quiet";

const runtime = ManagedRuntime.make(BunServices.layer);

/** Runs `effect` in a scope of its own, closed when it ends. */
export function runEffect<A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>,
): Promise<A> {
  return runtime.runPromise(Effect.scoped(effect));
}

/**
 * The process a host a test starts may live no longer than, and the marker proving a process
 * is the test's, as the test preload set them: handed to every program a test runs with an
 * environment of its own.
 */
export const suiteEnv = Config.all({
  COLLIE_HOST_WATCH_PID: Config.String("COLLIE_HOST_WATCH_PID").pipe(Config.withDefault("")),
  COLLIE_TEST_ROOT: Config.String("COLLIE_TEST_ROOT").pipe(Config.withDefault("")),
  COLLIE_HOST_STOP_GRACE: Config.String("COLLIE_HOST_STOP_GRACE").pipe(
    Config.withDefault("500 millis"),
  ),
  BUN_INSTALL_CACHE_DIR: Config.String("BUN_INSTALL_CACHE_DIR").pipe(Config.withDefault("")),
  COLLIE_TEST_FAKE_FORGE: Config.String("COLLIE_TEST_FAKE_FORGE").pipe(Config.withDefault("")),
  COLLIE_TEST_STARTS: Config.String("COLLIE_TEST_STARTS").pipe(Config.withDefault("")),
  COLLIE_PROC: Config.String("COLLIE_PROC").pipe(Config.withDefault("")),
  COLLIE_MEMORY_EVERY: Config.String("COLLIE_MEMORY_EVERY").pipe(Config.withDefault("")),
}).pipe(Config.map((env) => ({ ...env, ...GIT_QUIET })));

/**
 * Runs `effect` on a test clock that a fiber advances by `tick` between real one-millisecond
 * sleeps, from the wall clock's now: a session on it reads what
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
