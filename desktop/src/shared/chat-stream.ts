import { Effect, Stream } from "effect";

export const replyEvents = <A, E>(stream: Stream.Stream<A, E>, signal?: AbortSignal) =>
  Stream.toAsyncIterable(
    signal === undefined
      ? stream
      : Stream.suspend(() =>
          signal.aborted
            ? Stream.empty
            : stream.pipe(
                Stream.interruptWhen(
                  Effect.callback<void>((resume) => {
                    const aborted = () => resume(Effect.void);
                    if (signal.aborted) aborted();
                    else signal.addEventListener("abort", aborted, { once: true });
                    return Effect.sync(() => signal.removeEventListener("abort", aborted));
                  }),
                ),
              ),
        ),
  );
