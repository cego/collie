import { WorkflowError, agentWork, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const build = step({ id: "build", title: "Build", kind: "agent", role: "implementer" });
const finish = step({ id: "finish", title: "Finish", kind: "check" });

export default defineWorkflow({
  id: "terminal-delivery",
  input: Schema.Struct({ work: Schema.String }),
  hints: { work: "goal" },
  output: Schema.String,
  followUps: [
    { id: "carry-on", title: "Carry on", workflow: "self", when: "succeeded" },
    { id: "recover", title: "Recover", workflow: "self", when: "failed" },
  ],
  run: () =>
    Effect.gen(function* () {
      const output = yield* build(
        agentWork({
          operation: "build",
          role: "implementer",
          instructions: "Build the picker.",
          output: Schema.Struct({ verdict: Schema.String }),
        }),
      );
      return yield* finish(
        output.verdict === "failed"
          ? Effect.fail(new WorkflowError({ reason: "The build needs correction" }))
          : Effect.succeed("built"),
      );
    }),
});
