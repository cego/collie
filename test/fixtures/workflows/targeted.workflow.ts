// A module pointed at a change, so a launch has a diff target to settle.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "targeted",
  title: "A workflow pointed at a change",
  description: "Reports the target it was handed, so a caller can see how it was settled.",
  input: Schema.Struct({ target: Schema.String }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input }) =>
    Activity.make({
      name: "report",
      success: Schema.String,
      execute: Effect.succeed(input.target),
    }),
});
