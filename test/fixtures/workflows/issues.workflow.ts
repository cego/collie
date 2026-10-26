import { Effect, FileSystem, Schedule, Schema } from "effect";
import { defineWorkflow, Host, Run, WorkflowError } from "collie";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "issues",
  input: Schema.Struct({ operation: Schema.String, text: Schema.String }),
  hints: { operation: "goal" },
  output: Schema.Unknown,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      // Files once the gate its text names exists.
      if (input.operation === "file-when-open") {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.exists(input.text).pipe(
          Effect.orElseSucceed(() => false),
          Effect.repeat({ until: (open) => open, schedule: Schedule.spaced("50 millis") }),
        );
        return yield* Activity.make({
          name: "file",
          success: Schema.Struct({ number: Schema.Int, url: Schema.String }),
          error: WorkflowError,
          execute: host.fileIssue({ runId: run.id, title: "Problem", body: "Gated" }),
        });
      }
      if (input.operation === "file")
        return yield* Activity.make({
          name: "file",
          success: Schema.Struct({ number: Schema.Int, url: Schema.String }),
          error: WorkflowError,
          execute: host.fileIssue({ runId: run.id, title: "Problem", body: input.text }),
        });
      if (input.operation === "comment") {
        yield* Activity.make({
          name: "comment",
          success: Schema.Void,
          error: WorkflowError,
          execute: host.commentIssue({ runId: run.id, number: 1, body: input.text }),
        });
        return "commented";
      }
      if (input.operation === "report")
        return yield* Activity.make({
          name: "report",
          success: Schema.Unknown,
          error: WorkflowError,
          execute: host.report(input.text),
        });
      return yield* Activity.make({
        name: "list",
        success: Schema.Unknown,
        error: WorkflowError,
        execute: host.issues(run.id),
      });
    }),
});
