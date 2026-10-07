// A Run asked one Choice after another, so who answered each can be told apart.

import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "asks",
  title: "Ask six Choices in turn",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: () =>
    Effect.forEach(["q1", "q2", "q3", "q4", "q5", "q6"], (name) =>
      ask({ name, prompt: `Answer ${name}?`, options: ["yes", "no"] }),
    ).pipe(Effect.map((answers) => answers.join(","))),
});
