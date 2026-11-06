// A large Run: as many declared Steps as it is told, one after another.

import { defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const STEPS = Array.from({ length: 240 }, (_, at) =>
  step({ id: `s${at + 1}`, title: `Step ${at + 1}`, kind: "check" }),
);

export default defineWorkflow({
  id: "many-steps",
  title: "Take many Steps",
  description: "Takes as many Steps as it is told.",
  input: Schema.Struct({ steps: Schema.String }),
  hints: { steps: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const one of STEPS.slice(0, Number(input.steps))) yield* one(Effect.void);
      return `took ${input.steps} Steps`;
    }),
});
