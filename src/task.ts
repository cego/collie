import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Context, Effect, Layer, Schema, Semaphore, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { TaskWrites } from "./store-writes";
import { nowIso } from "./time";

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  workspace: Schema.NullOr(Schema.String),
  label: Schema.String,
  cwd: Schema.String,
  root_pane: Schema.optionalKey(Schema.NullOr(Schema.String)),
  herd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  closed_at: Schema.optionalKey(Schema.String),
});
export type TaskRecord = Schema.Schema.Type<typeof TaskSchema>;

const TaskJson = Schema.fromJsonString(TaskSchema);
const encodeTask = flow(Schema.encodeResult(TaskJson), Result.getOrThrow);
export const decodeTaskOption = Schema.decodeOption(TaskJson);

export type TaskChoice =
  | { readonly mode: "new" }
  | { readonly mode: "continue"; readonly task: TaskRecord };

export interface TasksApi {
  readonly get: (id: string) => Effect.Effect<TaskRecord | null>;
  readonly list: Effect.Effect<ReadonlyArray<TaskRecord>>;
  readonly ofWorkspace: (workspace: string) => Effect.Effect<TaskRecord | null>;
  readonly put: (task: TaskRecord) => Effect.Effect<TaskRecord>;
  readonly remove: (id: string) => Effect.Effect<void>;
  readonly locked: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly lockedIfFree: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

export class Tasks extends Context.Service<Tasks, TasksApi>()("collie/Tasks") {}

export const TASKS = "collie/tasks";

const decoded = (rows: ReadonlyArray<{ readonly record: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeTaskOption(row.record)));

export const tasksLayer = Layer.effect(Tasks)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(TaskWrites));
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (id: string) => {
      const lock = locks.get(id) ?? Semaphore.makeUnsafe(1);
      locks.set(id, lock);
      return lock;
    };
    const changed = (id: string) =>
      Effect.andThen(
        Effect.sync(() => told?.([id])),
        reactivity.invalidate([TASKS]),
      );
    return {
      get: (id) =>
        sql<{ readonly record: string }>`SELECT record FROM collie_tasks WHERE id = ${id}`.pipe(
          Effect.map((rows) => decoded(rows)[0] ?? null),
          Effect.orDie,
        ),
      list: sql<{ readonly record: string }>`
        SELECT record FROM collie_tasks ORDER BY created_at DESC
      `.pipe(Effect.map(decoded), Effect.orDie),
      ofWorkspace: (workspace) =>
        sql<{ readonly record: string }>`
          SELECT record FROM collie_tasks WHERE workspace = ${workspace} ORDER BY created_at DESC
        `.pipe(
          Effect.map((rows) => decoded(rows)[0] ?? null),
          Effect.orDie,
        ),
      put: (task) =>
        sql`
          INSERT INTO collie_tasks (id, record) VALUES (${task.id}, ${encodeTask(task)})
          ON CONFLICT (id) DO UPDATE SET record = excluded.record
        `.pipe(Effect.andThen(changed(task.id)), Effect.as(task), Effect.orDie),
      remove: (id) =>
        sql`DELETE FROM collie_tasks WHERE id = ${id}`.pipe(
          Effect.andThen(changed(id)),
          Effect.orDie,
        ),
      locked: (id, effect) => Effect.suspend(() => lockOf(id).withPermits(1)(effect)),
      lockedIfFree: (id, effect) =>
        Effect.suspend(() => lockOf(id).withPermitsIfAvailable(1)(effect)),
    } satisfies TasksApi;
  }),
);

export const readTask = (id: string) => Tasks.use((tasks) => tasks.get(id));

export const listTasks = Tasks.use((tasks) => tasks.list);

export const isOpen = (task: TaskRecord) => task.workspace === null && task.closed_at === undefined;

export const taskOfWorkspace = (workspaceId: string | null) =>
  workspaceId ? Tasks.use((tasks) => tasks.ofWorkspace(workspaceId)) : Effect.succeed(null);

export const writeTask = (task: TaskRecord) => Tasks.use((tasks) => tasks.put(task));

export const removeTask = (id: string) => Tasks.use((tasks) => tasks.remove(id));

export const withTaskLock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Tasks.use((tasks) => tasks.locked(id, effect));

export const withTaskLockIfFree = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
  Tasks.use((tasks) => tasks.lockedIfFree(id, effect));

export const newTask = Effect.fn("task.newTask")(function* (opts: {
  readonly workspace: string | null;
  readonly label: string;
  readonly cwd: string;
  readonly rootPane?: string | null;
  readonly herd: string | null;
}) {
  return {
    id: `task-${pipe_(yield* (yield* SecureRandom.SecureRandom).uuidV4(), Str.slice(0, 8))}`,
    workspace: opts.workspace,
    label: opts.label,
    cwd: opts.cwd,
    root_pane: opts.rootPane ?? null,
    herd: opts.herd,
    created_at: yield* nowIso,
  } satisfies TaskRecord;
});
