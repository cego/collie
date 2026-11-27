import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "given",
  title: "Take the findings it was given and answer with them",
  description: "Answers with the ids it was given as `selected`.",
  input: Schema.Struct({ selected: Schema.Array(Schema.String) }),
  hints: { selected: "goal" },
  output: Schema.String,
  run: ({ input }) => Effect.succeed(input.selected.join(",")),
});
