import { Effect, Stream, type Duration } from "effect";

/** Watch events are hints; polling closes the subscribe-after-read race. */
export function waitForTerminal<E, R>(
  watch: Stream.Stream<unknown, E, R>,
  isTerminal: () => boolean,
  pollEvery: Duration.Input = "100 millis",
) {
  return Stream.merge(watch, Stream.tick(pollEvery)).pipe(
    Stream.runForEachWhile(() => Effect.sync(() => !isTerminal())),
  );
}
