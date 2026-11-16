// A delivery whose Merge is an action that declares arguments for what it binds and for
// what only the started workflow's orchestration sets: neither is a human's to fill.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "merges-by-action",
  title: "Merge by an action",
  description: "Offers Merge as an action on the merge request it was given.",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  outcome: { fixed: "review" },
  actions: [
    {
      id: "merge",
      title: "Merge",
      workflow: "ship-target",
      arguments: {
        ship: Schema.String,
        merge_only: Schema.Boolean,
        notify: Schema.optionalKey(Schema.Boolean),
      },
      eligible: () => true,
      inputs: { mr: "started-with" },
      given: { ship: "merge" },
      ships: "merge",
    },
  ],
  run: ({ input }) => Effect.succeed(`handed ${input.mr}`),
});
