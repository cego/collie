// Stands in for implement after "What next?" answered Stage: blocked on a child's result.

import { Children, Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "awaits-checkout",
  title: "Await a child in a checkout of its own",
  input: Schema.Struct({
    work: Schema.String,
    mr: Schema.String,
    child: Schema.Literals(["checks-out", "asks"]),
    inStarter: Schema.optionalKey(Schema.Boolean),
  }),
  hints: { work: "goal" },
  output: Schema.String,
  checkout: "branch",
  run: ({ input }) =>
    Effect.gen(function* () {
      const children = yield* Children;
      const child = yield* children.start(
        input.child === "checks-out"
          ? {
              invocation: "stage-1",
              workflow: "checks-out",
              input: { mr: input.mr, inStarter: input.inStarter ?? true },
            }
          : { invocation: "asks-1", workflow: "asks", input: { goal: input.work } },
      );
      const said = yield* children.result(child);
      const cwd = (yield* (yield* Host).place((yield* Run).id)).cwd;
      return `${cwd} ${String(said)}`;
    }),
});
