// Two agents with a question between them, and a follow-up: what a Run's attachments
// reach before its first step, with a steer, and in a Run started from it (ADR-0045).

import { agentWork, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const Built = Schema.Struct({ verdict: Schema.String });

export default defineWorkflow({
  id: "attended",
  title: "Build, wait, check",
  description: "One agent, a question, and a second agent.",
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
        output: Built,
      });
      yield* ask({ name: "go", prompt: "Check it?" });
      yield* agentWork({
        operation: "check",
        role: "reviewer",
        instructions: "Check {{work}}.",
        input: { work: input.work },
        output: Built,
      });
      return "checked";
    }),
});
