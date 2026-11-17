// A Task's record, kept in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database).

import * as Arr from "effect/Array";
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
  type TaskRecord,
} from "../src/task";
import { TaskWrites } from "../src/store-writes";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

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

const task = (over: Partial<TaskRecord> = {}): TaskRecord => ({
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
      const moved: string[] = [];
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
      const order: string[] = [];
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

test(
  "run hold --task holds every unfinished Run of that Task and none of another's",
  () =>
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
    ),
  120_000,
);
