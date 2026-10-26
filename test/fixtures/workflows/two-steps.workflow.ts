// Two Steps: the first notes `<dir>/one` and goes on once `<dir>/open` exists, the second
// notes `<dir>/two`.

import { defineWorkflow, step } from "collie";
import { Effect, FileSystem, Schedule, Schema } from "effect";

const one = step({ id: "one", title: "Step one", kind: "check" });
const two = step({ id: "two", title: "Step two", kind: "check" });

const note = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(file, "")).pipe(Effect.orDie);

export default defineWorkflow({
  id: "two-steps",
  title: "Take two Steps",
  description: "Notes each Step it enters; the first waits for its gate.",
  input: Schema.Struct({ dir: Schema.String }),
  hints: { dir: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* one(
        Effect.gen(function* () {
          yield* note(`${input.dir}/one`);
          yield* (yield* FileSystem.FileSystem).exists(`${input.dir}/open`).pipe(
            Effect.orElseSucceed(() => false),
            Effect.repeat({ until: (open) => open, schedule: Schedule.spaced("100 millis") }),
          );
        }),
      );
      yield* two(note(`${input.dir}/two`));
      return "done";
    }),
});
