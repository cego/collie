// Stands in for implement: it works on a branch, in whatever checkout that branch has.

import { Host, Run, WorkflowError, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "placed",
  title: "Work on a branch",
  description: "Answers with where it was placed, or fails when told to.",
  input: Schema.Struct({ work: Schema.String, ending: Schema.Literals(["succeed", "fail"]) }),
  hints: { work: "goal" },
  output: Schema.String,
  checkout: "branch",
  run: ({ input }) =>
    Effect.gen(function* () {
      const cwd = (yield* (yield* Host).place((yield* Run).id)).cwd;
      if (input.ending === "fail") return yield* new WorkflowError({ reason: `failed in ${cwd}` });
      return cwd;
    }),
});
