// A workflow module as an agent would write one for somebody: typed input, a service of
// its own supplied by its own Layer, an ordinary Effect operator Collie knows nothing
// about, and a typed result. Collie's whole contribution is the four imports below.

import { Host, Run, ask, defineWorkflow } from "collie";
import { Context, Effect, Layer, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

/** A service this module invented. Collie has no idea it exists, and needs none. */
interface StampApi {
  readonly around: (text: string) => string;
}
class Stamp extends Context.Service<Stamp, StampApi>()("echo/Stamp") {}

export default defineWorkflow({
  id: "echo",
  title: "Repeat a line, then ask whether to keep it",
  description: "The typed-module example: a custom service and one decision.",
  input: Schema.Struct({ text: Schema.String, times: Schema.Int }),
  output: Schema.String,
  // Supplied by this module's own Layer, which is all a custom dependency takes: the
  // service it invented reaches its own workflow and goes no further.
  layer: Layer.sync(Stamp)(() => Stamp.of({ around: (text) => `<${text}>` })),
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
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const stamp = yield* Stamp;

      const line = yield* Activity.make({
        name: "echo",
        success: Schema.String,
        execute: Effect.forEach(
          // An ordinary Effect operator over the author's own typed input. Nothing
          // here is a Collie step, a loop instruction or a repeat count it knows.
          Array.from({ length: input.times }, (_, at) => at + 1),
          (at) => Effect.succeed(`${stamp.around(input.text)}#${at}`),
        ).pipe(
          Effect.map((parts) => parts.join(" ")),
          Effect.tap((text) => host.record(run.id, `echo ${text}`)),
        ),
      });

      const keep = yield* ask({
        name: "keep",
        prompt: "Keep this result?",
        options: ["yes", "no"],
      });
      return `${line}|${keep}`;
    }),
});
