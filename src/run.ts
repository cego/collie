import { Data, Schema, Effect, FileSystem, Path, Struct } from "effect";
import { nowIso } from "./time";
import { currentPid, withLock } from "./lock";
import { unsafePathComponent } from "./naming";
import { FindingSchema, type Finding } from "./output";
import { slugify } from "./template";

/** A collection a Run may predate: absent reads as empty, so old is not corrupt. */
function optionalList<S extends Schema.Top>(item: S) {
  return Schema.Array(item).pipe(Schema.mutable, Schema.withDecodingDefaultKey(Effect.succeed([])));
}

const StepStatusSchema = Schema.Literals(["pending", "running", "done", "blocked", "failed"]);
export type StepStatus = Schema.Schema.Type<typeof StepStatusSchema>;
const RunStatusSchema = Schema.Literals(["running", "done", "blocked", "failed"]);
export type RunStatus = Schema.Schema.Type<typeof RunStatusSchema>;

const VariantRecordSchema = Schema.Struct({
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
  /** Outputs this agent was asked to write again, and why. One per iteration. */
  repairs: optionalList(Schema.String),
  /** How many times this agent was nudged for going quiet. */
  nudges: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
}).mapFields(Struct.map(Schema.mutableKey));

const HandoffRecordSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  direction: Schema.Literals(["sent", "received"]),
  role: Schema.String,
  agent: Schema.String,
  run: Schema.String,
  at: Schema.String,
  note: Schema.String,
}).mapFields(Struct.map(Schema.mutableKey));

const ChoiceRecordSchema = Schema.Struct({
  step: Schema.String,
  title: Schema.String,
  at: Schema.String,
}).mapFields(Struct.map(Schema.mutableKey));

const StepRecordSchema = Schema.Struct({
  id: Schema.String,
  status: StepStatusSchema,
  iteration: Schema.Number,
  note: Schema.NullOr(Schema.String),
  variants: optionalList(VariantRecordSchema),
}).mapFields(Struct.map(Schema.mutableKey));
export type VariantRecord = Schema.Schema.Type<typeof VariantRecordSchema>;
export type HandoffRecord = Schema.Schema.Type<typeof HandoffRecordSchema>;
export type ChoiceRecord = Schema.Schema.Type<typeof ChoiceRecordSchema>;
export type StepRecord = Schema.Schema.Type<typeof StepRecordSchema>;

/**
 * The persisted Run, and the only place `run.json` is given a shape. Every reader —
 * the CLI, the Control Plane, the Driver, the engine — loads Runs through RunStore,
 * so a malformed Run fails where it is read rather than being trusted by whoever
 * reads it first and re-checked by whoever cares most.
 *
 * The engine deliberately updates decoded Runs in place, so the exported type removes
 * readonly recursively from this schema-derived shape.
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
  status: RunStatusSchema,
  iteration: Schema.Number,
  max_iterations: Schema.Number,
  inputs: Schema.Record(Schema.String, Schema.String.pipe(Schema.mutableKey)),
  input_sources: Schema.Record(Schema.String, Schema.String.pipe(Schema.mutableKey)),
  steps: Schema.Array(StepRecordSchema).pipe(Schema.mutable),
  parent: Schema.NullOr(Schema.String),
  children: optionalList(Schema.String),
  choices: optionalList(ChoiceRecordSchema),
  /** Answers given at launch, by Choice step id. A step with no entry asks. */
  decisions: Schema.Record(Schema.String, Schema.String.pipe(Schema.mutableKey)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  awaiting: Schema.NullOr(Schema.String),
  handoffs: optionalList(HandoffRecordSchema),
  disputed: optionalList(FindingSchema),
  deferred: optionalList(FindingSchema),
  outstanding: optionalList(FindingSchema),
  target_label: Schema.NullOr(Schema.String),
  synthesis: Schema.NullOr(Schema.String),
  /** `<kind>:<step>` for every notification already raised, so a resumed Driver
   * does not announce what the last one already did. */
  notified: optionalList(Schema.String),
  /** The branch a step committed to and did not push, so the Run can say so. */
  unpushed: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** How many of the previous review's findings this one found fixed. */
  fixed: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** The finished Run whose review this one was given, when it is a second look. */
  previous_review: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  mr_url: Schema.NullOr(Schema.String),
  linear_issues: optionalList(Schema.String),
  summary: Schema.NullOr(Schema.String),
}).mapFields(Struct.map(Schema.mutableKey));
export type RunRecord = Schema.Schema.Type<typeof RunSchema>;

const RunRecordJson = Schema.fromJsonString(RunSchema);
const encodeRecord = Schema.encodeSync(RunRecordJson);

/** A `run.json` that exists but is not a Run. Readers report it; they never guess. */
export class InvalidRunState extends Data.TaggedError("InvalidRunState")<{
  run: string;
  cause: string;
}> {}

