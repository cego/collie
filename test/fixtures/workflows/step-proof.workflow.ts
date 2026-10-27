import { agentWork, defineWorkflow, Host, Run, step, stepFailed } from "collie";
import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

const first = step({ id: "first", title: "First", kind: "agent", role: "implementer" });
const second = step({ id: "second", title: "Second", kind: "agent", role: "implementer" });
const agent = (operation: string) =>
  agentWork({
    operation,
    role: "implementer",
    instructions: "Do {{goal}}",
    input: { goal: operation },
    output: Schema.Struct({ verdict: Schema.String }),
  });
export default defineWorkflow({
  id: "step-proof",
  title: "Prove a Step",
  description: "Two agents, with a failure parked in the second Step.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  path: [first, second],
  run: () =>
    Effect.gen(function* () {
      yield* first(agent("first"));
      yield* second(
        Effect.gen(function* () {
          const output = yield* agent("second");
          if (output.verdict !== "failed") return;
          yield* stepFailed("The second check failed");
          yield* (yield* Host).parked((yield* Run).id, "The second check failed");
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }),
      );
      return "done";
    }),
});
