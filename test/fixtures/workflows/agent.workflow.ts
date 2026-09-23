// A workflow that has a coding agent do the work and is handed back a value of its own
// type. What the agent is, how its Output is collected and what one unusable file buys are
// the SDK's; what is here is the contract the result has to meet, and the decision not to
// do the work at all.

import { agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import notes from "./notes.md" with { type: "text" };

export const id = "agent";
export const title = "A workflow that has an agent do the work";
export const description = "Reviews what it is pointed at and is handed a verdict it can read.";

export const input = {
  target: Schema.String,
  cwd: Schema.String,
  skip: Schema.Boolean,
};

export const metadata = { hints: { target: "diff-target" } };

/** What the agent is held to. The descriptions are the judgment being asked for. */
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "clean only when there is nothing left for the implementer",
  }),
  note: Schema.String.annotate({ description: "one sentence a human reads" }),
});

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      // Checked before anything expensive: skipped work opens no tab and fabricates
      // no Output, and it says why it was skipped.
      if (payload.input.skip) return "skipped: nothing points at any work";
      const verdict = yield* agentWork({
        runId: payload.runId,
        operation: "review",
        role: "reviewer",
        workflow: id,
        cwd: payload.input.cwd,
        instructions: notes,
        inputs: { target: payload.input.target },
        output: Verdict,
      });
      return `${verdict.verdict}: ${verdict.note}`;
    }),
  );
  return { workflow, layer, decisions: {} };
};
