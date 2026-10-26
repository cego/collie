import { WorkflowError, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "failing-agent",
  title: "An investigation that fails",
  description: "Wait for an agent's report, then fail with its reason.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    agentWork({
      operation: "build",
      role: "investigator",
      instructions: "{{goal}}",
      input,
      output: Schema.Struct({ verdict: Schema.String }),
    }).pipe(
      Effect.andThen(Effect.fail(new WorkflowError({ reason: "Cannot reproduce this goal" }))),
    ),
});
