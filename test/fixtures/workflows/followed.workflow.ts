// A Run that finishes and offers to carry on in a human's own words.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "followed",
  title: "Finish, and offer a follow-up",
  description: "Returns its text and offers to run again on what is still left.",
  input: Schema.Struct({ text: Schema.String }),
  hints: { text: "work-source" },
  output: Schema.String,
  followUps: [{ id: "again", title: "Carry on", workflow: "self", when: "succeeded" }],
  run: ({ input }) => Effect.succeed(input.text),
});
