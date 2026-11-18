import { Cause, Clock, Deferred, Effect, Exit, Option, Stream } from "effect";
import { backoff } from "../../../src/peers-model";
import { saidOf } from "./said";

export { backoff };

export interface Trouble {
  readonly said: string;
  readonly attempt: number;
  readonly at: number;
}

export type Retried<A> =
  | { readonly _tag: "Value"; readonly value: A }
  | ({ readonly _tag: "Retrying" } & Trouble);

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

export const retrying: <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
) => Stream.Stream<Retried<A>, never, R> = <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
) => {
  const after: (failures: number, renewals: number) => Stream.Stream<Retried<A>, never, R> = (
    failures,
    renewals,
  ) =>
    Stream.suspend(() => {
      let reached = false;
      const wait = (failed: number) => Effect.raceFirst(Effect.sleep(backoff(failed)), waited);
      return source.pipe(
        Stream.map((value) => {
          const returned: Retried<A> = { _tag: "Value", value };
          return returned;
        }),
        Stream.tap(() => Effect.sync(() => void (reached = true))),
        Stream.concat(Stream.failCause(Cause.interrupt())),
        Stream.catchCause((cause) => {
          const [failed, renewed] = reached ? [0, 0] : [failures, renewals];
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

export interface Held<A> {
  readonly value: Option.Option<A>;
  readonly trouble: Trouble | null;
}

export const foldedOf: <A, S, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
  step: (held: Option.Option<S>, value: A) => S,
) => Stream.Stream<Held<S>, never, R> = <A, S, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
  step: (held: Option.Option<S>, value: A) => S,
) =>
  retrying(source, waited).pipe(
    Stream.scan(
      () => {
        const returned: Held<S> = { value: Option.none(), trouble: null };
        return returned;
      },
      (held, item) => {
        const returned: Held<S> =
          item._tag === "Value"
            ? {
                value: Option.some(step(held.value, item.value)),
                trouble: null,
              }
            : {
                value: held.value,
                trouble: { said: item.said, attempt: item.attempt, at: item.at },
              };
        return returned;
      },
    ),
  );

export const heldOf = <A, E extends Error, R>(
  source: Stream.Stream<A, E, R>,
  waited: Effect.Effect<void>,
) => foldedOf(source, waited, (_: Option.Option<A>, value: A) => value);
