// A child that records each time its body's work runs, optionally after a question of
// its own, so a test can tell one execution of it from two.

import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "paced",
  title: "Record one note",
  description: "Records that it ran, after a question when it is told to wait.",
  input: Schema.Struct({
    note: Schema.String,
    wait: Schema.Literals(["yes", "no"]),
  }),
  hints: { note: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      if (input.wait === "yes") yield* ask({ name: "release", prompt: "Finish this note?" });
      return yield* Activity.make({
        name: "pace",
        success: Schema.String,
        execute: host.record(runId, `ran ${input.note}`).pipe(Effect.as(`paced ${input.note}`)),
      });
    }),
});
