// How long a stream that stays open took to send its first value, where that was slow.

import { Clock, Effect, Stream } from "effect";

/** How long an RPC may take to answer before the host log says so. */
export const SLOW_RPC_MS = 2_000;

/** `stream`, telling `slow` how long its first value took where that was over `SLOW_RPC_MS`. */
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
