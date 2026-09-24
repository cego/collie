// A workflow held to Collie's own evidence: it asks what it may have run before it does
// anything, and says what that was.

import { Host, Run, defineWorkflow, requireApproved } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "proved",
  title: "A workflow that needs a command approved to prove it",
  description: "Parks until something is approved, then names what was.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const place = yield* (yield* Host).place((yield* Run).id);
      const approved = yield* requireApproved(place.options.outcome ?? "");
      return approved.map((spec) => spec.name).join(",");
    }),
});
