import { WorkflowError, defineWorkflow, type WorkflowMetadata } from "collie";
import { Effect, Schema } from "effect";

export const id = "retains";
export const title = "Fail partway through shared work";
export const description = "Fails where its note says, and offers what a retained claim needs.";

export const input = { note: Schema.String };

export const metadata: WorkflowMetadata = {
  followUps: [
    {
      id: "recover",
      title: "Recover the retained claim",
      workflow: "self",
      when: "failed",
      inputs: { note: "started-with" },
      eligible: (facts) => facts.claim !== null,
    },
  ],
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      return yield* Effect.fail(new WorkflowError({ reason: `merge: ${payload.input.note}` }));
    }),
  );
  return { workflow, layer, decisions: {} };
};
