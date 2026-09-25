import { BunServices } from "@effect/platform-bun";
import { Config, Effect, ManagedRuntime } from "effect";

const runtime = ManagedRuntime.make(BunServices.layer);

export function runEffect<A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> {
  return runtime.runPromise(effect);
}

/**
 * The process a host a test starts may live no longer than, as the test preload set it:
 * handed to every program a test runs with an environment of its own.
 */
export const watchedBy = Config.String("COLLIE_HOST_WATCH_PID").pipe(Config.withDefault(""));
