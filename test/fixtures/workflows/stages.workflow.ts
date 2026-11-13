import { WorkflowError, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "stages",
  title: "Stage a merge request",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    ask({ name: "go", prompt: `Stage ${input.mr}?` }).pipe(
      Effect.flatMap((said) =>
        String(said) === "go"
          ? Effect.succeed(`staged ${input.mr}`)
          : Effect.fail(new WorkflowError({ reason: `not staged: ${String(said)}` })),
      ),
    ),
});
