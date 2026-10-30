// A Run that records its merge request and waits on its review, which only a Hold or Stop
// ends where the forge cannot be read.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "awaits-review",
  title: "Wait on a review",
  description: "Records its merge request, then waits on its review.",
  input: Schema.Struct({ mr: Schema.String, cwd: Schema.String }),
  output: Schema.String,
  hints: { mr: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      yield* host.mergeRequest(runId, input.mr);
      const standing = yield* host.awaitReview({ runId, cwd: input.cwd, proved: "", seen: [] });
      if (standing._tag === "Held") return yield* Workflow.suspend(yield* WorkflowInstance);
      return standing._tag;
    }),
});
