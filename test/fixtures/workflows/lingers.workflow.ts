// A Run that waits on a question and offers a follow-up however it ends, so one can be
// asked for while it is still going.

import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "lingers",
  title: "Wait to be told",
  description: "Asks one question, and offers to carry on whenever it is asked.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  followUps: [
    {
      id: "carry-on",
      title: "Carry on",
      workflow: "self",
      when: "always",
      inputs: { note: "started-with" },
    },
  ],
  run: () => ask({ name: "go", prompt: "Go on?" }).pipe(Effect.map(String)),
});
