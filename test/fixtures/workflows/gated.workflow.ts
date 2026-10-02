// A Run held to a feature's evidence, which parks at its gate until a check is approved.

import { Run, defineWorkflow, requireApproved } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "gated",
  title: "Hold at the evidence gate until something is approved",
  description: "Parks with nothing approved, then names what was.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      yield* Run;
      const approved = yield* requireApproved("feature");
      return approved.map((spec) => spec.name).join(",");
    }),
});
