// WARNING: membership is recorded, never inferred from a label: two Tasks may share a project prefix.
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Context, Effect, Layer, Schema, Semaphore, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { TaskWrites } from "./store-writes";
import type { ProjectRef } from "./project";
import { ProjectRef as ProjectRefSchema } from "./project";
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
  // WARNING: what the operator asked for before any Run existed, kept as they wrote it.
  instruction: Schema.optionalKey(Schema.String),
  // WARNING: a queued Task has no Run; this is what tells it from one whose Runs are all gone.
  queued_at: Schema.optionalKey(Schema.String),
  // WARNING: absent means unassigned, and older records are all unassigned.
  project: Schema.optionalKey(Schema.NullOr(ProjectRefSchema)),
  // WARNING: bumped by every filing or move, so a stale one is refused rather than applied.
  membership_seq: Schema.optionalKey(Schema.Finite),
  followed_at: Schema.optionalKey(Schema.String),
  followed_by: Schema.optionalKey(Schema.String),
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
  // WARNING: held from reading a Task to writing it back, so two Runs cannot both replace its workspace.
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

export const isQueued = (task: TaskRecord) => task.queued_at !== undefined;
export const isFollowing = (task: TaskRecord) => task.followed_at !== undefined;
export const membershipOf = (task: TaskRecord) => ({
  project: task.project ?? null,
  seq: task.membership_seq ?? 0,
});
export interface Membership {
  readonly project: ProjectRef | null;
  readonly seq: number;
}
export const FilingSchema = Schema.Struct({
  task: Schema.String,
  result: Schema.Literals(["filed", "already", "stale", "archived", "missing", "unavailable"]),
  // WARNING: what the entry left behind, or what it found instead when it was stale.
  membership: Schema.Struct({ project: Schema.NullOr(ProjectRefSchema), seq: Schema.Finite }),
});
export type Filing = typeof FilingSchema.Type;
export const sameProject = (a: ProjectRef | null, b: ProjectRef | null) =>
  a === null ? b === null : b !== null && a.installation === b.installation && a.id === b.id;
// WARNING: an expected seq is the operator's view of the membership; a move that names another loses to the one that won.
export const fileTask = (opts: {
  readonly id: string;
  readonly project: ProjectRef | null;
  readonly expected?: number | undefined;
}) =>
  Tasks.use((tasks) =>
    tasks.locked(
      opts.id,
      Effect.gen(function* () {
        const task = yield* tasks.get(opts.id);
        if (task === null) {
          return {
            task: opts.id,
            result: "missing",
            membership: { project: null, seq: 0 },
          } satisfies Filing;
        }
        const current = membershipOf(task);
        if (opts.expected !== undefined && opts.expected !== current.seq) {
          return { task: opts.id, result: "stale", membership: current } satisfies Filing;
        }
        if (sameProject(current.project, opts.project)) {
          return { task: opts.id, result: "already", membership: current } satisfies Filing;
        }
        const next = {
          ...task,
          project: opts.project,
          membership_seq: current.seq + 1,
        } satisfies TaskRecord;
        yield* tasks.put(next);
        return { task: opts.id, result: "filed", membership: membershipOf(next) } satisfies Filing;
      }),
    ),
  );
export const followTask = (id: string, by: string) =>
  Tasks.use((tasks) =>
    tasks.locked(
      id,
      Effect.gen(function* () {
        const task = yield* tasks.get(id);
        return task === null
          ? null
          : yield* tasks.put({ ...task, followed_at: yield* nowIso, followed_by: by });
      }),
    ),
  );
export const unfollowTask = (id: string) =>
  Tasks.use((tasks) =>
    tasks.locked(
      id,
      Effect.gen(function* () {
        const task = yield* tasks.get(id);
        if (task === null) {
          return null;
        }
        // WARNING: the key goes, not to undefined: a Task's JSON refuses undefined where a string is optional.
        const next = { ...task };
        delete next.followed_at;
        delete next.followed_by;
        return yield* tasks.put(next);
      }),
    ),
  );

export const queuedLabel = (instruction: string) =>
  pipe_(Str.split(Str.trim(instruction), "\n")[0] ?? "", Str.slice(0, 72));

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

export const newQueuedTask = Effect.fn("task.newQueuedTask")(function* (opts: {
  readonly instruction: string;
  readonly label?: string | undefined;
  readonly cwd: string;
  readonly herd?: string | null;
}) {
  const now = yield* nowIso;
  return {
    id: `task-${pipe_(yield* (yield* SecureRandom.SecureRandom).uuidV4(), Str.slice(0, 8))}`,
    workspace: null,
    label: opts.label ?? queuedLabel(opts.instruction),
    cwd: opts.cwd,
    root_pane: null,
    herd: opts.herd ?? null,
    created_at: now,
    instruction: opts.instruction,
    queued_at: now,
  } satisfies TaskRecord;
});
