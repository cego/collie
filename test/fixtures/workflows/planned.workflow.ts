// A workflow that leaves a plan behind, and offers its tickets to the workflow that builds.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "planned",
  title: "Leave a plan",
  description: "Its tickets are for another workflow to build.",
  input: Schema.Struct({ goal: Schema.String }),
  output: Schema.String,
  followUps: [
    {
      id: "build-it",
      title: "Build it",
      workflow: "builds",
      when: "succeeded",
      inputs: { work: "plan-dir" },
    },
  ],
  run: ({ input }) => Effect.succeed(input.goal),
});
