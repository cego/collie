// A reviewer whose turns end without its Output until someone asks it again.

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const Verdict = Schema.Struct({ verdict: Schema.Literals(["clean", "findings"]) });

export default defineWorkflow({
  id: "silent-review",
  title: "A review whose reviewer forgets its Output",
  description: "One reviewer, whose verdict is the Run's result.",
  input: Schema.Struct({ target: Schema.String }),
  output: Schema.String,
  hints: { target: "goal" },
  run: ({ input }) =>
    agentWork({
      operation: "review",
      role: "reviewer",
      instructions: "Review it.",
      input: { target: input.target },
      output: Verdict,
    }).pipe(Effect.map((verdict) => verdict.verdict)),
});
