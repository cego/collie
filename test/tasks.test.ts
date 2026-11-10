// A Task's record, kept in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database).

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Result, Schema, Stream } from "effect";
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
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { TaskWrites } from "../src/store-writes";
import { runEffect } from "./support/effect";
import { hostRecords, recordsAt } from "./support/records";
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
  "starts kept here from one workspace are one Task, which the host makes and keeps there",
  () =>
    proves(
      "collie-tasks-here-",
      (world) =>
        Effect.gen(function* () {
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "project | Kept here" })
            .pipe(Effect.orDie);
          const taskOf = Effect.gen(function* () {
            const started = yield* collie(
              world,
              ["run", "start", "plain", "--here", "--input", "note=hi"],
              { HERDR_WORKSPACE_ID: workspace.workspaceId },
            );
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data);
            const shown = yield* collie(world, ["run", "show", runId]);
            return (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ run: Schema.Struct({ task: Schema.NullOr(Schema.String) }) }),
            )(shown.envelope.data)).run.task;
          }).pipe(Effect.orDie);
          const first = yield* taskOf;
          const second = yield* taskOf;
          const kept = yield* hostRecords(world.state, listTasks).pipe(Effect.orDie);
          yield* stopHost(world.state);
          expect(kept).toMatchObject([{ workspace: workspace.workspaceId, cwd: world.project }]);
          expect([first, second]).toEqual([kept[0]!.id, kept[0]!.id]);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
