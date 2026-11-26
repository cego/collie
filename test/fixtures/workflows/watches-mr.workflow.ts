import { defineWorkflow, Host, Run, watch } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "watches-mr",
  title: "Wait on a merge request",
  description: "Waits, with no agent, until its merge request changes in a way that matters.",
  input: Schema.Struct({
    target: Schema.String,
    head: Schema.String,
    cwd: Schema.String,
    /** How many watches to take, the next one from the head the last one woke on. */
    rounds: Schema.optionalKey(Schema.Finite),
  }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      let head = input.head;
      let woke = "";
      for (let round = 1; round <= (input.rounds ?? 1); round++) {
        const seen = yield* watch({
          name: `round-${round}`,
          target: input.target,
          cwd: input.cwd,
          cursor: { head, seen: [], pipeline: "passed" },
        });
        const next = seen._tag === "Changed" ? seen.change.head : head;
        yield* host.record(run.id, `round-${round}: ${head} -> ${next}`);
        head = next;
        woke = JSON.stringify(seen);
      }
      return woke;
    }),
});
