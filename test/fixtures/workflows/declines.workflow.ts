import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

class Declined extends Schema.TaggedError<Declined>()("Declined", { why: Schema.String }) {}

export default defineWorkflow({
  id: "declines",
  error: Declined,
  run: () => Effect.fail(new Declined({ why: "too big to take on" })),
});
