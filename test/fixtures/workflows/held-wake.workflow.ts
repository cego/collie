// A Run that waits for a decision, and parks when it is stopped. Entered while its gate
// file exists, it records `held` and stays there until the file is gone, so the host's
// stop or resume that woke it is still waiting on it.

import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";

export default defineWorkflow({
  id: "held-wake",
  title: "Wait, held at the door",
  description: "Waits to be answered, held on entry while its gate is shut.",
  input: Schema.Struct({ gate: Schema.String }),
  hints: { gate: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const fs = yield* FileSystem.FileSystem;
      const shut = fs.exists(input.gate).pipe(Effect.orElseSucceed(() => false));
      if (yield* shut) {
        yield* host.record(runId, "held");
        yield* shut.pipe(
          Effect.repeat({
            while: (still) => still,
            schedule: Schedule.spaced("50 millis"),
          }),
        );
      }
      return yield* Activity.make({
        name: "wait",
        success: Schema.String,
        execute: Effect.gen(function* () {
          const wait = yield* WorkflowEngine.WorkflowInstance;
          yield* host.record(runId, "wait");
          if (yield* host.stopRequested(runId)) {
            yield* host.record(runId, "stopped");
            return yield* Workflow.suspend(wait);
          }
          return yield* ask({ name: "decision", prompt: "Go on?" });
        }),
      });
    }),
});
