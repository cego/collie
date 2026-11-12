// A parent that starts a child of its own workflow, which only waits, and then parks.

import { Children, Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "parks-over-child",
  title: "Parks with a child under it",
  input: Schema.Struct({ role: Schema.Literals(["parent", "kid"]) }),
  hints: { role: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      if (input.role === "parent") {
        const children = yield* Children;
        yield* children.start({ invocation: "kid", workflow: "self", input: { role: "kid" } });
        const { id } = yield* Run;
        yield* (yield* Host).parked(id, "parked over its child");
      }
      return yield* Workflow.suspend(yield* WorkflowInstance);
    }),
});
