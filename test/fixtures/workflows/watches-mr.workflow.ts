import { defineWorkflow, Host, Run, watch } from "collie";
import { Effect, FileSystem, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

const Posted = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  signature: Schema.optionalKey(Schema.String),
});

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
    /** The rounds whose review found something to post. */
    notes: Schema.optionalKey(Schema.Array(Schema.Finite)),
    /** The rounds that began no review, as one a moved head or a refused wake leaves it. */
    skipped: Schema.optionalKey(Schema.Array(Schema.Finite)),
    /** Minutes a round's review takes, so the head can move under it. */
    review: Schema.optionalKey(Schema.Finite),
  }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const fs = yield* FileSystem.FileSystem;
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
        const began = input.skipped?.includes(round) !== true;
        if (began) {
          yield* Activity.make({
            name: `begin-${round}`,
            execute: host.startedRound({
              runId: run.id,
              target: input.target,
              name: `round-${round}`,
              head: next,
            }),
          });
        }
        yield* host.record(run.id, `round-${round}: reviewing ${next}`);
        if ((input.review ?? 0) > 0) {
          yield* Effect.sleep(`${input.review} minutes`);
        }
        if (input.notes?.includes(round) === true) {
          const file = `${input.cwd}/round-${round}.md`;
          yield* fs.writeFileString(file, `What round ${round} found.\n`).pipe(Effect.orDie);
          const posted = yield* Activity.make({
            name: `post-${round}`,
            success: Posted,
            execute: host.post({
              runId: run.id,
              target: input.target,
              cwd: input.cwd,
              file,
              head: next,
              round,
            }),
          });
          yield* host.record(run.id, `round-${round} posted: ${posted.message}`);
        } else {
          yield* host.record(run.id, `round-${round}: no findings to post`);
        }
        if (began) {
          yield* Activity.make({
            name: `end-${round}`,
            execute: host.completedRound({ runId: run.id, target: input.target }),
          });
        }
        head = next;
        woke = JSON.stringify(seen);
      }
      return woke;
    }),
});
