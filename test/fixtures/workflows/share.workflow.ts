// One repository's share of a plan, as a workflow of its own. It is started by its public
// id like anything else and knows nothing about having been fanned out to.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "share",
  title: "Build one repository's tickets",
  description: "Takes the plan and the tickets settled for this repository.",
  input: Schema.Struct({
    plan: Schema.String,
    /** What this repository's share of the plan is. Settled by the parent, decided here. */
    tickets: Schema.NonEmptyArray(Schema.String),
  }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const built = input.tickets.join(",");
      return yield* Activity.make({
        name: "build",
        success: Schema.String,
        execute: host.record(runId, `built ${built}`).pipe(Effect.as(built)),
      });
    }),
});
