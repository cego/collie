// Interactive reads come first (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model, D6):
// a background pass waits at each slice boundary while a front-door answer is being served.

import { Context, Effect, Fiber, Latch, Layer } from "effect";

/** The longest a slice boundary or a stream's first value holds a pass. */
export const PATIENCE = "250 millis";

export interface ForegroundApi {
  /** `effect`, with every background pass held at its next slice boundary until it ends. */
  readonly serve: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Awaits a dependency without holding this request's lease, restoring it only while live. */
  readonly wait: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Where a background pass lets the event loop and any interactive work go first. */
  readonly boundary: Effect.Effect<void>;
}

/** Outside a host, nothing is held: a boundary only yields. */
export const Foreground = Context.Reference<ForegroundApi>("collie/Foreground", {
  defaultValue: () => ({
    serve: (effect) => effect,
    wait: (effect) => effect,
    boundary: Effect.yieldNow,
  }),
});

const active = new WeakSet<ForegroundApi>();
const live = new WeakSet<ForegroundApi>();

// A captured host context must not replace a live lease.
const Serving = Context.Reference<ForegroundApi | null>("collie/ForegroundLease", {
  defaultValue: () => null,
});

/** Whether the running fiber is serving interactive work. */
export const servedNow = () => {
  const foreground = Fiber.getCurrent()?.getRef(Serving);
  return foreground ? active.has(foreground) : false;
};

export const makeForeground = Effect.gen(function* () {
  const idle = yield* Latch.make(true);
  let serving = 0;
  const hold = (lease: ForegroundApi) => {
    if (!live.has(lease) || active.has(lease)) return Effect.void;
    active.add(lease);
    return ++serving === 1 ? idle.close : Effect.void;
  };
  const release = (lease: ForegroundApi) => {
    if (!active.delete(lease)) return Effect.void;
    return --serving === 0 ? idle.open : Effect.void;
  };
  const foreground: ForegroundApi = {
    serve: (effect) =>
      Effect.flatMap(Serving, (lease) =>
        lease !== null && live.has(lease)
          ? effect
          : Effect.acquireUseRelease(
              Effect.suspend(() => {
                let waiting = 0;
                const served: ForegroundApi = {
                  serve: (effect) => (live.has(served) ? effect : foreground.serve(effect)),
                  wait: (effect) =>
                    Effect.acquireUseRelease(
                      Effect.suspend(() => {
                        waiting++;
                        return release(served);
                      }),
                      () => Effect.provideService(effect, Serving, null),
                      () => Effect.suspend(() => (--waiting === 0 ? hold(served) : Effect.void)),
                    ),
                  boundary: Effect.suspend(() =>
                    active.has(served) ? Effect.void : foreground.boundary,
                  ),
                };
                live.add(served);
                return hold(served).pipe(Effect.as(served));
              }),
              (served) =>
                effect.pipe(
                  Effect.provideService(Foreground, served),
                  Effect.provideService(Serving, served),
                ),
              (served) =>
                Effect.suspend(() => {
                  live.delete(served);
                  return release(served);
                }),
            ),
      ),
    wait: (effect) =>
      Effect.flatMap(Serving, (lease) =>
        lease !== null && live.has(lease) ? lease.wait(effect) : effect,
      ),
    boundary: Effect.suspend(() =>
      servedNow()
        ? Effect.void
        : Effect.andThen(
            Effect.yieldNow,
            idle.await.pipe(Effect.timeoutOption(PATIENCE), Effect.asVoid),
          ),
    ),
  };
  return foreground;
});

/** Every pass in scope holds for the interactive work served in it. */
export const foregroundLayer = Layer.effect(Foreground, makeForeground);
