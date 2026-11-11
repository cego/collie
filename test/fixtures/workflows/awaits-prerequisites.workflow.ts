import { Host, PrerequisiteStandingSchema, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "awaits-prerequisites",
  title: "Wait on a ticket's Prerequisites",
  description: "Waits until the Changes a ticket needs merged have landed.",
  input: Schema.Struct({ ticket: Schema.String, cwd: Schema.String }),
  output: Schema.String,
  hints: { ticket: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const standing = yield* Activity.make({
        name: "await-prerequisites",
        success: PrerequisiteStandingSchema,
        execute: host.awaitPrerequisites({ runId, cwd: input.cwd, ticket: input.ticket }),
      });
      if (standing._tag === "Held") return yield* Workflow.suspend(yield* WorkflowInstance);
      return standing._tag;
    }),
});
