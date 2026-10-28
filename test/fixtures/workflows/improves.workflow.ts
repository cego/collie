// Starts `plan` as self-improve starts each Improvement, and returns the child it was given.

import { Children, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "improves",
  title: "Start an Improvement",
  description: "Starts plan with then=implement as its own Task.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "improvement",
        workflow: "plan",
        // oxlint-disable-next-line unicorn/no-thenable -- plan's Input is named `then`
        input: { goal: input.goal, then: "implement" },
        ownTask: true,
      });
      return child.runId;
    }),
});
