// Stands in for Stage: it works in the reviewed branch's checkout, and says which it was given.

import { Host, Run, defineWorkflow } from "collie";
import * as Activity from "effect/workflow/Activity";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "checks-out",
  title: "Check out the reviewed branch",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "diff-target" },
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const runId = (yield* Run).id;
      const checkout = yield* Activity.make({
        name: "checkout",
        success: Schema.Union([
          Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
          Schema.Struct({ refused: Schema.String }),
        ]),
        execute: (yield* Host).checkoutReviewed(runId),
      });
      return "refused" in checkout ? `refused: ${checkout.refused}` : checkout.cwd;
    }),
});
