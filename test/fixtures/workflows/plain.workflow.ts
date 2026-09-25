// A second entry, so a host proves one broken or missing module leaves the others usable.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "plain",
  title: "A workflow that just finishes",
  description: "Records one line and completes.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      yield* Activity.make({
        name: "only",
        success: Schema.String,
        execute: host.record((yield* Run).id, "plain").pipe(Effect.as("done")),
      });
      return `plain:${input.note}`;
    }),
});
