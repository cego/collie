// A healer that parks itself, as a Heal whose own work stalls would.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "parking-healer",
  title: "Parks while it heals",
  description: "Parks as soon as it starts.",
  input: Schema.Struct({ run: Schema.String, park: Schema.String }),
  output: Schema.String,
  hints: { run: "goal" },
  heals: true,
  run: () =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      yield* host.parked(id, "the healer stalled", "unknown");
      return yield* Effect.never;
    }),
});
