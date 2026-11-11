import { Host, Run, defineWorkflow } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "posted-review",
  title: "Post a signed review",
  description: "Exercises a review post across host recovery.",
  input: Schema.Struct({ target: Schema.String, head: Schema.String }),
  hints: { target: "diff-target" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const place = yield* host.place(runId);
      const file = `${place.dir}/review-note.md`;
      yield* (yield* FileSystem.FileSystem).writeFileString(file, "The input needs a guard.");
      const posted = yield* Activity.make({
        name: "post-review",
        success: Schema.Struct({ ok: Schema.Boolean, message: Schema.String }),
        execute: host.post({
          runId,
          target: input.target,
          cwd: place.cwd,
          file,
          head: input.head,
          round: 1,
        }),
      });
      return posted.message;
    }),
});
