import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { DateTime, Effect, FileSystem, Option, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import { buildBoard } from "../src/board";
import type { KeptCards } from "../src/board";
import { shareBoard } from "../src/board-stream";
import { readEnv } from "../src/env";
import { makeRunModel } from "../src/run-model";
import { writeTask } from "../src/task";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";
import { encodeVerifying, VERIFYING } from "../src/verify";
import { RunRecords } from "../src/run-records";
import type { RunRecordsApi } from "../src/run-records";
import { appendCard, buildCard } from "../src/cards";
import { recordDisposition } from "../src/disposition";

const RUNS = 500;
const NOW = epochMs("2026-10-30T10:00:00Z");

test.each(["merged", "abandoned"] as const)(
  "a %s Task does not investigate its old pushed branch while drawing",
  (kind) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const at = "2026-10-30T10:00:00Z";
        const mr = "https://github.com/cego/collie/pull/1";
        const run = yield* madeRun(dir, {
          state: "failed",
          branch: "feature",
          mr,
          created: at,
          finished: at,
        });
        yield* appendCard(
          run.dir,
          buildCard({
            run: run.id,
            kind: "final",
            step: "finish",
            iteration: 1,
            at,
            intentVersion: 1,
            revision: { branch: "feature", head_sha: "abc", fingerprint: "f1", dirty: false },
            changes: { files: [], commits: [] },
            requested: { goal: null, constraints: [] },
            verifications: [],
            claims: [],
            missing: [],
            inspect: [],
            links: {},
            drift: [],
            deliveries: [],
            narrative: null,
            aligned: "unverified",
            crossRun: "none",
            significance: {
              readiness: "claimed",
              mrTouched: false,
              pendingChoice: false,
              driftUnresolved: false,
              pendingProposal: false,
              correctionUnacknowledged: false,
              blockingDrift: false,
              correctionSent: false,
              intentChanged: false,
              ended: "failed",
            },
          }),
        );
        yield* recordDisposition(run.dir, { at, by: "human", kind, ref: mr, note: null });
        const commands: Array<string> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          commands.push(command._tag === "StandardCommand" ? command.command : "pipeline");
          return Effect.die(new Error("drawing settled work must not start a command"));
        });
        const views = yield* buildBoard({
          env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
          runs: [run],
          registered: [],
          now: NOW,
          offers: () => Effect.succeed([]),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        expect(views[0]?.landed).toBe(true);
        expect(views[0]?.drift).toBeNull();
        expect(commands).toEqual([]);
      }),
    ),
);

