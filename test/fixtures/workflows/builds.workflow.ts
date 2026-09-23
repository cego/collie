// A workflow that changes the repository, so it declares a checkout of its own. It never
// makes one: the host cut it before this Run existed, and `place` is where it is.

import { Host, agentWork, defineWorkflow, type WorkflowMetadata } from "collie";
import { Effect, Schema } from "effect";

export const id = "builds";
export const title = "Build the work on a branch of its own";
export const description = "One agent, in the checkout the host gave this Run.";

export const input = {
  work: Schema.String,
};

export const metadata: WorkflowMetadata = {
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
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const place = yield* (yield* Host).place(payload.runId);
      yield* agentWork({
        runId: payload.runId,
        operation: "build",
        role: "implementer",
        workflow: id,
        cwd: place.cwd,
        instructions: "Build {{inputs.work}}.",
        inputs: { work: payload.input.work },
        output: Schema.Struct({ verdict: Schema.String }),
      });
      return place.cwd;
    }),
  );

  return { workflow, layer, decisions: {} };
};
