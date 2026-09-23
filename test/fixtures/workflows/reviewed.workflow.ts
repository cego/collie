// The parent: it reads the shared contract itself and has a child workflow read it too.
//
// Two ways of reaching the same contract, on purpose. `reviewed` is a concrete import, so
// no lookup happens and this file decides what it gets. `graded` is a public workflow id,
// so the search path decides — and a project that overrides it overrides it here as well.

import { Host, ask, child, decision, defineWorkflow } from "collie";
import { Effect, Layer, Schema } from "effect";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { reviewLayer, reviewed } from "./capability.ts";
import { HOUSE } from "./house.ts";

export const id = "reviewed";
export const title = "Review a list of notes, one child each";
export const description = "Reads the shared contract, then has a child read it per note.";

export const input = {
  /** A comma-separated list, because how many children there are is the author's loop. */
  notes: Schema.String,
  /** Any string here; the child takes two of them, and the child is what decides. */
  grade: Schema.String,
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const signOff = decision("sign-off", { prompt: "Sign this review off?" });

  const layer = workflow
    .toLayer(
      Effect.fnUntraced(function* (payload) {
        const host = yield* Host;
        const run = yield* WorkflowEngine.WorkflowInstance;
        if (yield* host.held(payload.runId)) {
          yield* host.record(payload.runId, "held");
          return yield* Workflow.suspend(run);
        }

        const notes = payload.input.notes.split(",");
        // An ordinary list and an ordinary operator: how many children there are, and in
        // what order, is TypeScript rather than anything Collie was told about.
        const graded = yield* Effect.forEach(notes, (note) =>
          child({
            runId: payload.runId,
            invocation: `grade-${note}`,
            workflow: "graded",
            input: { note, grade: payload.input.grade },
          }),
        );

        const mine = yield* reviewed(payload.input.notes);
        // Answered after the children, so answering replays a parent that already has them.
        return `${mine}+${graded.join("+")}+${yield* ask(payload.runId, signOff)}`;
      }),
    )
    .pipe(Layer.provide(reviewLayer(HOUSE)));

  return { workflow, layer, decisions: { "sign-off": signOff } };
};
