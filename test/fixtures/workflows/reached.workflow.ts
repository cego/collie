// A workflow whose launch says how far it goes.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "reached",
  title: "Go as far as asked",
  description: "Ends wherever its launch said it goes.",
  input: Schema.Struct({
    goal: Schema.String,
    // oxlint-disable-next-line unicorn/no-thenable -- the Input is named `then`, as plan's and implement's are
    then: Schema.optionalKey(
      Schema.Union([
        Schema.Literal("").annotate({ title: "Ask at the end" }),
        Schema.Literal("ship").annotate({ title: "Ship it" }),
      ]),
    ),
  }),
  hints: { goal: "goal", then: "reach" },
  output: Schema.String,
  run: ({ input }) => Effect.succeed(input.goal),
});
