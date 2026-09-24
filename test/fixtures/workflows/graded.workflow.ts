// The child: a workflow of its own that consumes the shared contract its project selected.
// Nothing here knows it is a child — it is started by id, like anything else.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import { reviewLayer, reviewed } from "./capability.ts";
import { HOUSE } from "./house.ts";

export default defineWorkflow({
  id: "graded",
  title: "Grade one note",
  description: "Reviews a note with whichever house this project provides.",
  input: Schema.Struct({
    note: Schema.String,
    /** Narrower than the parent's own field, which is what makes the child the authority. */
    grade: Schema.Literals(["pass", "fail"]),
  }),
  output: Schema.String,
  layer: reviewLayer(HOUSE),
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      return yield* Activity.make({
        name: "grade",
        success: Schema.String,
        execute: reviewed(input.note).pipe(
          Effect.map((verdict) => `${verdict}/${input.grade}`),
          Effect.tap((graded) => host.record(runId, `graded ${graded}`)),
        ),
      });
    }),
});
