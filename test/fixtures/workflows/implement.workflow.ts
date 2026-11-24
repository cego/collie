import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "implement",
  title: "Build what was chosen",
  description: "Succeeds at once, recording the findings it was given.",
  input: Schema.Struct({
    plan: Schema.String,
    findings: Schema.optionalKey(Schema.Array(Schema.String)),
    goal: Schema.optionalKey(Schema.String),
  }),
  hints: { plan: "work-source" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const place = yield* (yield* Host).place(run.id);
      return place.dir;
    }),
});
