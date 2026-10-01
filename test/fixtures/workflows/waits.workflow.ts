// A Run on a branch of its own that waits on a question and offers a follow-up however it
// ends, so one can be asked for while it is stopped and could still be resumed.

import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "waits",
  title: "Wait on a branch",
  description: "Asks one question in a checkout of its own.",
  input: Schema.Struct({ work: Schema.String }),
  hints: { work: "work-source" },
  output: Schema.String,
  checkout: "branch",
  followUps: [{ id: "carry-on", title: "Carry on", workflow: "self", when: "always" }],
  run: () => ask({ name: "go", prompt: "Go on?" }).pipe(Effect.map(String)),
});
