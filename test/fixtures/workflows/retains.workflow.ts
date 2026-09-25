import { WorkflowError, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "retains",
  title: "Fail partway through shared work",
  description: "Fails where its note says, and offers what a retained claim needs.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
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
  run: ({ input }) => Effect.fail(new WorkflowError({ reason: `merge: ${input.note}` })),
});
