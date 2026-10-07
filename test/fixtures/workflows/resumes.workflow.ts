// A parent that admits its children, parks on a question, and only then waits on them,
// so a test can leave the children as a previous release recorded them in between.

import { Children, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "resumes",
  title: "Admit children, ask, then wait on them",
  description: "Starts one paced child per note and collects them after an answer.",
  input: Schema.Struct({
    /** A comma-separated list, one child each. */
    notes: Schema.String,
    /** The notes whose child waits on a question of its own before it finishes. */
    waits: Schema.String,
  }),
  hints: { notes: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const children = yield* Children;
      const waiting = input.waits.split(",");
      const started = yield* Effect.forEach(input.notes.split(","), (note) =>
        children.start({
          invocation: `pace-${note}`,
          workflow: "paced",
          input: { note, wait: waiting.includes(note) ? "yes" : "no" },
        }),
      );
      yield* ask({ name: "go", prompt: "Collect the children?" });
      // Concurrently, as `implement` collects its slices.
      const results = yield* Effect.forEach(started, (one) => children.result(one), {
        concurrency: "unbounded",
      });
      return results.map(String).join("+");
    }),
});