const planners = (count: number, finished = "2026-10-27T10:00:00Z") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-cards-" });
    const created = DateTime.formatIso(DateTime.makeUnsafe(epochMs(finished) - 60 * 60_000));
    const env = readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" });
    const runs = yield* Effect.forEach(Arr.range(1, count), (n) =>
      Effect.gen(function* () {
        const task = `task-${n}`;
        yield* writeTask({
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

test("a change to one Run derives its Task's card alone, and a minute of ticks derives none", () =>
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
        cards: { revision: model.inputsAt, kept },
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
      yield* Effect.replicateEffect(Queue.take(built), 2);
      expect(derived.length).toBe(RUNS);

      const before = derived.length;
      for (const _ of Arr.range(1, 12)) {
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
  ));

test("stamping a card's age or record keeps its derivation until source facts change", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { dir, env, runs: initial } = yield* planners(3, "2026-10-30T09:30:00Z");
      let runs = initial;
      const model = yield* makeRunModel(dir, "installation");
      const derived: Array<string> = [];
      const cards: KeptCards = { revision: model.inputsAt, kept: new Map() };
      const build = (kept?: KeptCards) =>
        buildBoard({
          env,
          runs,
          registered: [],
          offers: (run) => Effect.sync(() => (derived.push(run), [])),
          cards: kept,
        }).pipe(Effect.provideService(FileSystem.FileSystem, model.reading));
      yield* model.observe(runs);
      const first = model.stamp(yield* build(cards));
      expect(derived.length).toBe(3);
      derived.length = 0;

      yield* TestClock.adjust("1 hour");
      const later = model.stamp(yield* build(cards));
      expect(later[0]!.age).not.toBe(first[0]!.age);
      expect(later[0]!.revision!.seq).toBeGreaterThan(first[0]!.revision!.seq);
      const id = runs[0].id;
      model.stampRecord("record", id, [id], "first");
      model.stampRecord("record", id, [id], "second");
      yield* build(cards);
      expect(derived).toEqual([]);

      runs = [{ ...runs[0], summary: "New engine facts" }, ...runs.slice(1)];
      yield* model.observe(runs);
      yield* build(cards);
      expect(derived).toEqual([id]);
      derived.length = 0;
      const changed = runs[1]!;
      yield* model.writing.writeFileString(`${changed.dir}/plan/issues/02-next.md`, "# Next\n");
      const updated = yield* build(cards);
      expect(derived).toEqual([changed.id]);
      expect(updated).toEqual(yield* build());
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a card another host derived is confirmed by content, without deriving it, until its facts move", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { dir, env, runs: initial } = yield* planners(5, "2026-10-30T07:30:00Z");
      let runs = initial;
      const derived: Array<string> = [];
      const build = (cards: KeptCards, model: Effect.Success<ReturnType<typeof makeRunModel>>) =>
        model.observe(runs).pipe(
          Effect.andThen(
            buildBoard({
              env,
              runs,
              registered: [],
              offers: (run) => Effect.sync(() => (derived.push(run), [])),
              cards,
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, model.reading),
        );
      const before = yield* makeRunModel(dir, "installation");
      const left: KeptCards = {
        revision: before.inputsAt,
        content: before.content,
        kept: new Map(),
      };
      const shown = yield* build(left, before);
      expect(derived.length).toBe(5);
      derived.length = 0;

      // The next host: another epoch, every card as the last one left it.
      const after = yield* makeRunModel(dir, "installation");
      const kept = new Map(
        Arr.map([...left.kept], ([task, card]) => [
          task,
          {
            key: "",
            digest: card.digest,
            due: card.due,
            view: card.view,
            unconfirmed: true as const,
          },
        ]),
      );
      const cards: KeptCards = { revision: after.inputsAt, content: after.content, kept };
      expect(yield* build(cards, after)).toEqual(shown);
      expect(derived).toEqual([]);

      runs = [{ ...runs[0], summary: "New engine facts" }, ...runs.slice(1)];
      yield* build(cards, after);
      expect(derived).toEqual([runs[0].id]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a kept card says the time as one derived now does, hours on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { dir, env, runs } = yield* planners(20, "2026-10-30T09:30:00Z");
      const model = yield* makeRunModel(dir, "installation");
      const cards: KeptCards = { revision: model.inputsAt, kept: new Map() };
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

test("a build reads every Run's check marker in one read, not one per Run", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const { dir, env, runs } = yield* planners(20);
      const model = yield* makeRunModel(dir, "installation");
      const records = yield* RunRecords;
      const read: Array<string> = [];
      const counting: RunRecordsApi = {
        ...records,
        control: (control, run, key) => {
          if (control === VERIFYING) {
            read.push(run);
          }
          return records.control(control, run, key);
        },
        everyControl: (control) => {
          if (control === VERIFYING) {
            read.push("every");
          }
          return records.everyControl(control);
        },
      };
      const cards: KeptCards = { revision: model.inputsAt, kept: new Map() };
      const build = buildBoard({
        env,
        runs,
        registered: [],
        offers: () => Effect.succeed([]),
        cards,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, model.reading),
        Effect.provideService(RunRecords, counting),
      );
      yield* build;
      expect(read).toEqual(["every"]);

      const checking = runs[7]!;
      yield* records.setControl(
        VERIFYING,
        checking.id,
        encodeVerifying({
          name: "lint",
          executable: "bun",
          argv: ["lint"],
          pass: "gate",
          round: null,
          revision: "abc",
          base: null,
          started: "2026-10-30T09:59:00Z",
        }),
      );
      read.length = 0;
      const board = yield* build;
      expect(read).toEqual(["every"]);
      expect(
        Arr.findFirst(board, (view) => view.runs.includes(checking.id)).pipe(
          Option.map((view) => view.check?.name),
          Option.getOrUndefined,
        ),
      ).toBe("lint");
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("once the model is disabled, a kept card is derived again from the disk", () =>
  runEffect(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fs = yield* FileSystem.FileSystem;
      const { dir, env, runs } = yield* planners(3);
      const run = runs[1]!;
      yield* fs.remove(`${run.dir}/plan`, { recursive: true });
      const model = yield* makeRunModel(dir, "installation");
      const cards: KeptCards = { revision: model.inputsAt, kept: new Map() };
      const opts = { env, runs, registered: [], offers: () => Effect.succeed([]) };
      const kept = buildBoard({ ...opts, cards }).pipe(
        Effect.provideService(FileSystem.FileSystem, model.reading),
      );
      yield* kept;
      yield* model.disable;
      yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${run.dir}/plan/issues/01-first.md`, "# First\n");
      expect(yield* kept).toEqual(yield* buildBoard(opts));
    }).pipe(Effect.provide(TestClock.layer())),
  ));
