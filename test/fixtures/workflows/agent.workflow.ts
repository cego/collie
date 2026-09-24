// A workflow that has a coding agent do the work and is handed back a value of its own
// type. What the agent is, how its Output is collected and what one unusable file buys are
// the SDK's; what is here is the contract the result has to meet, and the decision not to
// do the work at all.

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import notes from "./notes.md" with { type: "text" };

/** What the agent is held to. The descriptions are the judgment being asked for. */
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "clean only when there is nothing left for the implementer",
  }),
  note: Schema.String.annotate({ description: "one sentence a human reads" }),
});

export default defineWorkflow({
  id: "agent",
  title: "A workflow that has an agent do the work",
  description: "Reviews what it is pointed at and is handed a verdict it can read.",
  input: Schema.Struct({ target: Schema.String, cwd: Schema.String, skip: Schema.Boolean }),
  output: Schema.String,
  hints: { target: "diff-target" },
  run: ({ input }) =>
    Effect.gen(function* () {
      // Checked before anything expensive: skipped work opens no tab and fabricates
      // no Output, and it says why it was skipped.
      if (input.skip) return "skipped: nothing points at any work";
      const verdict = yield* agentWork({
        operation: "review",
        role: "reviewer",
        cwd: input.cwd,
        instructions: notes,
        inputs: { target: input.target },
        output: Verdict,
      });
      return `${verdict.verdict}: ${verdict.note}`;
    }),
});