const decodeRecord = Effect.fn("RunStore.decodeRecord")(function* (id: string, raw: string) {
  return yield* Schema.decodeUnknownEffect(RunRecordJson)(raw).pipe(
    Effect.mapError((cause) => new InvalidRunState({ run: id, cause: String(cause) })),
  );
});

const RUN_FILE = "run.json";
export class Run {
  constructor(
    readonly dir: string,
    readonly record: RunRecord,
  ) {}
  get id(): string {
    return this.record.id;
  }

  save() {
    const { dir, record } = this;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* withRunLock(
        dir,
        Effect.gen(function* () {
          yield* mergeHandoffs(dir, record);
          yield* writeRecord(dir, record);
        }),
      );
    }).pipe(Effect.withSpan("Run.save"));
  }

  stepDir(stepId: string, variantKey: string | null) {
    const dirRoot = this.dir;
    const component = (value: string) => this.component(value);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = variantKey
        ? path.join(dirRoot, "steps", component(stepId), component(variantKey))
        : path.join(dirRoot, "steps", component(stepId));
      yield* fs.makeDirectory(dir, { recursive: true });
      return dir;
    }).pipe(Effect.withSpan("Run.stepDir"));
  }

  outputPath(stepId: string, variantKey: string | null, filename: string) {
    const stepDir = () => this.stepDir(stepId, variantKey);
    const component = (value: string) => this.component(value);
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      return path.join(yield* stepDir(), component(filename));
    }).pipe(Effect.withSpan("Run.outputPath"));
  }

  personaPath(persona: string, harness: string) {
    const dirRoot = this.dir;
    const component = (value: string) => this.component(value);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = path.join(dirRoot, "personas");
      yield* fs.makeDirectory(dir, { recursive: true });
      return path.join(dir, component(`${persona}.${harness}.md`));
    }).pipe(Effect.withSpan("Run.personaPath"));
  }

  log(line: string) {
    const dir = this.dir;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(dir, { recursive: true });
      const at = yield* nowIso();
      yield* fs.writeFileString(path.join(dir, "log.txt"), `${at} ${line}\n`, { flag: "a" });
    }).pipe(Effect.withSpan("Run.log"));
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

const mergeHandoffs = Effect.fn("Run.mergeHandoffs")(function* (dir: string, record: RunRecord) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const disk = yield* fs.readFileString(path.join(dir, RUN_FILE)).pipe(
    Effect.flatMap((raw) => decodeRecord(record.id, raw)),
    Effect.catch(() => Effect.succeed(null)),
  );
  if (!disk) return;
  const have = new Set(record.handoffs.map(handoffKey));
  for (const handoff of disk.handoffs ?? []) {
    const key = handoffKey(handoff);
    if (!have.has(key)) {
      have.add(key);
      record.handoffs.push(handoff);
    }
  }
});

export function handoffKey(h: HandoffRecord): string {
  return h.id ? `${h.direction}|${h.id}` : [h.direction, h.role, h.run, h.at, h.note].join("|");
}

const writeRecord = Effect.fn("writeRecord")(function* (dir: string, record: RunRecord) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const me = yield* currentPid;
  const tmp = path.join(dir, `${RUN_FILE}.tmp-${me}`);
  yield* fs.writeFileString(tmp, `${encodeRecord(record)}\n`);
  yield* fs.rename(tmp, path.join(dir, RUN_FILE));
});

function withRunLock<A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(dir, `${RUN_FILE}.lock`);
    return yield* withLock(
      lock,
      Effect.fail(new Error(`${lock} could not be acquired; not writing unlocked`)),
      effect,
    );
  });
}

export interface CreateRunOptions {
  workflow: string;
  cwd: string;
  inputs: Record<string, string>;
  inputSources: Record<string, string>;
  /** What the human answered at launch for the Choice steps this Run will reach. */
  decisions?: Record<string, string>;
  stepIds: string[];
  maxIterations: number;
  primaryInput: string;
  parent?: string;
  session?: string | null;
  workspace?: string | null;
  workspaceLabel?: string | null;
  workspaceWorktree?: string | null;
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

