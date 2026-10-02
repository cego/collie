// One agent does the work and the Run succeeds, leaving that agent alive: what a human
// still tells to merge or tag after the steps are done (ADR-0038).

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "told",
  title: "Build it once, and stay steerable",
  description: "One agent, and a follow-up to carry its work on.",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  hints: { work: "goal" },
  followUps: [{ id: "carry-on", title: "Carry it on", workflow: "self", when: "succeeded" }],
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* agentWork({
        operation: "build",
        role: "implementer",
        instructions: "Build {{work}}.",
        input: { work: input.work },
        output: Schema.Struct({ verdict: Schema.String }),
      });
      return "built";
    }),
});
