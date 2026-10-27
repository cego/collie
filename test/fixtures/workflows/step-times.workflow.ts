import { defineWorkflow, step } from "collie";
import { Effect, FileSystem, Schedule, Schema } from "effect";
const b = step({ id: "b", title: "B", kind: "check" });
export default defineWorkflow({
  id: "step-times",
  title: "Timed Steps",
  description: "A Step on the proof host's clock.",
  input: Schema.Struct({ goal: Schema.String, gate: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  path: [b],
  run: ({ input }) =>
    b(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .exists(input.gate)
          .pipe(Effect.repeat({ until: Boolean, schedule: Schedule.spaced("5 millis") }));
        return "done";
      }),
    ),
});
