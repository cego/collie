// A parent whose child finishes at once, then held behind its gate file the way
// `held-wake` is, so it is still pending when the host that ran its child is replaced.

import { Host, Run, child, defineWorkflow } from "collie";
import { Effect, FileSystem, Schedule, Schema } from "effect";

export default defineWorkflow({
  id: "outlived",
  title: "Grade a note, then wait at the gate",
  description: "Has a child grade a note, then waits until its gate file is gone.",
  input: Schema.Struct({ note: Schema.String, gate: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const graded = yield* child({
        invocation: "grade",
        workflow: "late",
        input: { note: input.note },
      });
      const fs = yield* FileSystem.FileSystem;
      const shut = fs.exists(input.gate).pipe(Effect.orElseSucceed(() => false));
      if (yield* shut) {
        yield* host.record(runId, "held");
        yield* shut.pipe(
          Effect.repeat({ while: (still) => still, schedule: Schedule.spaced("50 millis") }),
        );
      }
      return `outlived ${graded}`;
    }),
});
