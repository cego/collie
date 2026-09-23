// A workflow held to Collie's own evidence: it asks what it may have run before it does
// anything, and says what that was.

import { Host, defineWorkflow, requireApproved } from "collie";
import { Effect, Schema } from "effect";

export const id = "proved";
export const title = "A workflow that needs a command approved to prove it";
export const description = "Parks until something is approved, then names what was.";

export const input = { note: Schema.String };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* Host;
      const place = yield* host.place(payload.runId);
      const approved = yield* requireApproved(payload.runId, place.options.outcome ?? "");
      return approved.map((spec) => spec.name).join(",");
    }),
  );
  return { workflow, layer, decisions: {} };
};
