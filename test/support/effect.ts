import { platformLayer } from "../../src/platform";
import type { PlatformServices } from "../../src/platform";
import { recordsLayer } from "../../src/records";
import type { Records } from "../../src/records";
import { storeLayer } from "../../src/store";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { Scope } from "effect";
import { Clock, Config, Duration, Effect, Layer, ManagedRuntime } from "effect";
import { ConnectionDeadline } from "../../src/connections";
import { ServerStartDeadline } from "../../src/compactors";
import { TestClock } from "effect/testing";
import { forgetAwaited } from "../../src/output-submit";
import { GIT_QUIET } from "./git-quiet";

const runtime = ManagedRuntime.make(platformLayer);

export const memoryRecords = recordsLayer.pipe(
  Layer.provideMerge(storeLayer()),
  Layer.provide(Layer.orDie(SqliteClient.layer({ filename: ":memory:" }))),
  Layer.provide(Reactivity.layer),
);

export function runEffect<A, E>(
  effect: Effect.Effect<A, E, PlatformServices | Records | Scope.Scope>,
) {
  // WARNING: Two tests in one process reuse a Run's and its agents' names, which only a test ever does.
  return runtime.runPromise(
    Effect.scoped(Effect.andThen(forgetAwaited, Effect.provide(effect, memoryRecords))),
  );
}

export const suiteEnv = Config.all({
  COLLIE_HOST_WATCH_PID: Config.String("COLLIE_HOST_WATCH_PID").pipe(Config.withDefault("")),
  COLLIE_TEST_ROOT: Config.String("COLLIE_TEST_ROOT").pipe(Config.withDefault("")),
  COLLIE_HOST_STOP_GRACE: Config.String("COLLIE_HOST_STOP_GRACE").pipe(
    Config.withDefault("500 millis"),
  ),
  BUN_INSTALL_CACHE_DIR: Config.String("BUN_INSTALL_CACHE_DIR").pipe(Config.withDefault("")),
  COLLIE_TEST_FAKE_FORGE: Config.String("COLLIE_TEST_FAKE_FORGE").pipe(Config.withDefault("")),
  COLLIE_TEST_STARTS: Config.String("COLLIE_TEST_STARTS").pipe(Config.withDefault("")),
  COLLIE_TEST_FILE: Config.String("COLLIE_TEST_FILE").pipe(Config.withDefault("")),
  COLLIE_PROC: Config.String("COLLIE_PROC").pipe(Config.withDefault("")),
  COLLIE_MEMORY_EVERY: Config.String("COLLIE_MEMORY_EVERY").pipe(Config.withDefault("")),
  // WARNING: a host holds no file watch; one that comes back fails the test that started it.
  COLLIE_HOST_REFUSES: Config.succeed("true"),
  // WARNING: never the human's core; a test that wants one starts the rig's and names its socket.
  HC_SOCKET: Config.succeed("/nonexistent/collie-test/hc.sock"),
}).pipe(Config.map((env) => ({ ...env, ...GIT_QUIET })));

// WARNING: File and database IO still take real time under the fast clock, so a Connection read or server start has no deadline.
export const fastForward = <A, E, R>(effect: Effect.Effect<A, E, R>, tick = 25) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    yield* clock.setTime(yield* Clock.currentTimeMillis);
    yield* Effect.forkScoped(
      Effect.forever(clock.adjust(tick).pipe(Effect.andThen(Effect.sleep(1)))),
    );
    return yield* effect.pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provideService(ConnectionDeadline, Duration.infinity),
      Effect.provideService(ServerStartDeadline, Duration.infinity),
    );
  }).pipe(Effect.scoped);
