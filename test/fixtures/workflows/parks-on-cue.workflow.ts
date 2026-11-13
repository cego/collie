// Parks with a given cause once a file appears, with a question open where asked to.

import { Host, ParkCause, Run, defineWorkflow } from "collie";
import { Effect, FileSystem, Schema } from "effect";

export default defineWorkflow({
  id: "parks-on-cue",
  title: "Parks when told to",
  description: "Waits for its cue file, then parks for its cause and keeps waiting.",
  input: Schema.Struct({ cue: Schema.String, cause: Schema.String, asks: Schema.String }),
  output: Schema.String,
  hints: { cue: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const fs = yield* FileSystem.FileSystem;
      // Asked as `ask` asks, without its wait, which would suspend the Run before it parks.
      if (input.asks === "yes")
        yield* host.asking(id, {
          name: "go",
          prompt: "Go?",
          options: [
            { id: "yes", title: "yes", recommended: true },
            { id: "no", title: "no" },
          ],
        });
      while (!(yield* fs.exists(input.cue).pipe(Effect.orElseSucceed(() => false))))
        yield* Effect.sleep("100 millis");
      yield* host.parked(
        id,
        `parked for ${input.cause}`,
        Schema.decodeUnknownSync(ParkCause)(input.cause),
      );
      return yield* Effect.never;
    }),
});
