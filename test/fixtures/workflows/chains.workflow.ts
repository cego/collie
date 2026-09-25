// A workflow that reads the checkout it was started for and then hands the building to
// one that changes it. It says what the work is called, and nothing about where the child
// works: that is the child's declaration and the host's to settle.

import { Children, Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "chains",
  title: "Plan the work, then build it",
  description: "One agent here, then the build as a child Run.",
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      yield* (yield* Host).place((yield* Run).id);
      yield* agentWork({
        operation: "plan",
        role: "planner",
        instructions: "Plan it.",
        output: Schema.Struct({ verdict: Schema.String }),
      });
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "build",
        workflow: "builds",
        input: { work: "Add a picker" },
        options: { task: "add-a-picker" },
      });
      return String(yield* children.result(child));
    }),
});
