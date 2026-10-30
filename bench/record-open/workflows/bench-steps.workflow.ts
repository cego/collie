// The benchmark's Runs: `steps` declared Steps one after another, then, for a live Run, a
// Step taken again every two seconds for as long as the host runs it.

import { defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const STEPS = Array.from({ length: 240 }, (_, at) =>
  step({ id: `s${at + 1}`, title: `Step ${at + 1}`, kind: "check" }),
);
const write = step({ id: "write", title: "Write", kind: "check" });

export default defineWorkflow({
  id: "bench-steps",
  title: "Take many Steps",
  description: "Takes as many Steps as it is told, and keeps writing when it is live.",
  input: Schema.Struct({ steps: Schema.String, live: Schema.Literals(["yes", "no"]) }),
  hints: { steps: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const one of STEPS.slice(0, Number(input.steps))) yield* one(Effect.void);
      if (input.live === "yes")
        for (let round = 1; ; round++) yield* write(Effect.sleep("2 seconds"), { round });
      return `took ${input.steps} Steps`;
    }),
});
