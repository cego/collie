// A module whose Layer never supplies the service its workflow asks for. Merging is not
// providing, and the host has to say which file that is rather than fail at run time.

import { defineWorkflow } from "collie";
import { Context, Effect, Layer, Schema } from "effect";

export const id = "unwired";
export const title = "A workflow whose service is never provided";
export const description = "Its Layer merges the dependency instead of providing it.";

export const input = { text: Schema.String };

interface MissingApi {
  readonly value: string;
}
class Missing extends Context.Service<Missing, MissingApi>()("unwired/Missing") {}

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* () {
      return (yield* Missing).value;
    }),
  );
  // Merged beside the workflow rather than provided to it, which supplies nothing.
  return { workflow, layer: Layer.merge(layer, Layer.empty), decisions: {} };
};
