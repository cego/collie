import { Host, ParkCause, Run, agentWork, ask, defineWorkflow } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";

export default defineWorkflow({
  id: "rechecks",
  title: "Wait for an external fact",
  description: "A recheck clears only the park; the workflow reads its fact again.",
  input: Schema.Struct({
    cause: ParkCause,
    file: Schema.String,
    mr: Schema.optional(Schema.String),
  }),
  output: Schema.String,
  hints: { file: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const fs = yield* FileSystem.FileSystem;
      if (input.mr !== undefined && input.mr !== "") {
        yield* host.mergeRequest(id, input.mr);
        const { cwd } = yield* host.place(id);
        const [spec] = yield* host.approved(id);
        if (spec !== undefined) {
          const job = yield* host.ciJob({ runId: id, cwd, name: spec.name, wait: false });
          if ("proved" in job) return "CI gate passed";
        }
      }
      const next = yield* fs.readFileString(input.file).pipe(Effect.orElseSucceed(() => "waiting"));
      yield* host.record(id, `gate read ${next}`);
      if (next === "ready") return "recovered";
      if (next === "decision")
        yield* agentWork({
          operation: "worker",
          role: "implementer",
          instructions: "Read the work.",
          input: {},
          output: Schema.Struct({ verdict: Schema.String }),
        });
      yield* host.parked(id, "external fact is absent", input.cause);
      if (next === "decision")
        return yield* ask({ name: "go", prompt: "Proceed?", options: ["yes", "no"] });
      return yield* Workflow.suspend(yield* WorkflowInstance);
    }),
});
