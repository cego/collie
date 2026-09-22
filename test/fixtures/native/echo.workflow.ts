// A workflow module as an agent would write one for somebody: typed input, a service of
// its own supplied by its own Layer, an ordinary Effect operator Collie knows nothing
// about, and a typed result. Collie's whole contribution is the four imports below.

import { NativeHost, ask, decision, defineWorkflow, type WorkflowMetadata } from "collie/native";
import { Context, Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export const id = "echo";
export const title = "Repeat a line, then ask whether to keep it";
export const description = "The typed-module example: a custom service and one decision.";

export const input = {
  text: Schema.String,
  times: Schema.Int,
};

/** A service this module invented. Collie has no idea it exists, and needs none. */
interface StampApi {
  readonly around: (text: string) => string;
}
class Stamp extends Context.Service<Stamp, StampApi>()("echo/Stamp") {}

/** Supplied by this module's own Layer, which is all a custom dependency takes. */
const StampLayer = Layer.sync(Stamp)(() => Stamp.of({ around: (text) => `<${text}>` }));

export const metadata: WorkflowMetadata = {
  hints: { text: "work-source" },
  outcome: { selectable: ["feature", "docs"] },
  followUps: [{ id: "echo-again", title: "Echo it again", workflow: "echo", when: "succeeded" }],
  actions: [
    {
      id: "echo-louder",
      title: "Echo it louder",
      workflow: "echo",
      arguments: { text: Schema.String, times: Schema.Int },
      eligible: (facts) => facts.succeeded && !facts.disposed,
    },
  ],
};

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const keep = decision("keep", { prompt: "Keep this result?", options: ["yes", "no"] });

  const layer = workflow
    .toLayer(
      Effect.fnUntraced(function* (payload) {
        const host = yield* NativeHost;
        const stamp = yield* Stamp;

        const line = yield* Activity.make({
          name: "echo",
          success: Schema.String,
          execute: Effect.forEach(
            // An ordinary Effect operator over the author's own typed input. Nothing
            // here is a Collie step, a loop instruction or a repeat count it knows.
            Array.from({ length: payload.input.times }, (_, at) => at + 1),
            (at) => Effect.succeed(`${stamp.around(payload.input.text)}#${at}`),
          ).pipe(
            Effect.map((parts) => parts.join(" ")),
            Effect.tap((text) => host.record(payload.runId, `echo ${text}`)),
          ),
        });

        return `${line}|${yield* ask(payload.runId, keep)}`;
      }),
    )
    // Explicitly provided, because merging siblings supplies nothing: the service this
    // module invented reaches its own workflow and goes no further.
    .pipe(Layer.provide(StampLayer));

  return { workflow, layer, decisions: { keep } };
};
