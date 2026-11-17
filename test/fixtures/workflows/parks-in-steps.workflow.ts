import { Host, ParkCause, Run, defineWorkflow, step } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

const STEPS = {
  a: step({ id: "a", title: "A", kind: "check" }),
  b: step({ id: "b", title: "B", kind: "check" }),
};

export default defineWorkflow({
  id: "parks-in-steps",
  title: "Parks once per entry, in the next of its steps",
  description: "Each entry parks for its cause, in the same words, inside the next step named.",
  input: Schema.Struct({ cause: Schema.String, steps: Schema.String, entries: Schema.String }),
  output: Schema.String,
  hints: { cause: "goal" },
  path: [STEPS.a, STEPS.b],
  run: ({ input }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = (yield* fs.readFileString(input.entries).pipe(Effect.orElseSucceed(() => "")))
        .length;
      yield* fs.writeFileString(input.entries, "x", { flag: "a" }).pipe(Effect.orDie);
      const name = input.steps.split(",")[entered];
      if (name !== "a" && name !== "b") return "unparked";
      return yield* STEPS[name](
        Effect.gen(function* () {
          yield* (yield* Host).parked(
            (yield* Run).id,
            `parked for ${input.cause}`,
            Schema.decodeUnknownSync(ParkCause)(input.cause),
          );
          return yield* Workflow.suspend(yield* WorkflowInstance);
        }),
      );
    }),
});
