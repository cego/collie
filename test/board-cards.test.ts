import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { DateTime, Effect, FileSystem, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { buildBoard, type KeptCards } from "../src/board";
import { shareBoard } from "../src/board-stream";
import { readEnv } from "../src/env";
import { makeRunModel } from "../src/run-model";
import { writeTask } from "../src/task";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const RUNS = 500;
const NOW = epochMs("2026-10-30T10:00:00Z");

/** Planners that ran for an hour to `finished`, their plans ready: each card asks for its offer. */
const planners = (count: number, finished = "2026-10-27T10:00:00Z") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-cards-" });
    const created = DateTime.formatIso(DateTime.makeUnsafe(epochMs(finished) - 60 * 60_000));
    const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
    const runs = yield* Effect.forEach(Arr.range(1, count), (n) =>
      Effect.gen(function* () {
        const task = `task-${n}`;
        yield* writeTask(dir, {
          id: task,
          workspace: "w1",
          label: `project | Plan ${n}`,
          cwd: "/project",
          created_at: created,
        });
        const run = yield* madeRun(dir, {
          id: `r${n}`,
          task,
          workflow: "plan",
          state: "succeeded",
          created,
          finished,
        });
        yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
        yield* fs.writeFileString(`${run.dir}/plan/issues/01-first.md`, "# First\n");
        const at = DateTime.toDateUtc(DateTime.makeUnsafe(finished));
        yield* fs.utimes(`${run.dir}/plan`, at, at);
        return run;
      }),
    );
    return { dir, env, runs };
  });

test(
  "a change to one Run derives its Task's card alone, and a minute of ticks derives none",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const { dir, env, runs } = yield* planners(RUNS);
        const model = yield* makeRunModel(dir, "installation");
        const derived: Array<string> = [];
        const built = yield* Queue.unbounded<number>();
        const kept = new Map();
        const build = buildBoard({
          env,
          runs,
          registered: [],
          offers: (run) => Effect.sync(() => (derived.push(run), [])),
          cards: { revision: model.highest, kept },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, model.reading),
          Effect.tap(() => Queue.offer(built, derived.length)),
        );
        const poked = yield* Queue.unbounded<void>();
        yield* shareBoard({
          build,
          changed: Stream.fromQueue(poked),
          refresh: Stream.tick("5 seconds"),
        });
        // The first build, then the tick's own first beat.
        yield* Effect.replicateEffect(Queue.take(built), 2);
        expect(derived.length).toBe(RUNS);

        const before = derived.length;
        for (const _ of Arr.range(1, 12)) {
          // Lets the last build end, so the next tick is waiting on the clock.
          yield* TestClock.withLive(Effect.sleep("20 millis"));
          yield* TestClock.adjust("5 seconds");
          yield* Queue.take(built);
        }
        expect(derived.slice(before)).toEqual([]);

        const changed = runs[41]!;
        yield* model.writing.writeFileString(`${changed.dir}/handoff.md`, "next\n");
        yield* Queue.offer(poked, undefined);
        yield* Queue.take(built);
        expect(derived.slice(before)).toEqual([changed.id]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  60_000,
);

test("a kept card says the time as one derived now does, hours on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      // Finished half an hour ago: shown as quiet, then gone a day after.
      const { dir, env, runs } = yield* planners(20, "2026-10-30T09:30:00Z");
      const model = yield* makeRunModel(dir, "installation");
      const cards: KeptCards = { revision: model.highest, kept: new Map() };
      const build = (kept?: KeptCards) =>
        buildBoard({
          env,
          runs,
          registered: [],
          offers: () => Effect.succeed([]),
          cards: kept,
        }).pipe(Effect.provideService(FileSystem.FileSystem, model.reading));
      yield* build(cards);
      for (const step of ["59 seconds", "2 minutes", "3 hours", "21 hours"] as const) {
        yield* TestClock.adjust(step);
        expect([step, yield* build(cards)]).toEqual([step, yield* build()]);
      }
    }).pipe(Effect.provide(TestClock.layer())),
  ));
