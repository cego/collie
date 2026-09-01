import { Data, Schema, Clock, Effect, FileSystem, Path, Schedule } from "effect";
import { nowIso } from "./time";
import {
  breakStaleLock,
  holdsLock,
  LOCK_CLAIM_RETRIES,
  LOCK_CLAIM_RETRY_INTERVAL,
  releaseOwnLock,
  tryClaimLock,
} from "./lock";
import { unsafePathComponent } from "./naming";
import { FindingSchema, type Finding } from "./output";
import { slugify } from "./template";

export type StepStatus = "pending" | "running" | "done" | "blocked" | "failed";
export type RunStatus = "running" | "done" | "blocked" | "failed";
export interface VariantRecord {
  harness: string;
  model: string;
  effort: string | null;
  agent: string;
  label: string;
  tabId: string | null;
  paneId: string | null;
  status: StepStatus;
  output: string | null;
  error: string | null;
}
export interface HandoffRecord {
  id?: string;
  direction: "sent" | "received";
  role: string;
  agent: string;
  run: string;
  at: string;
  note: string;
}
export interface ChoiceRecord {
  step: string;
  title: string;
  at: string;
}
export interface StepRecord {
  id: string;
  status: StepStatus;
  iteration: number;
  note: string | null;
  variants: VariantRecord[];
}
export interface RunRecord {
  id: string;
  seq: number;
  slug: string;
  workflow: string;
  cwd: string;
  session: string | null;
  workspace: string | null;
  workspace_label: string | null;
  workspace_worktree: string | null;
  created_at: string;
  finished_at: string | null;
  status: RunStatus;
  iteration: number;
  max_iterations: number;
  inputs: Record<string, string>;
  input_sources: Record<string, string>;
  steps: StepRecord[];
  parent: string | null;
  children: string[];
  choices: ChoiceRecord[];
  awaiting: string | null;
  handoffs: HandoffRecord[];
  disputed: Finding[];
  deferred: Finding[];
  outstanding: Finding[];
  target_label: string | null;
  synthesis: string | null;
  mr_url: string | null;
  linear_issues: string[];
  summary: string | null;
}

/** A collection a Run may predate: absent reads as empty, so old is not corrupt. */
function optionalList<S extends Schema.Top>(item: S) {
  return Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])));
}

const StepStatusSchema = Schema.Literals(["pending", "running", "done", "blocked", "failed"]);

/**
 * The persisted Run, and the only place `run.json` is given a shape. Every reader —
 * the CLI, the Control Plane, the Driver, the engine — loads Runs through RunStore,
 * so a malformed Run fails where it is read rather than being trusted by whoever
 * reads it first and re-checked by whoever cares most.
 *
 * The Run is mutated in place while it runs, so `RunRecord` above stays the written
 * type and this schema is what decides whether a file may become one.
 */
const RunSchema = Schema.Struct({
  id: Schema.String,
  seq: Schema.Number,
  slug: Schema.String,
  workflow: Schema.String,
  cwd: Schema.String,
  session: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  workspace_label: Schema.NullOr(Schema.String),
  workspace_worktree: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  finished_at: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "done", "blocked", "failed"]),
  iteration: Schema.Number,
  max_iterations: Schema.Number,
  inputs: Schema.Record(Schema.String, Schema.String),
  input_sources: Schema.Record(Schema.String, Schema.String),
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: StepStatusSchema,
      iteration: Schema.Number,
      note: Schema.NullOr(Schema.String),
      variants: optionalList(
        Schema.Struct({
          harness: Schema.String,
          model: Schema.String,
          effort: Schema.NullOr(Schema.String),
          agent: Schema.String,
          label: Schema.String,
          tabId: Schema.NullOr(Schema.String),
          paneId: Schema.NullOr(Schema.String),
          status: StepStatusSchema,
          output: Schema.NullOr(Schema.String),
          error: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  ),
  parent: Schema.NullOr(Schema.String),
  children: optionalList(Schema.String),
  choices: optionalList(
    Schema.Struct({ step: Schema.String, title: Schema.String, at: Schema.String }),
  ),
  awaiting: Schema.NullOr(Schema.String),
  handoffs: optionalList(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      direction: Schema.Literals(["sent", "received"]),
      role: Schema.String,
      agent: Schema.String,
      run: Schema.String,
      at: Schema.String,
      note: Schema.String,
    }),
  ),
  disputed: optionalList(FindingSchema),
  deferred: optionalList(FindingSchema),
  outstanding: optionalList(FindingSchema),
  target_label: Schema.NullOr(Schema.String),
  synthesis: Schema.NullOr(Schema.String),
  mr_url: Schema.NullOr(Schema.String),
  linear_issues: optionalList(Schema.String),
  summary: Schema.NullOr(Schema.String),
});

