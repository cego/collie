// A Task: the work a human is doing, and the herdr workspace it is done in. A Run is
// one execution of a Workflow; a Task is what several of them — a plan, the
// implementation it chained into, the review of that — are all about.
//
// Membership is recorded here and carried on each Run's record, never inferred from a
// label: two Tasks may share a project prefix, a workspace may be renamed by hand, and
// neither says anything about whose work a Run is.

import { Crypto, Data, Effect, FileSystem, Path, Schema } from "effect";
import { ensureLockDir, withLock } from "./lock";
import { nowIso } from "./time";
import { unsafePathComponent } from "./naming";

const TaskSchema = Schema.Struct({
  id: Schema.String,
  /** The herdr workspace this Task's Runs and agents live in. */
  workspace: Schema.String,
  /**
   * What the workspace was called when it was made. A display label and nothing more:
   * it is never read to decide which Task something belongs to, and a human who renames
   * the workspace has not moved the Task.
   */
  label: Schema.String,
  /** Where the Task's first Run was rooted, which is what a picker shows beside it. */
  cwd: Schema.String,
  created_at: Schema.String,
});
export type TaskRecord = Schema.Schema.Type<typeof TaskSchema>;

const TaskJson = Schema.fromJsonString(TaskSchema);
const encodeTask = Schema.encodeSync(TaskJson);
const decodeTask = Schema.decodeUnknownEffect(TaskJson);

/**
 * Which Task a start belongs to: a new one with a workspace of its own, one the caller
 * named, or the workspace the caller is in — its Task, or a new one kept there rather than
 * given a workspace of its own.
 */
export type TaskChoice =
  | { readonly mode: "new" }
  | { readonly mode: "continue"; readonly task: TaskRecord }
  | { readonly mode: "here" };

const tasksDir = Effect.fn("task.tasksDir")(function* (stateDir: string) {
  return (yield* Path.Path).join(stateDir, "tasks");
});

const taskFile = Effect.fn("task.taskFile")(function* (stateDir: string, id: string) {
  return (yield* Path.Path).join(yield* tasksDir(stateDir), `${id}.json`);
});

/**
 * The Task by that id, or null. Ids reach here from a command line, so the same guard
 * the Run store applies to a Run id applies here: a `../` id must not read a file
 * outside the state directory.
 */
export const readTask = Effect.fn("task.readTask")(function* (stateDir: string, id: string) {
  const fs = yield* FileSystem.FileSystem;
  if (unsafePathComponent(id)) return null;
  const file = yield* taskFile(stateDir, id);
  if (!(yield* fs.exists(file))) return null;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeTask),
    Effect.catch(() => Effect.succeed(null)),
  );
});

export const listTasks = Effect.fn("task.listTasks")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* tasksDir(stateDir);
  if (!(yield* fs.exists(dir))) return [];
  const tasks: TaskRecord[] = [];
  for (const name of yield* fs.readDirectory(dir)) {
    if (!name.endsWith(".json")) continue;
    const task = yield* fs.readFileString(path.join(dir, name)).pipe(
      Effect.flatMap(decodeTask),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (task) tasks.push(task);
  }
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
});

/** The Task whose workspace this is, which is what "the current Task" means. */
export const taskOfWorkspace = Effect.fn("task.taskOfWorkspace")(function* (
  stateDir: string,
  workspaceId: string | null,
) {
  if (!workspaceId) return null;
  return (yield* listTasks(stateDir)).find((task) => task.workspace === workspaceId) ?? null;
});

export const writeTask = Effect.fn("task.writeTask")(function* (
  stateDir: string,
  task: TaskRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(yield* tasksDir(stateDir), { recursive: true });
  yield* fs.writeFileString(yield* taskFile(stateDir, task.id), `${encodeTask(task)}\n`);
  return task;
});

export class TaskBusy extends Data.TaggedError("TaskBusy")<{ id: string }> {}

/** Ten seconds: long enough for another Run of the Task to reopen its workspace. */
const TASK_LOCK_CLAIMS = 400;

/** Held from reading a Task to writing it back, so two Runs cannot both replace its workspace. */
export const withTaskLock = <A, E, R>(
  stateDir: string,
  id: string,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const file = yield* taskFile(stateDir, id);
    yield* ensureLockDir(file);
    return yield* withLock(`${file}.lock`, new TaskBusy({ id }), effect, TASK_LOCK_CLAIMS);
  });

export const newTask = Effect.fn("task.newTask")(function* (opts: {
  readonly workspace: string;
  readonly label: string;
  readonly cwd: string;
}) {
  return {
    id: `task-${(yield* (yield* Crypto.Crypto).randomUUIDv4).slice(0, 8)}`,
    workspace: opts.workspace,
    label: opts.label,
    cwd: opts.cwd,
    created_at: yield* nowIso(),
  } satisfies TaskRecord;
});
