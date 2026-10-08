// A subscription that outlives its failures, ending only when the view lets go.
// No Bun-only import: the view bundles this.

import { Cause, Clock, Deferred, Effect, Exit, Option, Stream } from "effect";
import { saidOf } from "./said";

/** How long to wait after `failures` failures in a row: 1 s, doubling, at most a minute. */
export const backoff = (failures: number) => Math.min(1000 * 2 ** failures, 60_000);

/** What went wrong, which try comes next, and when (epoch ms). */
export interface Trouble {
  readonly said: string;
  readonly attempt: number;
  readonly at: number;
}

export type Retried<A> =
  | { readonly _tag: "Value"; readonly value: A }
  | ({ readonly _tag: "Retrying" } & Trouble);

/** Retry now: `wake` ends whichever wait is under way. */
export const retryWake = () => {
  let next = Deferred.makeUnsafe<void>();
  return {
    wake: () => {
      Deferred.doneUnsafe(next, Exit.void);
      next = Deferred.makeUnsafe<void>();
    },
    waited: Effect.suspend(() => Deferred.await(next)),
  };
};

export const retrying = <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
): Stream.Stream<Retried<A>, never, R> => {
  /** `failures` said in a row, and `renewals` taken quietly in a row, since the last value. */
  const after = (failures: number, renewals: number): Stream.Stream<Retried<A>, never, R> =>
    Stream.suspend(() => {
      let reached = false;
      const wait = (failed: number) => Effect.raceFirst(Effect.sleep(backoff(failed)), waited);
      return source.pipe(
        Stream.map((value): Retried<A> => ({ _tag: "Value", value })),
        Stream.tap(() => Effect.sync(() => void (reached = true))),
        // A subscription that ends was cut off, as one interrupted was.
        Stream.concat(Stream.failCause(Cause.interrupt())),
        Stream.catchCause((cause) => {
          const [failed, renewed] = reached ? [0, 0] : [failures, renewals];
          // A renewed connection is no trouble: taken again at once, and quietly after that.
          if (Cause.hasInterruptsOnly(cause))
            return renewed === 0
              ? after(failed, 1)
              : Stream.fromEffectDrain(wait(renewed)).pipe(
                  Stream.concat(after(failed, renewed + 1)),
                );
          return Stream.unwrap(
            Effect.map(Clock.currentTimeMillis, (now) => {
              const retried: Retried<A> = {
                _tag: "Retrying",
                said: saidOf(cause),
                attempt: failed + 1,
                at: now + backoff(failed),
              };
              return Stream.make(retried).pipe(
                Stream.concat(Stream.fromEffectDrain(wait(failed))),
                Stream.concat(after(failed + 1, renewed)),
              );
            }),
          );
        }),
      );
    });
  return after(0, 0);
};

/** What a page holds: its last value, kept through trouble, and the trouble while there is one. */
export interface Held<A> {
  readonly value: Option.Option<A>;
  readonly trouble: Trouble | null;
}

/**
 * A subscription's values folded by `step` across its retries, so what a page holds is never
 * started again from nothing.
 */
export const foldedOf = <A, S, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
  step: (held: Option.Option<S>, value: A) => S,
): Stream.Stream<Held<S>, never, R> =>
  retrying(source, waited).pipe(
    Stream.scan(
      (): Held<S> => ({ value: Option.none(), trouble: null }),
      (held, item): Held<S> =>
        item._tag === "Value"
          ? {
              value: Option.some(step(held.value, item.value)),
              trouble: null,
            }
          : { value: held.value, trouble: { said: item.said, attempt: item.attempt, at: item.at } },
    ),
  );

/** A subscription's latest value, kept through its retries. */
export const heldOf = <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
) => foldedOf(source, waited, (_: Option.Option<A>, value: A) => value);
