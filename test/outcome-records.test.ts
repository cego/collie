// The two records `run report` counts that nothing wrote before: a park, as the `halt` its
// metrics journal already documents, and a context sample read at a work boundary.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { TaskView } from "../src/board-model";
import { connect } from "../src/host";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

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

const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

/** A `parks-for` Run started on a host of this world, once it has parked. */
const parkedFor = Effect.fn("test.parkedFor")(function* (world: World, causes: string) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const { runId } = yield* client
    .start({
      project: world.project,
      id: "parks-for",
      request: "start",
      input: { causes, entries: `${world.home}/entries` },
    })
    .pipe(Effect.orDie);
  const parked = yield* until(
    () => client.run({ runId }).pipe(Effect.orDie),
    (view) => view?.status.status === "suspended" && view.parked !== null,
  );
  return { client, runId, parked: parked! };
});

const parkNotices = (world: World, runId: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(`${world.state}/notified.${runId}`).pipe(Effect.orElseSucceed(() => "")),
  ).pipe(
    Effect.map((text) =>
      Arr.filter(Str.split(text, "\n"), (line) => pipe(line, Str.includes(":parked:"))),
    ),
  );

test(
  "a park names its cause and kind on `run show` and the card, and its halt line names the cause and the host's build",
  () =>
    proves(
      "collie-park-cause-",
      (world) =>
        Effect.gen(function* () {
          const { client, runId } = yield* parkedFor(world, "ci-job-absent");
          const park = { cause: "ci-job-absent", kind: "rechecks" };
          const shown = yield* collie(world, ["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({ run: { runId, park } });
          const printed = yield* collie(world, ["board"]);
          const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
            Effect.orDie,
          );
          expect(Arr.findFirst(tasks, (task) => task.run === runId)).toMatchObject(
            Option.some({ park }),
          );
          const { build } = yield* client.identity().pipe(Effect.orDie);
          const halts = Arr.filter(
            yield* client.runMetrics({ runId }).pipe(Effect.orDie),
            (line) => line.kind === "halt",
          );
          expect(halts).toEqual([
            expect.objectContaining({ cause: "ci-job-absent", build }),
            expect.objectContaining({ cause: "ci-job-absent", build }),
          ]);
        }),
      ["parks-for.workflow.ts"],
    ),
  120_000,
);

test(
  "a park that names no cause is recorded as unknown, and still needs you",
  () =>
    proves(
      "collie-park-unknown-",
      (world) =>
        Effect.gen(function* () {
          const { runId, parked } = yield* parkedFor(world, "none");
          expect(parked.park).toMatchObject({ cause: "unknown", kind: "needs-you" });
          expect(yield* parkNotices(world, runId)).toEqual(["needs-you:parked:unknown"]);
        }),
      ["parks-for.workflow.ts"],
    ),
  120_000,
);

test(
  "a recheck park stays quiet when a manual resume enters another recheck park",
  () =>
    proves(
      "collie-park-notices-",
      (world) =>
        Effect.gen(function* () {
          const { client, runId } = yield* parkedFor(world, "forge-unavailable,ci-job-absent");
          expect(yield* parkNotices(world, runId)).toEqual([]);
          yield* client.resume({ runId, request: "resume-1" }).pipe(Effect.orDie);
          const again = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.park?.cause === "ci-job-absent",
          );
          expect(again?.parked).toContain("ci-job-absent");
          expect(yield* parkNotices(world, runId)).toEqual([]);
          const records = yield* client.runOutcomes({ runId }).pipe(Effect.orDie);
          expect(records.resumes).toEqual([{ at: expect.any(String), origin: "cli" }]);
          const reported = yield* collie(world, ["run", "report"]);
          expect(reported.envelope.data).toMatchObject({
            measures: {
              parks: {
                byCause: [
                  { cause: "ci-job-absent", count: 2, runs: [runId], humanResumes: 0 },
                  { cause: "forge-unavailable", count: 2, runs: [runId], humanResumes: 0 },
                ],
              },
            },
          });
        }),
      ["parks-for.workflow.ts"],
    ),
  120_000,
);