type Decoded = Schema.Schema.Type<typeof RunSchema>;

// A field added to one side and not the other leaves the other side's Exclude
// non-empty, and only a pair of `never`s is assignable to `true` — so the build fails
// here rather than at the next Run that happens to carry that field.
type Unschemad = Exclude<keyof RunRecord, keyof Decoded>;
type Unrecorded = Exclude<keyof Decoded, keyof RunRecord>;
const fieldsAgree: [Unschemad, Unrecorded] extends [never, never] ? true : never = true;
void fieldsAgree;

/** The decoded shape with `readonly` taken off, all the way down. */
type Mutable<T> =
  T extends ReadonlyArray<infer E>
    ? Array<Mutable<E>>
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;

// Names agreeing is not enough, and neither is `RunRecord extends Decoded`: that also
// holds when a schema field is *wider* than the interface's, which would hand the
// engine a value the schema never constrained. This is the direction the assertion
// below actually needs, and `readonly` is the only thing it forgives.
const typesAgree: Mutable<Decoded> extends RunRecord ? true : never = true;
void typesAgree;

const RunRecordJson = Schema.fromJsonString(RunSchema);
const encodeRecord = Schema.encodeSync(RunRecordJson);

/** A `run.json` that exists but is not a Run. Readers report it; they never guess. */
export class InvalidRunState extends Data.TaggedError("InvalidRunState")<{
  run: string;
  cause: string;
}> {}

/**
 * Decodes one `run.json`. The result is the schema's own readonly view of a record
 * the engine goes on to mutate, which is the only reason for the assertion.
 */
const decodeRecord = Effect.fn("RunStore.decodeRecord")(function* (id: string, raw: string) {
  const decoded = yield* Schema.decodeUnknownEffect(RunRecordJson)(raw).pipe(
    Effect.mapError((cause) => new InvalidRunState({ run: id, cause: String(cause) })),
  );
  // SAFETY: RunSchema has just accepted `raw`; `fieldsAgree` holds the two shapes to
  // the same field names, and `typesAgree` holds the decoded type — with `readonly`
  // stripped — assignable to RunRecord, so no schema field may be wider than the
  // interface's. The assertion therefore drops `readonly` and nothing else, which the
  // engine needs because it mutates the record in place while the Run runs.
  return decoded as RunRecord;
});

const RUN_FILE = "run.json";
const pid = Effect.sync(() => globalThis.process.pid);

export class Run {
  constructor(
    readonly dir: string,
    readonly record: RunRecord,
  ) {}
  get id(): string {
    return this.record.id;
  }

  save() {
    return saveRun(this);
  }
  stepDir(stepId: string, variantKey: string | null) {
    return stepDirRun(this, stepId, variantKey);
  }
  outputPath(stepId: string, variantKey: string | null, filename: string) {
    return outputPathRun(this, stepId, variantKey, filename);
  }
  personaPath(persona: string, harness: string) {
    return personaPathRun(this, persona, harness);
  }
  log(line: string) {
    return logRun(this, line);
  }

  step(id: string): StepRecord {
    const found = this.record.steps.find((s) => s.id === id);
    if (!found) throw new Error(`run ${this.record.id} has no step "${id}"`);
    return found;
  }

  component(value: string): string {
    if (unsafePathComponent(value) !== null)
      throw new Error(
        `run ${this.record.id}: "${value}" cannot name a file or directory inside the run`,
      );
    return value;
  }

  unfinished(): StepRecord[] {
    return this.record.steps.filter((s) => s.status !== "done");
  }
}

const mergeHandoffs = Effect.fn("Run.mergeHandoffs")(function* (run: Run) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const disk = yield* fs.readFileString(path.join(run.dir, RUN_FILE)).pipe(
    Effect.flatMap((raw) => decodeRecord(run.record.id, raw)),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (!disk) return;
  const have = new Set(run.record.handoffs.map(handoffKey));
  for (const handoff of disk.handoffs ?? []) {
    const key = handoffKey(handoff);
    if (!have.has(key)) {
      have.add(key);
      run.record.handoffs.push(handoff);
    }
  }
});

const saveRun = Effect.fn("Run.save")(function* (run: Run) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(run.dir, { recursive: true });
  yield* withRunLock(
    run.dir,
    Effect.gen(function* () {
      yield* mergeHandoffs(run);
      yield* writeRecord(run.dir, run.record);
    }),
  );
});

