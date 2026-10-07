// A step that will not end when its host is told to stop: it says it has started, then
// holds on uninterruptibly, the way a step stuck on a slow call does under load.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export default defineWorkflow({
  id: "stubborn",
  title: "Hold on",
  description: "Marks that its step started, then never finishes it.",
  input: Schema.Struct({ marker: Schema.String }),
  hints: { marker: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Activity.make({
      name: "hold",
      success: Schema.String,
      execute: Effect.promise(() => Bun.write(input.marker, "started")).pipe(
        Effect.andThen(Effect.sleep("1 hour").pipe(Effect.uninterruptible)),
        Effect.as("done"),
      ),
    }),
});
