// A healer under an id that says nothing of healing: the host finds it by its declaration.

import { agentWork, defineWorkflow } from "collie";
import { Schema } from "effect";

const Mended = Schema.Struct({
  diagnosis: Schema.String,
  actions: Schema.Array(Schema.String),
  result: Schema.Literals(["resumed", "escalate"]),
  needs_person: Schema.optionalKey(Schema.String),
  finding: Schema.Struct({
    collie_defect: Schema.Boolean,
    key: Schema.String,
    root_cause: Schema.String,
    fix: Schema.String,
    regression: Schema.String,
  }),
});

export default defineWorkflow({
  id: "mender",
  title: "Mends a parked Run",
  description: "One agent gets the parked Run moving and says what it found.",
  input: Schema.Struct({ run: Schema.String, park: Schema.String }),
  output: Mended,
  hints: { run: "goal" },
  heals: true,
  run: ({ input }) =>
    agentWork({
      operation: "mend",
      role: "healer",
      instructions: "Get the parked Run moving.",
      input: { run: input.run, park: input.park },
      output: Mended,
    }),
});
