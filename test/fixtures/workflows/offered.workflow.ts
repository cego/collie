// A module that says what a finished Run of it offers to do next.
//
// Both kinds: an action, which decides on the facts and takes arguments of its own, and a
// follow-up, which is offered on how the Run ended. Neither is anything Collie knows
// about this workflow — they are declarations, and the eligibility below is the only
// thing that decides whether an offer is on the table.

import { Host, defineWorkflow, type WorkflowMetadata } from "collie";
import { Effect, Schema } from "effect";

export const id = "offered";
export const title = "Look at something and offer what to do about it";
export const description = "Declares an action and a follow-up over its own facts.";

export const input = { note: Schema.String };

export const metadata: WorkflowMetadata = {
  outcome: { fixed: "review" },
  actions: [
    {
      id: "grade-it",
      title: "Grade what this found",
      workflow: "graded",
      // The child's own schema decides in the end; this is what a front door asks for.
      arguments: { note: Schema.String, grade: Schema.Literals(["pass", "fail"]) },
      eligible: (facts) => facts.succeeded && !facts.disposed,
    },
  ],
  followUps: [{ id: "look-again", title: "Look again", workflow: "offered", when: "succeeded" }],
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* Host;
      yield* host.record(payload.runId, `looked at ${payload.input.note}`);
      return `looked at ${payload.input.note}`;
    }),
  );
  return { workflow, layer, decisions: {} };
};
