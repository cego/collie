// A workflow module as an author writes one: ordinary TypeScript, plain Effect, and no
// Collie vocabulary beyond the service the host lends it. The test copies this file, its
// helper and its Markdown outside the checkout, so what runs it is the binary alone.

import { Host, ask, decision, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { label } from "./helper.ts";
import notes from "./notes.md" with { type: "text" };

export const id = "proof";
export const title = "A workflow that waits for a decision";
export const description = "Records one launch, then waits to be answered.";

export const input = { note: Schema.String };

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const answer = decision("decision", { prompt: "What should this run do?" });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* Host;
      const run = yield* WorkflowEngine.WorkflowInstance;

      // Recorded once, whatever a replay does: an Activity's result is the durable one,
      // and every later attempt reads it back rather than launching again.
      yield* Activity.make({
        name: "launch",
        success: Schema.String,
        execute: host
          .record(payload.runId, `launch ${label(payload.input.note)} ${notes.length}`)
          .pipe(Effect.as("launched")),
      });

      // A hold is read at each boundary rather than inside an Activity: an Activity would
      // hand back the answer from the attempt that first ran, and an operator sets this
      // between attempts. Suspending leaves the run exactly where it is until release
      // resumes it.
      const holding = Effect.gen(function* () {
        if (!(yield* host.held(payload.runId))) return false;
        yield* host.record(payload.runId, "held");
        return true;
      });
      if (yield* holding) return yield* Workflow.suspend(run);

      const chosen = yield* Activity.make({
        name: "wait",
        success: Schema.String,
        execute: Effect.gen(function* () {
          // The wait's own instance, not the run's: suspending the enclosing workflow
          // from in here would abandon the Activity rather than park it, and the next
          // attempt would have nothing to re-enter.
          const wait = yield* WorkflowEngine.WorkflowInstance;
          yield* host.record(payload.runId, "wait");
          if (yield* host.stopRequested(payload.runId)) {
            yield* host.record(payload.runId, "stopped");
            return yield* Workflow.suspend(wait);
          }
          // Asked through the host, not awaited directly: a host that does not know
          // what a run is waiting on cannot refuse an answer to a question nobody asked.
          return yield* ask(payload.runId, answer);
        }),
      });

      if (yield* holding) return yield* Workflow.suspend(run);
      return `${label(payload.input.note)}=${chosen}`;
    }),
  );

  return { workflow, layer, decisions: { decision: answer } };
};
