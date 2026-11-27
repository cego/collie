import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Order, Result, Schema, Stream } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import {
  listTasks,
  readTask,
  removeTask,
  TASKS,
  TaskSchema,
  taskOfWorkspace,
  withTaskLock,
  writeTask,
} from "../src/task";
import type { TaskRecord } from "../src/task";
import { TaskWrites } from "../src/store-writes";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";
import { stopHost, until } from "./support/host";
import { collie, proves } from "./support/world";
import type { World } from "./support/world";
import { cardActions, sectionOf, TaskView } from "../src/board-model";
import { frontDoor, socketOf } from "../src/host";
import { Database } from "bun:sqlite";

const asJson = (task: TaskRecord) =>
  Result.getOrThrow(Schema.encodeResult(Schema.fromJsonString(TaskSchema))(task));

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({ prefix: "hw-tasks-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const task = (over: Partial<TaskRecord> = {}) => ({
  id: "task-1",
  workspace: "w1",
  label: "Project | Picker",
  cwd: "/project",
  root_pane: null,
  herd: "herd-1",
  created_at: "2026-09-01T00:00:00.000Z",
  ...over,
});

test("a Task round trips through the host's database, and the newest is listed first", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeTask(task());
      yield* writeTask(
        task({ id: "task-2", workspace: null, created_at: "2026-09-02T00:00:00.000Z" }),
      );
      yield* writeTask(task({ label: "Project | Renamed" }));

      expect(yield* readTask("task-1")).toEqual(task({ label: "Project | Renamed" }));
      expect(Arr.map(yield* listTasks, (one) => one.id)).toEqual(["task-2", "task-1"]);
      expect(yield* readTask("task-9")).toBeNull();

      yield* removeTask("task-1");
      expect(yield* readTask("task-1")).toBeNull();
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a workspace's Task is the one kept there, and no workspace has none", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeTask(task());
      yield* writeTask(task({ id: "task-2", workspace: "w2" }));
      expect((yield* taskOfWorkspace("w2"))?.id).toBe("task-2");
      expect(yield* taskOfWorkspace("w3")).toBeNull();
      expect(yield* taskOfWorkspace(null)).toBeNull();
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the first host imports each Task file once, and leaves the files in place", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/tasks`);
      yield* fs.writeFileString(`${stateDir}/tasks/task-1.json`, `${asJson(task())}\n`);
      yield* fs.writeFileString(`${stateDir}/tasks/task-2.json`, "not a task");

      expect(yield* Effect.provide(listTasks, recordsAt(stateDir))).toEqual([task()]);
      yield* fs.writeFileString(
        `${stateDir}/tasks/task-3.json`,
        `${asJson(task({ id: "task-3" }))}\n`,
      );
      expect(
        Arr.map(yield* Effect.provide(listTasks, recordsAt(stateDir)), (one) => one.id),
      ).toEqual(["task-1"]);
      expect(yield* fs.exists(`${stateDir}/tasks/task-1.json`)).toBe(true);
    }),
  ));

test("a Task file the first host cannot read fails its import, and the next host imports it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${stateDir}/tasks/task-1.json`;
      yield* fs.makeDirectory(`${stateDir}/tasks`);
      yield* fs.writeFileString(file, `${asJson(task())}\n`);
      yield* fs.chmod(file, 0o000);

      const refused = yield* Effect.exit(Effect.provide(listTasks, recordsAt(stateDir)));
      expect(refused._tag).toBe("Failure");
      yield* fs.chmod(file, 0o644);
      expect(yield* Effect.provide(listTasks, recordsAt(stateDir))).toEqual([task()]);
    }),
  ));

test("a Task written or removed tells the Run model which Task moved", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: Array<string> = [];
      yield* Effect.gen(function* () {
        yield* writeTask(task());
        yield* removeTask("task-1");
      }).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(TaskWrites, (tasks) => moved.push(...tasks)),
      );
      expect(moved).toEqual(["task-1", "task-1"]);
    }),
  ));

