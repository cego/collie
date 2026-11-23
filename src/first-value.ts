import { Clock, Effect, Stream } from "effect";

export const SLOW_RPC_MS = 2000;

export const firstValueTimed = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  slow: (ms: number) => Effect.Effect<void>,
) =>
  Stream.unwrap(
    Effect.map(Clock.currentTimeMillis, (started) => {
      let first = true;
      return Stream.tap(stream, () => {
        if (!first) return Effect.void;
        first = false;
        return Effect.flatMap(Clock.currentTimeMillis, (now) =>
          now - started > SLOW_RPC_MS ? slow(now - started) : Effect.void,
        );
      });
    }),
  );
