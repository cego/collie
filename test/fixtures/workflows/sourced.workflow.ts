// A module whose launch Input is a work source and that cuts no checkout, so a launch
// from a checkout starts it where the human is.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "sourced",
  title: "Build from a work source",
  description: "Reports the work source it was handed.",
  input: Schema.Struct({ plan: Schema.String }),
  hints: { plan: "work-source" },
  output: Schema.String,
  run: ({ input }) => Effect.succeed(input.plan),
});