  create(opts: CreateRunOptions) {
    const rootEffect = this.rootEffect;
    const nextSeq = () => this.nextSeq();
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* rootEffect;
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
        seq: yield* nextSeq(),
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
        decisions: opts.decisions ?? {},
        awaiting: null,
        handoffs: [],
        disputed: [],
        deferred: [],
        outstanding: [],
        target_label: null,
        synthesis: null,
        unpushed: null,
        fixed: 0,
        notified: [],
        previous_review: null,
        mr_url: null,
        linear_issues: [],
        summary: null,
      };
      const run = new Run(path.join(root, id), record);
      yield* run.save();
      return run;
    }).pipe(Effect.withSpan("RunStore.create"));
  }

  appendHandoff(runId: string, handoff: HandoffRecord) {
    const rootEffect = this.rootEffect;
    const load = () => this.load(runId);
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* rootEffect;
      return yield* withRunLock(
        path.join(root, runId),
        Effect.gen(function* () {
          const run = yield* load();
          if (!run.record.handoffs.some((item) => handoffKey(item) === handoffKey(handoff))) {
            run.record.handoffs.push(handoff);
            yield* writeRecord(run.dir, run.record);
          }
          return run;
        }),
      );
    }).pipe(Effect.withSpan("RunStore.appendHandoff"));
  }

  /**
   * A newer review of the same target is the current verdict on it, so the run that
   * carried the older one stops reporting findings the new review no longer holds
   * open. Under the run lock, like appendHandoff: the run is finished, but a board
   * action may be appending a handoff to it at the same moment.
   */
  supersedeOutstanding(runId: string, findings: Finding[]) {
    const rootEffect = this.rootEffect;
    const load = () => this.load(runId);
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* rootEffect;
      return yield* withRunLock(
        path.join(root, runId),
        Effect.gen(function* () {
          const run = yield* load();
          run.record.outstanding = findings;
          yield* writeRecord(run.dir, run.record);
          return run;
        }),
      );
    }).pipe(Effect.withSpan("RunStore.supersedeOutstanding"));
  }

  load(id: string) {
    const rootEffect = this.rootEffect;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* rootEffect;
      // A Run id is a directory name under `runs/`, and ids reach here from a command
      // line and from Inputs. Guarding at the store rather than at each caller is what
      // makes a `../` id impossible to read a run.json — or a review.md beside it —
      // from outside the state dir.
      const unsafe = unsafePathComponent(id);
      if (unsafe) return yield* Effect.fail(new Error(`run id "${id}" ${unsafe}`));
      const dir = path.join(root, id);
      const file = path.join(dir, RUN_FILE);
      if (!(yield* fs.exists(file)))
        return yield* Effect.fail(new Error(`no run "${id}" in ${root}`));
      return new Run(dir, yield* decodeRecord(id, yield* fs.readFileString(file)));
    }).pipe(Effect.withSpan("RunStore.load"));
  }

  list() {
    const rootEffect = this.rootEffect;
    const load = (id: string) => this.load(id);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* rootEffect;
      if (!(yield* fs.exists(root))) return [];
      const runs: Run[] = [];
      for (const name of yield* fs.readDirectory(root)) {
        if (name.startsWith(".")) continue;
        // Skipped rather than raised: a listing is a view, and every caller that cares
        // which Run is broken loads that Run by id and is told exactly why.
        const run = yield* load(name).pipe(Effect.catch(() => Effect.succeed(null)));
        if (run) runs.push(run);
      }
      return runs.sort((a, b) => b.record.created_at.localeCompare(a.record.created_at));
    }).pipe(Effect.withSpan("RunStore.list"));
  }

  /**
   * This repo's finished Runs, newest first — what every "has this been done here
   * before?" question reads: an earlier plan to build from, a target already
   * reviewed, the review to compare a second one against. What counts as finished,
   * and as this repo, is decided once, here.
   */
  finished(cwd: string) {
    const list = this.list();
    return Effect.gen(function* () {
      return (yield* list).filter((run) => run.record.cwd === cwd && run.record.status === "done");
    }).pipe(Effect.withSpan("RunStore.finished"));
  }

  /**
   * The newest finished Run of this repo that reviewed this exact target and wrote a
   * review. `before` is the asking Run's own id, so a Run never finds itself.
   */
  previousReview(cwd: string, target: string, before?: string) {
    const finished = this.finished(cwd);
    return Effect.gen(function* () {
      if (target === "") return null;
      for (const run of yield* finished) {
        if (run.id === before) continue;
        if (run.record.inputs.target !== target || !run.record.synthesis) continue;
        return run;
      }
      return null;
    }).pipe(Effect.withSpan("RunStore.previousReview"));
  }

  resumable() {
    const list = this.list();
    return Effect.gen(function* () {
      return (yield* list).filter(
        (run) => run.record.status !== "done" && run.unfinished().length > 0,
      );
    }).pipe(Effect.withSpan("RunStore.resumable"));
  }

  /** Serializes the counter because herdr rejects duplicate agent names. */
  nextSeq() {
    const rootEffect = this.rootEffect;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* rootEffect;
      yield* fs.makeDirectory(root, { recursive: true });
      const seqPath = path.join(root, ".seq");
      const lock = `${seqPath}.lock`;
      return yield* withLock(
        lock,
        Effect.fail(new Error(`could not claim the Run sequence lock ${lock}`)),
        Effect.gen(function* () {
          const current = yield* fs.readFileString(seqPath).pipe(
            Effect.map((value) => Number.parseInt(value.trim(), 10)),
            Effect.catch(() => Effect.succeed(0)),
          );
          const next = Number.isFinite(current) ? current + 1 : 1;
          yield* fs.writeFileString(seqPath, String(next));
          return next;
        }),
      );
    }).pipe(Effect.withSpan("RunStore.nextSeq"));
  }
}
