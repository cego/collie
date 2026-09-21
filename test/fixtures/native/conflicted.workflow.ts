// Every metadata conflict at once, so the refusal names each rather than the first.

import { defineWorkflow, type WorkflowMetadata } from "collie/native";
import { Effect, Schema } from "effect";

export const id = "Conflicted";
export const title = "A module that contradicts itself";
export const description = "Two work sources, a reserved input, and both kinds of outcome.";

export const input = {
  here: Schema.String,
  there: Schema.String,
  branch: Schema.String,
};

export const metadata: WorkflowMetadata = {
  hints: { here: "work-source", there: "work-source" },
  // A module is JavaScript by the time it is loaded, so this one says an outcome that
  // does not exist as well as saying two at once.
  outcome: { fixed: "vibes" as never, selectable: ["docs"] },
  actions: [
    {
      id: "Not An Id",
      title: "",
      workflow: "echo",
      arguments: {},
      eligible: () => true,
    },
  ],
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  return { workflow, layer: workflow.toLayer(() => Effect.succeed("never")), decisions: {} };
};