test("a Task written moves whatever follows the Tasks, as the board does", () =>
  runEffect(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const following = yield* Deferred.make<void>();
      const reads = yield* reactivity
        .stream([TASKS], Deferred.succeed(following, undefined).pipe(Effect.asVoid))
        .pipe(Stream.take(2), Stream.runCount, Effect.forkScoped);
      yield* Deferred.await(following);
      yield* writeTask(task());
      expect(yield* Fiber.join(reads).pipe(Effect.timeout("2 seconds"))).toBe(2);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a Task held is held until its holder is done, and only that Task", () =>
  runEffect(
    Effect.gen(function* () {
      const order: Array<string> = [];
      const holding = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const first = yield* withTaskLock(
        "task-1",
        Deferred.succeed(holding, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => order.push("first"))),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      const second = yield* withTaskLock(
        "task-1",
        Effect.sync(() => order.push("second")),
      ).pipe(Effect.forkScoped);
      yield* withTaskLock(
        "task-2",
        Effect.sync(() => order.push("other")),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["other", "first", "second"]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("run hold --task holds every unfinished Run of that Task and none of another's", () =>
  proves(
    "collie-tasks-hold-",
    (world) =>
      Effect.gen(function* () {
        const Started = Schema.Struct({ runId: Schema.String });
        const start = (...more: ReadonlyArray<string>) =>
          collie(world, ["run", "start", "asks", "--input", "goal=hold them", ...more]).pipe(
            Effect.flatMap(({ envelope }) => Schema.decodeUnknownEffect(Started)(envelope.data)),
            Effect.map(({ runId }) => runId),
            Effect.orDie,
          );
        const taskOf = (runId: string) =>
          collie(world, ["run", "show", runId]).pipe(
            Effect.flatMap(({ envelope }) =>
              Schema.decodeUnknownEffect(
                Schema.Struct({ run: Schema.Struct({ task: Schema.String }) }),
              )(envelope.data),
            ),
            Effect.map(({ run }) => run.task),
            Effect.orDie,
          );
        const first = yield* start();
        const task = yield* taskOf(first);
        const second = yield* start("--task", task);
        yield* start();

        const held = yield* collie(world, ["run", "hold", "--task", task]);
        yield* stopHost(world.state);
        expect(held.envelope).toMatchObject({ ok: true, data: { task } });
        expect(
          Arr.sort(
            (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ held: Schema.Array(Schema.String) }),
            )(held.envelope.data).pipe(Effect.orDie)).held,
            Order.String,
          ),
        ).toEqual(Arr.sort([first, second], Order.String));
      }),
    ["asks.workflow.ts"],
  ));

const Board = Schema.Struct({ tasks: Schema.Array(TaskView) });

const boardOf = (world: World) =>
  collie(world, ["board"]).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(Board)(envelope.data).pipe(Effect.orDie),
    ),
  );

const created = (world: World, instruction: string, more: ReadonlyArray<string> = []) =>
  collie(world, ["task", "create", "--instruction", instruction, ...more]).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(Schema.Struct({ task: Schema.String }))(envelope.data),
    ),
    Effect.map(({ task }) => task),
    Effect.orDie,
  );

const cardOf = (world: World, id: string) =>
  Effect.map(boardOf(world), (board) =>
    Option.getOrNull(Arr.findFirst(board.tasks, (one) => one.id === id)),
  );

test("a Task queued from one instruction is on the board after a restart, with no Run or pane action", () =>
  proves(
    "collie-task-queued-",
    (world) =>
      Effect.gen(function* () {
        const id = yield* created(world, "Make the refunds page say a duplicate arrives twice");
        yield* stopHost(world.state);
        const queued = yield* cardOf(world, id);
        expect(queued?.queued).toBe(true);
        expect(queued?.sentence).toBe("Make the refunds page say a duplicate arrives twice");
        expect(queued?.name).toBe("Make the refunds page say a duplicate arrives twice");
        expect(queued?.runs).toEqual([]);
        expect(queued?.agents).toEqual([]);
        expect(queued === null ? "missing" : sectionOf(queued)).toBe("queued");
        expect(
          queued === null ? ["missing"] : Arr.map(cardActions(queued), (one) => one.kind),
        ).toEqual([]);
      }),
    [],
  ));

test("two submissions of one create request are one queued Task", () =>
  proves(
    "collie-task-once-",
    (world) =>
      Effect.gen(function* () {
        yield* collie(world, ["board"]);
        const door = yield* frontDoor(socketOf(world.state));
        const asked = {
          actions: [{ kind: "create_task", instruction: "Tidy the refunds copy" }],
          request: "create-1",
        };
        const [first] = yield* door.act(asked);
        const [again] = yield* door.act(asked);
        expect(first?.state).toBe("applied");
        expect(first?.task).toBeString();
        expect(again?.task).toBe(first?.task);
        const listed = yield* collie(world, ["task", "list"]);
        const { tasks } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ tasks: Schema.Array(Schema.Struct({ id: Schema.String })) }),
        )(listed.envelope.data).pipe(Effect.orDie);
        expect(Arr.map(tasks, (one) => one.id)).toEqual([first!.task!]);
      }),
    [],
  ));

