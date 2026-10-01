import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "branches",
  input: Schema.Struct({
    goal: Schema.optionalKey(Schema.String),
    size: Schema.Literals(["small", "big"]),
  }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    input.size === "small"
      ? Effect.succeed("quick")
      : ask({
          name: "approach",
          prompt: "How should we tackle this?",
          options: ["quick", "review-first"],
        }),
});
