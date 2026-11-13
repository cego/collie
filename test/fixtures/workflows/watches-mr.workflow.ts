import { defineWorkflow, watch } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "watches-mr",
  title: "Wait on a merge request",
  description: "Waits, with no agent, until its merge request changes in a way that matters.",
  input: Schema.Struct({ target: Schema.String, head: Schema.String, cwd: Schema.String }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input }) =>
    watch({
      name: "round-1",
      target: input.target,
      cwd: input.cwd,
      cursor: { head: input.head, seen: [], pipeline: "passed" },
    }).pipe(Effect.map((woke) => JSON.stringify(woke))),
});
