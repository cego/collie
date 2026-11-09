// A workflow's Choice as a questionnaire: a recommendation missing or doubled is flagged and
// never fatal, and a Choice of fewer than three options offers Hold the Run.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Result, Schema, flow } from "effect";
import { connect } from "../src/host";
import { RunView } from "../src/engine";
import { TaskView } from "../src/board-model";
import { describeWaiting } from "../src/lifecycle";
import { factsOfView } from "../src/runs";
import { runWaits } from "../src/run-waits";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const decodeShown = flow(
  Schema.decodeUnknownResult(Schema.Struct({ run: RunView })),
  Result.getOrThrow,
);

const shown = (world: World, runId: string) =>
  collie(world, ["run", "show", runId]).pipe(
    Effect.map(({ envelope }) => decodeShown(envelope.data).run),
  );

const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const boardQuestions = (world: World, runId: string) =>
  Effect.gen(function* () {
    const printed = yield* collie(world, ["board"]);
    const { tasks } = yield* Schema.decodeUnknownEffect(Board)(printed.envelope.data).pipe(
      Effect.orDie,
    );
    return Arr.flatMap(tasks, (task) => (task.run === runId ? (task.questions ?? []) : []));
  });

const question = (world: World, view: RunView) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [first] = (yield* runWaits(factsOfView(world.state, view), [], [], now)).questions;
    return first;
  });

const asking = (world: World, goal: string) =>
  Effect.gen(function* () {
    const host = yield* connect(world.state);
    const { runId } = yield* host.start({
      project: world.project,
      id: "choices",
      request: `start-${goal}`,
      input: { goal },
    });
    const view = yield* until(
      () => shown(world, runId),
      (seen) => Arr.some(seen.waiting, (one) => one.name === "pick" && one.answer === null),
    );
    return { runId, view };
  });

const answered = (world: World, runId: string, value: string) =>
  Effect.gen(function* () {
    yield* collie(world, ["run", "answer", runId, value, "--decision", "pick"]);
    const host = yield* connect(world.state);
    return yield* until(
      () => host.status({ runId }),
      (status) => status.status === "complete",
    );
  });

const logOf = (world: World, runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(`${world.state}/runs/${runId}/log.txt`);
  });

test(
  "a Choice that recommends none is posted unmarked with a shortfall, logged, and goes on",
  () =>
    proves(
      "collie-choices-none-",
      (world) =>
        Effect.gen(function* () {
          const { runId, view } = yield* asking(world, "none");
          const pick = yield* question(world, view);
          expect(pick?.shortfall).toBe("this workflow recommended none");
          expect(Arr.map(pick?.options ?? [], (one) => [one.id, one.recommended])).toEqual([
            ["Ship", undefined],
            ["Wait", undefined],
            ["Drop", undefined],
          ]);
          expect(describeWaiting(view)).toContain("  ⚠ this workflow recommended none");
          expect(Arr.map(yield* boardQuestions(world, runId), (one) => one.steer)).toEqual([
            {
              agent: null,
              why: "no agent of this Run is live to redirect: pick a solution or stop the Run",
            },
          ]);
          expect(yield* logOf(world, runId)).toContain('"pick": this workflow recommended none');
          expect(yield* answered(world, runId, "wait")).toMatchObject({ value: "took Wait" });
        }).pipe(Effect.orDie),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "a Choice that recommends two is posted unmarked with its own shortfall",
  () =>
    proves(
      "collie-choices-twice-",
      (world) =>
        Effect.gen(function* () {
          const { runId, view } = yield* asking(world, "twice");
          const pick = yield* question(world, view);
          expect(pick?.shortfall).toBe("this workflow recommended more than one");
          expect(Arr.map(pick?.options ?? [], (one) => [one.id, one.recommended])).toEqual([
            ["ship", undefined],
            ["wait", undefined],
            ["drop", undefined],
          ]);
          expect(yield* logOf(world, runId)).toContain(
            '"pick": this workflow recommended more than one',
          );
          expect(yield* answered(world, runId, "drop")).toMatchObject({ value: "took drop" });
        }).pipe(Effect.orDie),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "a two-option Choice offers Hold, which holds the Run and leaves the Choice open",
  () =>
    proves(
      "collie-choices-hold-",
      (world) =>
        Effect.gen(function* () {
          const { runId, view } = yield* asking(world, "two");
          const pick = yield* question(world, view);
          expect(pick?.hold).toEqual({ offered: true, why: null });
          expect(pick?.shortfall).toBeUndefined();
          expect(describeWaiting(view)).toEqual([
            'waiting on "pick": Go on? (Go on (Recommended) | Stop)',
            "  Go on (Recommended): Starts the next piece of work.",
            "  Stop: Ends the Run.",
            `  Hold the Run: collie run hold ${runId} --reason "held at question pick"`,
          ]);

          yield* collie(world, ["run", "hold", runId, "--reason", "held at question pick"]);
          const held = yield* until(
            () => shown(world, runId),
            (seen) => seen.controls.includes("hold"),
          );
          expect(Arr.map(held.waiting, (one) => [one.name, one.answer])).toEqual([["pick", null]]);
          expect((yield* question(world, held))?.hold).toEqual({
            offered: false,
            why: "Run already held",
          });
          expect(describeWaiting(held)).toContain("  Hold the Run: unavailable, Run already held");

          yield* collie(world, ["run", "release", runId]);
          expect(yield* answered(world, runId, "go")).toMatchObject({ value: "took go" });
        }).pipe(Effect.orDie),
      ["choices.workflow.ts"],
    ),
  120_000,
);

test(
  "Hold is not offered on three options, nor on a question answered in words",
  () =>
    proves(
      "collie-choices-no-hold-",
      (world) =>
        Effect.gen(function* () {
          const three = yield* asking(world, "three");
          const pick = yield* question(world, three.view);
          expect(pick?.hold).toBeUndefined();
          expect(pick?.shortfall).toBeUndefined();
          expect(pick?.options[0]).toMatchObject({ id: "ship", recommended: true });

          const words = yield* asking(world, "words");
          const team = yield* question(world, words.view);
          expect(team?.options).toEqual([]);
          expect(team?.hold).toBeUndefined();
          expect(team?.shortfall).toBeUndefined();
          expect(yield* answered(world, words.runId, "platform, the infra team")).toMatchObject({
            value: "took platform, the infra team",
          });
        }).pipe(Effect.orDie),
      ["choices.workflow.ts"],
    ),
  120_000,
);
