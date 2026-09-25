// A workflow that changes the repository, so it declares a checkout of its own. It never
// makes one: the host cut it before this Run existed, and `place` is where it is.

import { Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "builds",
  title: "Build the work on a branch of its own",
  description: "One agent, in the checkout the host gave this Run.",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  hints: { work: "work-source" },
  checkout: "branch",
  followUps: [
    {
      id: "keep-going",
      title: "Keep going on this",
      workflow: "self",
      when: "succeeded",
      eligible: (facts) => facts.branch !== null,
    },
  ],
  run: ({ input }) =>
    Effect.gen(function* () {
      const place = yield* (yield* Host).place((yield* Run).id);
      yield* agentWork({
        operation: "build",
        role: "implementer",
        instructions: "Build {{work}}.",
        input: { work: input.work },
        output: Schema.Struct({ verdict: Schema.String }),
      });
      return place.cwd;
    }),
});
