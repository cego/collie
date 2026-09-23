// A workflow that leaves a plan behind, and offers its tickets to the workflow that builds.

import { defineWorkflow, type WorkflowMetadata } from "collie";
import { Effect, Schema } from "effect";

export const id = "planned";
export const title = "Leave a plan";
export const description = "Its tickets are for another workflow to build.";

export const input = {
  goal: Schema.String,
};

export const metadata: WorkflowMetadata = {
  followUps: [
    {
      id: "build-it",
      title: "Build it",
      workflow: "builds",
      when: "succeeded",
      inputs: { work: "plan-dir" },
    },
  ],
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      return payload.input.goal;
    }),
  );
  return { workflow, layer, decisions: {} };
};