const stepDirRun = Effect.fn("Run.stepDir")(function* (
  run: Run,
  stepId: string,
  variantKey: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = variantKey
    ? path.join(run.dir, "steps", run.component(stepId), run.component(variantKey))
    : path.join(run.dir, "steps", run.component(stepId));
  yield* fs.makeDirectory(dir, { recursive: true });
  return dir;
});

const outputPathRun = Effect.fn("Run.outputPath")(function* (
  run: Run,
  stepId: string,
  variantKey: string | null,
  filename: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* stepDirRun(run, stepId, variantKey), run.component(filename));
});

const personaPathRun = Effect.fn("Run.personaPath")(function* (
  run: Run,
  persona: string,
  harness: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(run.dir, "personas");
  yield* fs.makeDirectory(dir, { recursive: true });
  return path.join(dir, run.component(`${persona}.${harness}.md`));
});

const logRun = Effect.fn("Run.log")(function* (run: Run, line: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(run.dir, { recursive: true });
  const at = yield* nowIso();
  yield* fs.writeFileString(path.join(run.dir, "log.txt"), `${at} ${line}\n`, { flag: "a" });
});

export function handoffKey(h: HandoffRecord): string {
  return h.id ? `${h.direction}|${h.id}` : [h.direction, h.role, h.run, h.at, h.note].join("|");
}

const writeRecord = Effect.fn("writeRecord")(function* (dir: string, record: RunRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const me = yield* pid;
  const tmp = path.join(dir, `${RUN_FILE}.tmp-${me}`);
  yield* fs.writeFileString(tmp, `${encodeRecord(record)}\n`);
  yield* fs.rename(tmp, path.join(dir, RUN_FILE));
});

function withRunLock<A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(dir, `${RUN_FILE}.lock`);
    const start = yield* Clock.currentTimeMillis;
    let held = false;
    while (!held && (yield* Clock.currentTimeMillis) < start + 15_000) {
      held = (yield* tryClaimLock(lock)) && (yield* holdsLock(lock));
      if (!held && !(yield* breakStaleLock(lock))) yield* Effect.sleep("5 millis");
    }
    if (!held)
      return yield* Effect.fail(new Error(`${lock} could not be acquired; not writing unlocked`));
    return yield* effect.pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
  });
}

export class RunStore {
  constructor(private readonly stateDir: string) {}
  get rootEffect() {
    const stateDir = this.stateDir;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.join(stateDir, "runs");
    });
  }
  create(opts: Parameters<typeof createRun>[1]) {
    return createRun(this, opts);
  }
  appendHandoff(runId: string, handoff: HandoffRecord) {
    return appendHandoffRun(this, runId, handoff);
  }
  load(id: string) {
    return loadRun(this, id);
  }
  list() {
    return listRuns(this);
  }
  resumable() {
    return resumableRuns(this);
  }
  nextSeq() {
    return nextSeqRun(this);
  }
}