test("a queued Task takes one first Run on its chosen checkout, and its card leaves Queued", () =>
  proves(
    "collie-task-start-",
    (world) =>
      Effect.gen(function* () {
        const checkout = `${world.project}-chosen`;
        yield* Effect.sync(() => Bun.spawnSync(["git", "init", "-q", checkout]));
        const id = yield* created(world, "Ship the duplicate refunds notice");
        const door = yield* frontDoor(socketOf(world.state));
        const started = yield* door.start({
          project: checkout,
          id: "plain",
          request: "start-1",
          input: { note: "hi" },
          task: id,
        });
        yield* stopHost(world.state);
        yield* boardOf(world);
        const again = yield* (yield* frontDoor(socketOf(world.state))).start({
          project: checkout,
          id: "plain",
          request: "start-1",
          input: { note: "hi" },
          task: id,
        });
        expect(again.runId).toBe(started.runId);
        expect(again.fresh).toBe(false);
        const shown = yield* collie(world, ["run", "show", started.runId]);
        expect(shown.envelope.data).toMatchObject({
          run: { task: id, cwd: checkout },
        });
        const card = yield* cardOf(world, id);
        expect(card?.queued ?? false).toBe(false);
        expect(card?.run).toBe(started.runId);
      }),
    ["plain.workflow.ts"],
  ));

test("a queued Task older than any Run is kept by a sweep and still takes a first Run", () =>
  proves(
    "collie-task-aged-",
    (world) =>
      Effect.gen(function* () {
        yield* boardOf(world);
        yield* stopHost(world.state);
        const db = new Database(`${world.state}/host.db`);
        db.run(`INSERT INTO collie_tasks (id, record) VALUES (?, ?)`, [
          "task-aged",
          asJson({
            id: "task-aged",
            workspace: null,
            label: "Aged refund copy",
            cwd: world.project,
            created_at: "2020-01-01T00:00:00.000Z",
            instruction: "Aged refund copy",
            queued_at: "2020-01-01T00:00:00.000Z",
          }),
        ]);
        db.close();
        const swept = yield* collie(world, ["cleanup", "--apply"]);
        expect(swept.envelope.ok).toBe(true);
        expect((yield* cardOf(world, "task-aged"))?.queued).toBe(true);
        const started = yield* collie(world, [
          "run",
          "start",
          "plain",
          "--task",
          "task-aged",
          "--input",
          "note=hi",
        ]);
        expect(started.envelope.ok).toBe(true);
      }),
    ["plain.workflow.ts"],
  ));

test("a pre-feature database still opens its Run, keeps its Tasks and acts on the same installation", () =>
  proves(
    "collie-task-upgrade-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
        const { runId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ runId: Schema.String }),
        )(started.envelope.data).pipe(Effect.orDie);
        yield* collie(world, ["run", "wait", runId]);
        const task = yield* collie(world, ["run", "show", runId]).pipe(
          Effect.flatMap(({ envelope }) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ run: Schema.Struct({ task: Schema.String }) }),
            )(envelope.data),
          ),
          Effect.map(({ run }) => run.task),
          Effect.orDie,
        );
        const cardsBefore = (yield* boardOf(world)).tasks.length;
        yield* stopHost(world.state);
        const db = new Database(`${world.state}/host.db`);
        // WARNING: what a host before queued Tasks left: no instruction, no queued_at, and Runs that name no Task.
        db.run(`UPDATE collie_tasks SET record = ? WHERE id = ?`, [
          asJson({
            id: task,
            workspace: null,
            label: "Plain | Older record",
            cwd: world.project,
            created_at: "2026-01-01T00:00:00.000Z",
            closed_at: "2026-01-02T00:00:00.000Z",
          }),
          task,
        ]);
        db.run(`UPDATE collie_runs SET task = NULL WHERE run = ?`, [runId]);
        const cleared = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ task: Schema.NullOr(Schema.String) }),
        )(db.query(`SELECT task FROM collie_runs WHERE run = ?`).get(runId)).pipe(Effect.orDie);
        db.close();
        expect(cleared.task).toBeNull();
        // WARNING: the last host's cards stand until the first pass confirms the record it now sees.
        const board = yield* until(
          () => boardOf(world),
          (read) => Arr.some(read.tasks, (one) => one.id === runId),
        );
        expect(cardsBefore).toBeGreaterThan(0);
        expect(Arr.map(board.tasks, (one) => one.id)).toContain(runId);
        expect(Arr.some(board.tasks, (one) => one.queued === true)).toBe(false);
        const shown = yield* collie(world, ["run", "show", runId]);
        expect(shown.envelope).toMatchObject({ ok: true });
        const acted = yield* collie(world, ["run", "disposition", runId, "--as", "abandoned"]);
        expect(acted.envelope).toMatchObject({ ok: true });
      }),
    ["plain.workflow.ts"],
  ));
