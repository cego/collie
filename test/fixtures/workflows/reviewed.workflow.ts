// The parent: it reads the shared contract itself and has a child workflow read it too.
//
// Two ways of reaching the same contract, on purpose. `reviewed` is a concrete import, so
// no lookup happens and this file decides what it gets. `graded` is a public workflow id,
// so the search path decides — and a project that overrides it overrides it here as well.

import { Host, Run, ask, child, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { reviewLayer, reviewed } from "./capability.ts";
import { HOUSE } from "./house.ts";

export default defineWorkflow({
  id: "reviewed",
  title: "Review a list of notes, one child each",
  description: "Reads the shared contract, then has a child read it per note.",
  input: Schema.Struct({
    /** A comma-separated list, because how many children there are is the author's loop. */
    notes: Schema.String,
    /** Any string here; the child takes two of them, and the child is what decides. */
    grade: Schema.String,
  }),
  output: Schema.String,
  layer: reviewLayer(HOUSE),
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const run = yield* WorkflowEngine.WorkflowInstance;
      if (yield* host.held(runId)) {
        yield* host.record(runId, "held");
        return yield* Workflow.suspend(run);
      }

      const notes = input.notes.split(",");
      // An ordinary list and an ordinary operator: how many children there are, and in
      // what order, is TypeScript rather than anything Collie was told about.
      const graded = yield* Effect.forEach(notes, (note) =>
        child({
          invocation: `grade-${note}`,
          workflow: "graded",
          input: { note, grade: input.grade },
        }),
      );

      const mine = yield* reviewed(input.notes);
      // Answered after the children, so answering replays a parent that already has them.
      const signed = yield* ask({ name: "sign-off", prompt: "Sign this review off?" });
      return `${mine}+${graded.join("+")}+${signed}`;
    }),
});
