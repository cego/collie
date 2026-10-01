// A planner saved under an id of its own, for what a start from the Home offers when no one
// checkout fits: it is found by taking a goal and fixing its outcome as a plan.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "plans-it",
  title: "Plan it",
  description: "Stands in for the shipped plan.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  outcome: { fixed: "plan" },
  run: ({ input }) => Effect.succeed(input.goal),
});
