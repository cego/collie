import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "records-mr",
  title: "Record the merge request it was given as the one it opened",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).mergeRequest((yield* Run).id, input.mr);
      return input.mr;
    }),
});
