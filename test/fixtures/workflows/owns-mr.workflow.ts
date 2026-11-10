// A Run that owns the merge request it was given and offers an action taking an integer.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "owns-mr",
  title: "Own the merge request it was given",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  actions: [
    {
      id: "echo-louder",
      title: "Echo it louder",
      workflow: "echo",
      arguments: { text: Schema.String, times: Schema.Int },
      eligible: (facts) => facts.succeeded,
    },
  ],
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).mergeRequest((yield* Run).id, input.mr);
      return input.mr;
    }),
});
