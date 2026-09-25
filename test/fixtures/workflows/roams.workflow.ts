import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "roams",
  title: "Roam a repository's branches",
  description: "Works in the one checkout the host cut for this repository.",
  input: Schema.Struct({ work: Schema.String }),
  output: Schema.String,
  checkout: "roaming",
  run: () =>
    Effect.gen(function* () {
      return (yield* (yield* Host).place((yield* Run).id)).cwd;
    }),
});
