import { agentWork, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const first = step({ id: "a", title: "A", kind: "agent", role: "implementer" });
const second = step({ id: "b", title: "B", kind: "agent", role: "implementer" });
const third = step({ id: "c", title: "C", kind: "check" });
const question = step({ id: "question", title: "Question", kind: "question" });
const agent = (operation: string) =>
  agentWork({
    operation,
    role: "implementer",
    instructions: "Do {{goal}}",
    input: { goal: operation },
    output: Schema.String,
  });
export default defineWorkflow({
  id: "step-ahead",
  title: "Steer ahead",
  description: "Three boundaries to steer.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  path: [first, second, third, question],
  run: () =>
    Effect.gen(function* () {
      yield* first(agent("a"));
      yield* second(agent("b"));
      yield* third(Effect.void);
      return "done";
    }),
});
