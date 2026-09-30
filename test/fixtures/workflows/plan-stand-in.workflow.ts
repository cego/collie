// A module saved as `plan`, for what a start from the Home offers when no one checkout fits.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "plan",
  title: "Plan it",
  description: "Stands in for the shipped plan.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: ({ input }) => Effect.succeed(input.goal),
});
