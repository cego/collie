import { Host, defineWorkflow, type WorkflowMetadata } from "collie";
import { Effect, Schema } from "effect";

export const id = "roams";
export const title = "Roam a repository's branches";
export const description = "Works in the one checkout the host cut for this repository.";

export const input = {
  work: Schema.String,
};

export const metadata: WorkflowMetadata = {
  checkout: "roaming",
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      return (yield* (yield* Host).place(payload.runId)).cwd;
    }),
  );
  return { workflow, layer, decisions: {} };
};
