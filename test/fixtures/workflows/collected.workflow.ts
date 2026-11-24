import { agentWork, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const Built = Schema.Struct({ verdict: Schema.String });

export default defineWorkflow({
  id: "collected",
  title: "Build, and say what was collected",
  description: "One agent's Output, and a question naming it.",
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const built = yield* agentWork({
        operation: "build",
        role: "implementer",
        instructions: "Build it.",
        output: Built,
      });
      yield* ask({ name: "collected", prompt: `collected ${built.verdict}` });
      return built.verdict;
    }),
});
