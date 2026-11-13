import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "choice-offer",
  title: "Choose what follows",
  description: "Offers an empty choice separately from leaving it unset.",
  input: Schema.Struct({
    mr: Schema.String,
    // oxlint-disable-next-line unicorn/no-thenable -- the workflow Input is named `then`
    then: Schema.optionalKey(Schema.Literals(["", "finish"])),
  }),
  hints: { mr: "goal" },
  output: Schema.String,
  followUps: [
    {
      id: "choose",
      title: "Choose next",
      workflow: "choice-offer",
      when: "succeeded",
      inputs: { mr: "started-with" },
    },
  ],
  run: ({ input }) => Effect.succeed(JSON.stringify(input)),
});
