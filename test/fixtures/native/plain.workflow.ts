// A second entry, so a host proves one broken or missing module leaves the others usable.

import { NativeHost, defineWorkflow } from "collie/native";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export const id = "plain";
export const title = "A workflow that just finishes";
export const description = "Records one line and completes.";

export const input = { note: Schema.String };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      yield* Activity.make({
        name: "only",
        success: Schema.String,
        execute: host.record(payload.runId, "plain").pipe(Effect.as("done")),
      });
      return `plain:${payload.input.note}`;
    }),
  );
  return { workflow, layer, decisions: {} };
};
