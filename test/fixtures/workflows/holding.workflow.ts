import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "holding",
  title: "Hold the findings it was given until told to go",
  description: "Asks one question and stays going until it is told to go on.",
  input: Schema.Struct({ findings: Schema.optionalKey(Schema.Array(Schema.String)) }),
  hints: { findings: "goal" },
  output: Schema.String,
  run: () => ask({ name: "go", prompt: "Go on?" }).pipe(Effect.map(String)),
});
