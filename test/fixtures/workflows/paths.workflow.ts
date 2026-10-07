// A module saved before Effect 4.0.1 moved the workflow modules out of `unstable`, beside
// one written after: both paths have to be the host's own objects, or the old one breaks.

import { Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import * as BeforeActivity from "effect/unstable/workflow/Activity";
import * as BeforeWorkflow from "effect/unstable/workflow/Workflow";

export default defineWorkflow({
  id: "paths",
  title: "Run an Activity from each workflow path",
  description: "Records one Activity per path, and whether the paths are the same objects.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const before = yield* BeforeActivity.make({
        name: "before",
        success: Schema.String,
        execute: host.record(runId, "before").pipe(Effect.as("before")),
      });
      const after = yield* Activity.make({
        name: "after",
        success: Schema.String,
        execute: host.record(runId, "after").pipe(Effect.as("after")),
      });
      const same = BeforeActivity.make === Activity.make && BeforeWorkflow.make === Workflow.make;
      return `${input.note}:${before}+${after}:${same ? "same" : "copies"}`;
    }),
});