const createRun = Effect.fn("RunStore.create")(function* (
  store: RunStore,
  opts: {
    workflow: string;
    cwd: string;
    inputs: Record<string, string>;
    inputSources: Record<string, string>;
    stepIds: string[];
    maxIterations: number;
    primaryInput: string;
    parent?: string;
    session?: string | null;
    workspace?: string | null;
    workspaceLabel?: string | null;
    workspaceWorktree?: string | null;
  },
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* store.rootEffect;
  const badWorkflow = unsafePathComponent(opts.workflow);
  if (badWorkflow)
    return yield* Effect.fail(
      new Error(
        `workflow name "${opts.workflow}" ${badWorkflow}, so it cannot name a Run directory`,
      ),
    );
  const slug = `${opts.workflow}-${slugify(opts.primaryInput)}`;
  const stamp = (yield* nowIso()).replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  yield* fs.makeDirectory(root, { recursive: true });
  // The mkdir is the claim, not a preceding existence check: two starts in the same
  // second for the same workflow and primary input would both find the directory
  // absent, pick the same id, and then overwrite each other's run.json while each
  // spawned a Driver. A non-recursive mkdir fails if the name is taken, so only one
  // of them can own it.
  const claim = (candidate: string) =>
    fs.makeDirectory(path.join(root, candidate)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
  let id = `${slug}-${stamp}`;
  for (let n = 2; !(yield* claim(id)); n++) {
    if (n > 99)
      return yield* Effect.fail(
        new Error(`could not claim a Run directory for "${slug}" in ${root}`),
      );
    id = `${slug}-${stamp}-${n}`;
  }
  const record: RunRecord = {
    id,
    seq: yield* store.nextSeq(),
    slug,
    workflow: opts.workflow,
    cwd: opts.cwd,
    session: opts.session ?? null,
    workspace: opts.workspace ?? null,
    workspace_label: opts.workspaceLabel ?? null,
    workspace_worktree: opts.workspaceWorktree ?? null,
    created_at: yield* nowIso(),
    finished_at: null,
    status: "running",
    iteration: 1,
    max_iterations: opts.maxIterations,
    inputs: opts.inputs,
    input_sources: opts.inputSources,
    steps: opts.stepIds.map((id) => ({
      id,
      status: "pending",
      iteration: 0,
      note: null,
      variants: [],
    })),
    parent: opts.parent ?? null,
    children: [],
    choices: [],
    awaiting: null,
    handoffs: [],
    disputed: [],
    deferred: [],
    outstanding: [],
    target_label: null,
    synthesis: null,
    mr_url: null,
    linear_issues: [],
    summary: null,
  };
  const run = new Run(path.join(root, id), record);
  yield* run.save();
  return run;
});

/**
 * The next Run's sequence number. It is what makes agent names unique across Runs,
 * and herdr refuses a duplicate name outright, so read-increment-write is held under
 * the same pid lock the Run record uses rather than raced.
 */
const nextSeqRun = Effect.fn("RunStore.nextSeq")(function* (store: RunStore) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* store.rootEffect;
  yield* fs.makeDirectory(root, { recursive: true });
  const seqPath = path.join(root, ".seq");
  const lock = `${seqPath}.lock`;
  const claim = Effect.gen(function* () {
    if (yield* tryClaimLock(lock)) return;
    if ((yield* breakStaleLock(lock)) && (yield* tryClaimLock(lock))) return;
    return yield* Effect.fail(new Error(`could not claim the Run sequence lock ${lock}`));
  });
  // Contention here is momentary — another start incrementing the same counter — so
  // it is worth waiting out rather than failing the start.
  yield* claim.pipe(
    Effect.retry({
      times: LOCK_CLAIM_RETRIES,
      schedule: Schedule.spaced(LOCK_CLAIM_RETRY_INTERVAL),
    }),
  );
  // Effect.ensuring, not try/finally: a typed failure unwinds past a generator's
  // finally without entering it, and the counter would stay locked for ten seconds.
  return yield* Effect.gen(function* () {
    const current = yield* fs.readFileString(seqPath).pipe(
      Effect.map((x) => Number.parseInt(x.trim(), 10)),
      Effect.catch(() => Effect.succeed(0)),
    );
    const next = Number.isFinite(current) ? current + 1 : 1;
    yield* fs.writeFileString(seqPath, String(next));
    return next;
  }).pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
});

const appendHandoffRun = Effect.fn("RunStore.appendHandoff")(function* (
  store: RunStore,
  runId: string,
  handoff: HandoffRecord,
) {
  const path = yield* Path.Path;
  const root = yield* store.rootEffect;
  return yield* withRunLock(
    path.join(root, runId),
    Effect.gen(function* () {
      const run = yield* store.load(runId);
      if (!run.record.handoffs.some((h) => handoffKey(h) === handoffKey(handoff))) {
        run.record.handoffs.push(handoff);
        yield* writeRecord(run.dir, run.record);
      }
      return run;
    }),
  );
});

const loadRun = Effect.fn("RunStore.load")(function* (store: RunStore, id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* store.rootEffect;
  const dir = path.join(root, id);
  const file = path.join(dir, RUN_FILE);
  if (!(yield* fs.exists(file))) return yield* Effect.fail(new Error(`no run "${id}" in ${root}`));
  return new Run(dir, yield* decodeRecord(id, yield* fs.readFileString(file)));
});

const listRuns = Effect.fn("RunStore.list")(function* (store: RunStore) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* store.rootEffect;
  if (!(yield* fs.exists(root))) return [];
  const runs: Run[] = [];
  for (const name of yield* fs.readDirectory(root)) {
    if (name.startsWith(".")) continue;
    // Skipped rather than raised: a listing is a view, and every caller that cares
    // which Run is broken loads that Run by id and is told exactly why.
    const run = yield* store.load(name).pipe(Effect.catch(() => Effect.succeed(null)));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => b.record.created_at.localeCompare(a.record.created_at));
});

const resumableRuns = Effect.fn("RunStore.resumable")(function* (store: RunStore) {
  return (yield* store.list()).filter(
    (r) => r.record.status !== "done" && r.unfinished().length > 0,
  );
});
