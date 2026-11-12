import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "offer-ask",
  actions: [
    {
      id: "ask",
      title: "Ask",
      workflow: "ships",
      arguments: { mr: Schema.String },
      eligible: () => true,
    },
  ],
  run: () => Effect.void,
});
