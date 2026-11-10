// A fan-out's shape: one child per merge request, each recording the one it opened.

import { Children, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "fans-out",
  title: "Open a merge request in each repository",
  input: Schema.Struct({ mrs: Schema.String }),
  hints: { mrs: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const children = yield* Children;
      for (const mr of input.mrs.split(" ")) {
        const repo = mr.split("/")[4]!;
        const child = yield* children.start({
          invocation: repo,
          workflow: "records-mr",
          input: { mr },
          options: { repo },
        });
        yield* children.result(child);
      }
      return input.mrs;
    }),
});
