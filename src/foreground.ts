// Interactive reads come first (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model, D6):
// a background pass that walks many Runs waits at each slice boundary while a record frame,
// an offer or an act is being served.

import { Context, Effect, Latch, Layer } from "effect";

/** The longest a slice boundary holds a pass for interactive work, so a busy door starves nothing. */
const PATIENCE = "250 millis";

export interface ForegroundApi {
  /** `effect`, with every background pass held at its next slice boundary until it ends. */
  readonly serve: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Where a background pass lets the event loop and any interactive work go first. */
  readonly boundary: Effect.Effect<void>;
}

/** Outside a host, nothing is held: a boundary only yields. */
export const Foreground = Context.Reference<ForegroundApi>("collie/Foreground", {
  defaultValue: () => ({ serve: (effect) => effect, boundary: Effect.yieldNow }),
});

/** What interactive work sees of it: what it calls is served too, and holds for nothing. */
const served: ForegroundApi = { serve: (effect) => effect, boundary: Effect.void };

export const makeForeground = Effect.gen(function* () {
  const idle = yield* Latch.make(true);
  let serving = 0;
  return {
    serve: (effect) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => (++serving === 1 ? idle.close : Effect.void)),
        () => Effect.provideService(effect, Foreground, served),
        () => Effect.suspend(() => (--serving === 0 ? idle.open : Effect.void)),
      ),
    boundary: Effect.andThen(
      Effect.yieldNow,
      idle.await.pipe(Effect.timeoutOption(PATIENCE), Effect.asVoid),
    ),
  } satisfies ForegroundApi;
});

/** Every pass in scope holds for the interactive work served in it. */
export const foregroundLayer = Layer.effect(Foreground, makeForeground);
