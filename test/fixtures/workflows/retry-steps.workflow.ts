import { defineWorkflow, Host, Run, step, stepFailed } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
const first = step({ id: "first", title: "First", kind: "check" });
const second = step({ id: "second", title: "Second", kind: "check" });
export default defineWorkflow({
  id: "retry-steps",
  title: "Retry a Step",
  description: "Fails its second Step until the fixture permits it.",
  input: Schema.Struct({ gates: Schema.String }),
  hints: { gates: "goal" },
  output: Schema.String,
  path: [first, second],
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* first(Effect.void);
      yield* second(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          if (yield* fs.exists(`${input.gates}/pass`)) return;
          yield* stepFailed("Second failed");
          yield* (yield* Host).parked((yield* Run).id, "Second failed");
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }),
      );
      return "done";
    }),
});
