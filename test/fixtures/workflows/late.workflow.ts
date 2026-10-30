// A child whose first generation is slow to import, so a starting host registers it after a
// replayed parent has already asked for the child's result.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

if (import.meta.path.includes("/late@1/")) await new Promise((resolve) => setTimeout(resolve, 3_000));

export default defineWorkflow({
  id: "late",
  title: "Grade one note, late",
  description: "Grades a note from a module that takes a moment to import.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      return yield* Activity.make({
        name: "grade",
        success: Schema.String,
        execute: Effect.succeed(`late:${input.note}`).pipe(
          Effect.tap((graded) => host.record(runId, `graded ${graded}`)),
        ),
      });
    }),
});
