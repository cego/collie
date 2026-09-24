// Every metadata conflict at once, so the refusal names each rather than the first.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "Conflicted",
  title: "A module that contradicts itself",
  description: "Two work sources, a reserved input, and both kinds of outcome.",
  input: Schema.Struct({ here: Schema.String, there: Schema.String, branch: Schema.String }),
  output: Schema.String,
  hints: { here: "work-source", there: "work-source" },
  // A module is JavaScript by the time it is loaded, so this one says an outcome that
  // does not exist as well as saying two at once.
  outcome: { fixed: "vibes" as never, selectable: ["docs"] },
  actions: [
    {
      id: "Not An Id",
      title: "",
      workflow: "echo",
      arguments: {},
      eligible: () => true,
    },
  ],
  run: () => Effect.succeed("never"),
});
