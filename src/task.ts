// A Task: the work a human is doing, and the herdr workspace it is done in. A Run is
// one execution of a Workflow; a Task is what several of them — a plan, the
// implementation it chained into, the review of that — are all about.
//
// Membership is recorded here and carried on each Run's record, never inferred from a
// label: two Tasks may share a project prefix, a workspace may be renamed by hand, and
// neither says anything about whose work a Run is.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Context, Effect, Layer, Schema, Semaphore, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { KeptHere } from "./board-model";
import { TaskWrites } from "./store-writes";
import { nowIso } from "./time";

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  /** The herdr workspace this Task's Runs and agents live in; null on core, which has none. */
  workspace: Schema.NullOr(Schema.String),
  /**
   * What the workspace was called when it was made. A display label and nothing more:
   * it is never read to decide which Task something belongs to, and a human who renames
   * the workspace has not moved the Task.
   */
  label: Schema.String,
  /** Where the Task's first Run was rooted, which is what a picker shows beside it. */
  cwd: Schema.String,
  /**
   * The shell pane the workspace was made with, until the Task's first agent takes it
   * over rather than leaving it an empty first tab. Null once taken, or where Collie did
   * not make the workspace.
   */
  root_pane: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The Herd its workspace is in. Absent from a record older than the field. */
  herd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.String,
  /** When Cleanup closed a Task with no workspace, as it closes a workspace. */
  closed_at: Schema.optionalKey(Schema.String),
});
export type TaskRecord = Schema.Schema.Type<typeof TaskSchema>;

const TaskJson = Schema.fromJsonString(TaskSchema);
const encodeTask = flow(Schema.encodeResult(TaskJson), Result.getOrThrow);
export const decodeTaskOption = Schema.decodeOption(TaskJson);

/**
 * Which Task a start belongs to: a new one with a workspace of its own, one the caller
 * named, or the workspace the caller is in — its Task, or a new one kept there rather than
 * given a workspace of its own.
 */
export type TaskChoice =
  | { readonly mode: "new" }
  | { readonly mode: "continue"; readonly task: TaskRecord }
  | { readonly mode: "here" };

/** The Tasks, in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database). */
export interface TasksApi {
  readonly get: (id: string) => Effect.Effect<TaskRecord | null>;
  /** Newest first. */
  readonly list: Effect.Effect<ReadonlyArray<TaskRecord>>;
  readonly ofWorkspace: (workspace: string) => Effect.Effect<TaskRecord | null>;
  readonly put: (task: TaskRecord) => Effect.Effect<TaskRecord>;
  readonly remove: (id: string) => Effect.Effect<void>;
  /** Held from reading a Task to writing it back, so two Runs cannot both replace its workspace. */
  readonly locked: <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** `locked`, or nothing where another holds it now. */
  readonly lockedIfFree: <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
}

export class Tasks extends Context.Service<Tasks, TasksApi>()("collie/Tasks") {}

/** What a write to the Tasks invalidates. */
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

/** The Task by that id, or null. */
export const readTask = (id: string) => Tasks.use((tasks) => tasks.get(id));

export const listTasks = Tasks.use((tasks) => tasks.list);

/** Whether a Task is open: its workspace is, or, having none, Cleanup has not closed it. */
export const isOpen = (task: TaskRecord, workspaces: ReadonlySet<string>) =>
  task.workspace === null ? task.closed_at === undefined : workspaces.has(task.workspace);

/** The Task whose workspace this is, which is what "the current Task" means. */
export const taskOfWorkspace = (workspaceId: string | null) =>
  workspaceId ? Tasks.use((tasks) => tasks.ofWorkspace(workspaceId)) : Effect.succeed(null);

export const writeTask = (task: TaskRecord) => Tasks.use((tasks) => tasks.put(task));

/** Forgets the Task; its Runs' records are the store's and are left alone. */
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

/** The Task kept in that workspace, or a new one kept there. */
export const taskKeptIn = (here: KeptHere) =>
  withTaskLock(
    `workspace:${here.workspace}`,
    Effect.gen(function* () {
      const kept = yield* taskOfWorkspace(here.workspace);
      if (kept !== null) return kept;
      return yield* writeTask(
        yield* newTask({
          workspace: here.workspace,
          label: here.label,
          cwd: here.cwd,
          herd: here.herd,
        }),
      );
    }),
  );
