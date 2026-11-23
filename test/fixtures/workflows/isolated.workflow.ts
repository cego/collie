import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "isolated",
  title: "Say how each check is isolated",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const checks = yield* (yield* Host).approved(run.id);
      return checks
        .map((spec) =>
          spec.isolated === true
            ? `${spec.name}: after ${spec.prepare?.executable ?? "nothing"} ${(spec.prepare?.argv ?? []).join(" ")}`
            : `${spec.name}: in the Worktree`,
        )
        .join("\n");
    }),
});
