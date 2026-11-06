// One Choice per goal, each authored the way its case needs, answered and then reported.

import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const asks = {
  none: { prompt: "Which way?", options: ["Ship", "Wait", "Drop"] },
  twice: {
    prompt: "Which way?",
    options: [{ id: "ship", recommended: true }, { id: "wait", recommended: true }, { id: "drop" }],
  },
  two: {
    prompt: "Go on?",
    options: [
      {
        id: "go",
        title: "Go on",
        detail: "Starts the next piece of work.",
        recommended: true,
      },
      { id: "stop", title: "Stop", detail: "Ends the Run." },
    ],
  },
  three: {
    prompt: "Which way?",
    options: [{ id: "ship", recommended: true }, "wait", "drop"],
  },
  words: { prompt: "Which team?" },
};

export default defineWorkflow({
  id: "choices",
  title: "Ask one Choice and report the answer",
  input: Schema.Struct({ goal: Schema.Literals(["none", "twice", "two", "three", "words"]) }),
  hints: { goal: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    ask({ name: "pick", ...asks[input.goal] }).pipe(Effect.map((answer) => `took ${answer}`)),
});
