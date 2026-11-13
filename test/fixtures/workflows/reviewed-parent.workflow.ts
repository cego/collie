import { defineWorkflow, WorkflowError } from "collie";
import { Effect, Schema } from "effect";
import { reviewPass, reviewRound, REVIEWER } from "../../../workflows/reviewing.ts";

export default defineWorkflow({
  id: "historical-builder",
  input: Schema.Struct({ plan: Schema.String }),
  output: Schema.String,
  hints: { plan: "work-source" },
  agents: { roles: { reviewer: REVIEWER } },
  path: [reviewRound],
  run: ({ input }) =>
    reviewRound(
      Effect.gen(function* () {
        yield* reviewPass({
          target: "",
          plan: input.plan,
          proves: "",
          previous: "",
          answered: "",
          risks: "",
          at: 1,
          of: 1,
          disputed: [],
        });
        return yield* new WorkflowError({ reason: "historical failure after completed review" });
      }),
    ),
});
