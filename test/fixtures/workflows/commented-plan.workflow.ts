import { agentWork, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "commented-plan",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  hints: { work: "goal" },
  run: () =>
    Effect.gen(function* () {
      yield* agentWork({
        operation: "plan",
        role: "planner",
        instructions: "Write the plan.",
        output: Schema.Struct({ verdict: Schema.String }),
      });
      return yield* ask({
        name: "next-choice",
        prompt: "What next?",
        options: ["Finish planning", "Implement now"],
      });
    }),
});
