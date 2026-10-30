import { ConnectionReading, Host, ask, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

const fileIssue = step({ id: "file", title: "File the issue", kind: "agent" });

export default defineWorkflow({
  id: "connection-step",
  input: Schema.Struct({ url: Schema.String, wait: Schema.Boolean }),
  hints: { url: "goal" },
  output: Schema.String,
  connections: {
    uses: { linear: { with: "Files an issue", without: "Continues without filing" } },
  },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const reading = yield* Activity.make({
        name: "linear",
        success: ConnectionReading,
        execute: host.connection("linear"),
      });
      if (reading.state === "ok")
        yield* fileIssue(
          Activity.make({
            name: "file",
            success: Schema.Void,
            execute: Effect.promise(() => fetch(input.url)).pipe(Effect.asVoid),
          }),
        );
      if (input.wait) yield* ask({ name: "continue", prompt: "Continue?", options: ["yes"] });
      return `continued:${reading.state}`;
    }),
});
