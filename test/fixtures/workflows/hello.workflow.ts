import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "hello",
  title: "Say hello",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const run = yield* Run;
      yield* (yield* Host).record(run.id, `hello ${input.name}`);
      return `hello ${input.name}, from ${run.workflow}`;
    }),
});
