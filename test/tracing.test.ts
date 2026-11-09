// A traced host exports only spans long enough to say where time went.

import { Effect, Tracer } from "effect";
import { expect, test } from "bun:test";
import { atLeast } from "../src/tracing";

test("a span shorter than the minimum is not exported, and a longer one with its parent is", () => {
  const ended: Array<{ readonly name: string; readonly sampled: boolean }> = [];
  const recording = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        ended.push({ name: span.name, sampled: span.sampled });
      };
      return span;
    },
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.void.pipe(Effect.withSpan("quick"));
      yield* Effect.sleep("30 millis").pipe(Effect.withSpan("slow"));
    }).pipe(Effect.withSpan("parent"), Effect.withTracer(atLeast(recording, 20))),
  ).then(() =>
    expect(ended).toEqual([
      { name: "quick", sampled: false },
      { name: "slow", sampled: true },
      { name: "parent", sampled: true },
    ]),
  );
});
