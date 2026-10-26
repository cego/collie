import { agentWork, defineWorkflow, Host, Run, step, stepFailed } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
const second = step({ id: "b", title: "B", kind: "agent" });
export default defineWorkflow({
  id: "step-retry-note",
  title: "Retry with a note",
  description: "A failed Step with its agent still to start.",
  input: Schema.Struct({ gates: Schema.String }),
  hints: { gates: "goal" },
  output: Schema.String,
  path: [second],
  run: ({ input }) =>
    second(
      Effect.gen(function* () {
        if (!(yield* (yield* FileSystem.FileSystem).exists(`${input.gates}/pass`))) {
          yield* stepFailed("Check failed before launch");
          yield* (yield* Host).parked((yield* Run).id, "Check failed before launch");
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }
        return yield* agentWork({
          operation: "b",
          role: "implementer",
          instructions: "Fix it",
          input: {},
          output: Schema.String,
        });
      }),
    ),
});
