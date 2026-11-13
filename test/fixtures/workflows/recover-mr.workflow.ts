import { Host, Run, agentWork, defineWorkflow, step } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

const mr = step({ id: "mr", title: "Merge request", kind: "agent", produces: "merge-request" });

export default defineWorkflow({
  id: "recover-mr",
  input: Schema.Struct({ file: Schema.String }),
  hints: { file: "goal" },
  output: Schema.String,
  path: [mr],
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const opened = yield* mr(
        agentWork({
          operation: "mr",
          role: "implementer",
          instructions: "Push and open the merge request.",
          input: {},
          output: Schema.Struct({ url: Schema.String }),
          pushes: true,
        }),
      );
      yield* host.mergeRequest(id, opened.url);
      if (
        (yield* (yield* FileSystem.FileSystem)
          .readFileString(input.file)
          .pipe(Effect.orElseSucceed(() => "waiting"))) === "ready"
      )
        return opened.url;
      yield* host.parked(id, "checkout must be clean", "checkout-dirty-collie");
      return yield* Workflow.suspend(yield* WorkflowInstance);
    }),
});
