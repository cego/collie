import { defineWorkflow, Run, step } from "collie";
import { Clock, Config, Effect, FileSystem, Schema } from "effect";

const write = step({ id: "write", title: "Append log", kind: "check" });

export default defineWorkflow({
  id: "bench-active",
  title: "Write while watched",
  checkout: "branch",
  description: "Appends numbered log markers every two seconds.",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const state = yield* Config.String("HERDR_PLUGIN_STATE_DIR");
      const project = yield* Config.String("COLLIE_CWD");
      const fs = yield* FileSystem.FileSystem;
      for (let round = 1; round <= 29; round++) {
        yield* write(
          Effect.gen(function* () {
            const at = yield* Clock.currentTimeMillis;
            yield* fs.writeFileString(
              `${state}/runs/${run.id}/log.txt`,
              `bench-log:${round}:${at}\n`,
              { flag: "a" },
            );
            if (round === 10)
              yield* fs.writeFileString(
                `${project}/sample.ts`,
                "export const sample = 2;\nexport const changed = true;\n",
              );
            if (round === 20)
              yield* fs.writeFileString(
                `${project}/sample.ts`,
                "export const sample = 3;\nexport const changed = true;\nexport const final = true;\n",
              );
            yield* Effect.sleep("2 seconds");
          }),
          { round },
        );
      }
      return "wrote 29 log markers";
    }).pipe(Effect.orDie),
});
