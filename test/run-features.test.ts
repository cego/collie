// What a Run's workflow does is fixed when it starts, so a Run started now records it.

import { Effect } from "effect";
import { expect, test } from "bun:test";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { featuresOf } from "../src/run-features";
import { hosted } from "./support/hosted";
import { until } from "./support/host";
import { hostRecords } from "./support/records";

test(
  "a Run started now, and one started from it, record that their follow-up rounds get a delta and their marked checks run before review",
  () =>
    hosted("hw-features-", ({ world }) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "hello",
            request: "features",
            input: { name: "features" },
          })
          .pipe(Effect.orDie);
        const child = yield* client
          .start({
            project: world.project,
            id: "hello",
            request: "features-child",
            input: { name: "" },
            parent: started.runId,
          })
          .pipe(Effect.orDie);
        for (const runId of [started.runId, child.runId]) {
          expect(yield* hostRecords(world.state, featuresOf(runId))).toEqual({
            review_delta: true,
            before_review: true,
          });
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view !== null && isSettled(view),
          );
        }
      }),
    ),
  60_000,
);
