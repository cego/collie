import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "branches",
  input: Schema.Struct({ size: Schema.Literals(["small", "big"]) }),
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
