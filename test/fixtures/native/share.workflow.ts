// One repository's share of a plan, as a workflow of its own. It is started by its public
// id like anything else and knows nothing about having been fanned out to.

import { NativeHost, defineWorkflow } from "collie/native";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export const id = "share";
export const title = "Build one repository's tickets";
export const description = "Takes the plan and the tickets settled for this repository.";

export const input = {
  plan: Schema.String,
  /** What this repository's share of the plan is. Settled by the parent, decided here. */
  tickets: Schema.NonEmptyArray(Schema.String),
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const built = payload.input.tickets.join(",");
      return yield* Activity.make({
        name: "build",
        success: Schema.String,
        execute: host.record(payload.runId, `built ${built}`).pipe(Effect.as(built)),
      });
    }),
  );
  return { workflow, layer, decisions: {} };
};
