import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "waits-on-ci",
  title: "A workflow that waits on its check left to CI",
  description: "Records its merge request, then waits on the job that proves its check left to CI.",
  input: Schema.Struct({ mr: Schema.String }),
  output: Schema.String,
  hints: { mr: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const { cwd } = yield* host.place(runId);
      yield* host.mergeRequest(runId, input.mr);
      const read = yield* host.ciJob({ runId, cwd, name: "nuxi", wait: true });
      if (yield* host.stopRequested(runId)) return yield* Workflow.suspend(yield* WorkflowInstance);
      return "proved" in read ? "proved" : read.unproved;
    }),
});
