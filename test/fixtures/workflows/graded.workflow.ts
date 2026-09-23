// The child: a workflow of its own that consumes the shared contract its project selected.
// Nothing here knows it is a child — it is started by id, like anything else.

import { Host, defineWorkflow } from "collie";
import { Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import { reviewLayer, reviewed } from "./capability.ts";
import { HOUSE } from "./house.ts";

export const id = "graded";
export const title = "Grade one note";
export const description = "Reviews a note with whichever house this project provides.";

export const input = {
  note: Schema.String,
  /** Narrower than the parent's own field, which is what makes the child the authority. */
  grade: Schema.Literals(["pass", "fail"]),
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow
    .toLayer(
      Effect.fnUntraced(function* (payload) {
        const host = yield* Host;
        return yield* Activity.make({
          name: "grade",
          success: Schema.String,
          execute: reviewed(payload.input.note).pipe(
            Effect.map((verdict) => `${verdict}/${payload.input.grade}`),
            Effect.tap((graded) => host.record(payload.runId, `graded ${graded}`)),
          ),
        });
      }),
    )
    .pipe(Layer.provide(reviewLayer(HOUSE)));
  return { workflow, layer, decisions: {} };
};
