import { ask, defineWorkflow, step } from "collie";
import { Duration, Effect, Schema } from "effect";
import * as DurableClock from "effect/workflow/DurableClock";

const STEPS = Array.from({ length: 6 }, (_, at) =>
  step({ id: `s${at + 1}`, title: `Step ${at + 1}`, kind: "check" }),
);

export default defineWorkflow({
  id: "bench-wait",
  title: "Wait after a few Steps",
  description: "Takes six Steps, then waits on a question or sleeps on the durable clock.",
  input: Schema.Struct({
    on: Schema.Literals(["ask", "sleep"]),
    seconds: Schema.String,
  }),
  hints: { on: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const one of STEPS) yield* one(Effect.void);
      if (input.on === "ask") return yield* ask({ name: "never", prompt: "Nobody answers." });
      yield* DurableClock.sleep({
        name: "nap",
        duration: Duration.seconds(Number(input.seconds)),
        inMemoryThreshold: Duration.zero,
      });
      return "woke";
    }),
});
