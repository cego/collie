// What a hand-over starts: one input its offers bind, two only its own orchestration
// sets, and one a human may choose.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "ship-target",
  title: "Ship one merge request",
  description: "Answers with what it was started with.",
  input: Schema.Struct({
    mr: Schema.String,
    ship: Schema.optionalKey(Schema.Literals(["release", "merge"])),
    merge_only: Schema.optionalKey(Schema.Boolean),
    together: Schema.optionalKey(Schema.Array(Schema.String)),
    notify: Schema.optionalKey(Schema.Boolean).annotate({ description: "Tell the channel" }),
  }),
  hints: { mr: "goal", merge_only: "internal", together: "internal" },
  output: Schema.String,
  run: ({ input }) => Effect.succeed(JSON.stringify(input)),
});
