import { Host, ParkCause, Run, defineWorkflow } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";

export default defineWorkflow({
  id: "parks-for",
  title: "Parks once per entry, for the next of its causes",
  description:
    "Each entry parks twice with the next cause, `none` naming none, until none is left.",
  input: Schema.Struct({ causes: Schema.String, entries: Schema.String }),
  output: Schema.String,
  hints: { causes: "goal" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const fs = yield* FileSystem.FileSystem;
      const entered = (yield* fs.readFileString(input.entries).pipe(Effect.orElseSucceed(() => "")))
        .length;
      yield* fs.writeFileString(input.entries, "x", { flag: "a" }).pipe(Effect.orDie);
      const cause = input.causes.split(",")[entered];
      if (cause === undefined) return "unparked";
      const named = cause === "none" ? undefined : Schema.decodeUnknownSync(ParkCause)(cause);
      yield* host.parked(id, `parked for ${cause}`, named);
      yield* host.parked(id, `parked for ${cause}, said again`, named);
      return yield* Workflow.suspend(yield* WorkflowInstance);
    }),
});
