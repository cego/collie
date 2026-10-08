// A subscription that outlives its failures: it says what went wrong and when it tries
// again, backs off while it keeps failing, starts afresh after a value, and wakes early
// when asked. It ends only when the view lets go.
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
  const after = (failures: number): Stream.Stream<Retried<A>, never, R> =>
    Stream.suspend(() => {
      let reached = false;
      return source.pipe(
        Stream.map((value): Retried<A> => ({ _tag: "Value", value })),
        Stream.tap(() => Effect.sync(() => void (reached = true))),
        Stream.catchCause((cause) => {
          const failed = reached ? 0 : failures;
          const wait = Effect.raceFirst(Effect.sleep(backoff(failed)), waited);
          // A renewed connection is no trouble: taken again at once, and quietly after that.
          if (Cause.hasInterruptsOnly(cause))
            return failed === 0
              ? after(1)
              : Stream.fromEffectDrain(wait).pipe(Stream.concat(after(failed + 1)));
          return Stream.unwrap(
            Effect.map(Clock.currentTimeMillis, (now) => {
              const retried: Retried<A> = {
                _tag: "Retrying",
                said: saidOf(cause),
                attempt: failed + 1,
                at: now + backoff(failed),
              };
              return Stream.make(retried).pipe(
                Stream.concat(Stream.fromEffectDrain(wait)),
                Stream.concat(after(failed + 1)),
              );
            }),
          );
        }),
      );
    });
  return after(0);
};

/** What a page holds: its last value, kept through trouble, and the trouble while there is one. */
export interface Held<A> {
  readonly value: Option.Option<A>;
  readonly trouble: Trouble | null;
}

export const heldOf = <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
): Stream.Stream<Held<A>, never, R> =>
  retrying(source, waited).pipe(
    Stream.scan(
      (): Held<A> => ({ value: Option.none<A>(), trouble: null }),
      (held, item): Held<A> =>
        item._tag === "Value"
          ? { value: Option.some(item.value), trouble: null }
          : { value: held.value, trouble: { said: item.said, attempt: item.attempt, at: item.at } },
    ),
  );
