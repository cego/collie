// One agent given two operations in turn, so the second waits at its boundary for the
// first's turn to end.

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const Built = Schema.Struct({ verdict: Schema.String });

export default defineWorkflow({
  id: "reuses",
  title: "Build, then build on",
  description: "One agent, two operations.",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  hints: { work: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const operation of ["first-step", "second-step"])
        yield* agentWork({
          operation,
          agent: "build",
          role: "implementer",
          instructions: "Build {{work}}.",
          input: { work: input.work },
          output: Built,
        });
      return "built";
    }),
});
