// A Run about a merge request that waits for a decision, and parks when it is stopped.

import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export default defineWorkflow({
  id: "stops-on-mr",
  title: "Wait on a merge request",
  description: "Waits to be answered about the merge request it was given.",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "diff-target" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const chosen = yield* Activity.make({
        name: "wait",
        success: Schema.String,
        execute: Effect.gen(function* () {
          const wait = yield* WorkflowEngine.WorkflowInstance;
          yield* host.record(runId, "wait");
          if (yield* host.stopRequested(runId)) {
            yield* host.record(runId, "stopped");
            return yield* Workflow.suspend(wait);
          }
          return yield* ask({ name: "decision", prompt: `What of ${input.mr}?` });
        }),
      });
      return chosen;
    }),
});
