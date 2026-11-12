import { WorkflowError, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "ships",
  title: "Ship a merge request",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    ask({ name: "go", prompt: `Ship ${input.mr}?` }).pipe(
      Effect.flatMap((said) =>
        String(said) === "go"
          ? Effect.succeed(`shipped ${input.mr}`)
          : Effect.fail(new WorkflowError({ reason: `not shipped: ${String(said)}` })),
      ),
    ),
});
