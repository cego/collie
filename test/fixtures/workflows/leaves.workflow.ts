import { Host, Run, defineWorkflow, leaveFindings } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "leaves",
  title: "Leave two findings and succeed",
  description: "Settles with the two findings a review would leave.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const { dir } = yield* (yield* Host).place(run.id);
      yield* leaveFindings(dir, [
        { severity: "major", title: "The cached build is stale" },
        { severity: "major", title: "The retry drops the body" },
      ]);
      return "left two findings";
    }),
});
