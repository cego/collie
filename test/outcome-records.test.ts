// The two records `run report` counts that nothing wrote before: a park, as the `halt` its
// metrics journal already documents, and a context sample read at a work boundary.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { connect } from "../src/host";
import { until } from "./support/host";
import { proves } from "./support/world";

test(
  "a park is recorded once per reason it moves into, and a clear records nothing",
  () =>
    proves(
      "collie-park-halts-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "parking",
              request: "start",
              input: { goal: "g" },
            })
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          const lines = yield* client.runMetrics({ runId }).pipe(Effect.orDie);
          expect(
            Arr.map(
              Arr.filter(lines, (line) => line.kind === "halt"),
              (line) => line.note,
            ),
          ).toEqual(["waiting on a pane", "the agent has written nothing"]);
        }),
      ["parking.workflow.ts"],
    ),
  120_000,
);
