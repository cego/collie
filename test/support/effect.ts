import { BunServices } from "@effect/platform-bun";
import { Effect, ManagedRuntime } from "effect";

const runtime = ManagedRuntime.make(BunServices.layer);

export function runEffect<A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>): Promise<A> {
  return runtime.runPromise(effect);
}
