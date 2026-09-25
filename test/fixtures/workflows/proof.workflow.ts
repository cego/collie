// A workflow module as an author writes one: ordinary TypeScript, plain Effect, and no
// Collie vocabulary beyond the service the host lends it. The test copies this file, its
// helper and its Markdown outside the checkout, so what runs it is the binary alone.

import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { label } from "./helper.ts";
import notes from "./notes.md" with { type: "text" };

export default defineWorkflow({
  id: "proof",
  title: "A workflow that waits for a decision",
  description: "Records one launch, then waits to be answered.",
  input: Schema.Struct({ note: Schema.String }),
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const run = yield* WorkflowEngine.WorkflowInstance;

      // Recorded once, whatever a replay does: an Activity's result is the durable one,
      // and every later attempt reads it back rather than launching again.
      yield* Activity.make({
        name: "launch",
        success: Schema.String,
        execute: host
          .record(runId, `launch ${label(input.note)} ${notes.length}`)
          .pipe(Effect.as("launched")),
      });

      // A hold is read at each boundary rather than inside an Activity: an Activity would
      // hand back the answer from the attempt that first ran, and an operator sets this
      // between attempts. Suspending leaves the run exactly where it is until release
      // resumes it.
      const holding = Effect.gen(function* () {
        if (!(yield* host.held(runId))) return false;
        yield* host.record(runId, "held");
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
          yield* host.record(runId, "wait");
          if (yield* host.stopRequested(runId)) {
            yield* host.record(runId, "stopped");
            return yield* Workflow.suspend(wait);
          }
          // Asked through the host, not awaited directly: a host that does not know
          // what a run is waiting on cannot refuse an answer to a question nobody asked.
          return yield* ask({ name: "decision", prompt: "What should this run do?" });
        }),
      });

      if (yield* holding) return yield* Workflow.suspend(run);
      return `${label(input.note)}=${chosen}`;
    }),
});
