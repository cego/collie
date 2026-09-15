import { Data, Schema, Effect, FileSystem, Path, Struct } from "effect";
import { nowIso } from "./time";
import { currentPid, withLock } from "./lock";
import { IncarnationSchema } from "./registry";
import { unsafePathComponent } from "./naming";
import { FindingSchema, type Finding } from "./output";
import { writeSnapshot } from "./snapshot";
import { VerifySpecSchema } from "./verify-spec";
import type { ResolvedWorkflow } from "./definitions";
import type { VerifySpec } from "./verify-spec";
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
  /**
   * The mode this agent was started with, so a Run resumed after the agent is gone can
   * restart a continuation in the mode its chain was opened in rather than the Run
   * default. Records written before this key decode as null.
   */
  permissions: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  agent: Schema.String,
  label: Schema.String,
  tabId: Schema.NullOr(Schema.String),
  paneId: Schema.NullOr(Schema.String),
  /** Saved per variant: the role registry can be replaced by another live Run. */
  incarnation: Schema.optionalKey(IncarnationSchema),
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

/**
 * The checkout a mutating Run owns, keyed by its branch. `created_by_collie` is what
 * makes a worktree a candidate for pruning: a checkout a human made is never touched.
 */
const WorktreeRecordSchema = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  created_by_collie: Schema.Boolean,
  /**
   * Who made this checkout, and so who takes it away again: Collie with git itself,
   * or herdr as a workspace of its own. A record written before this existed is
   * `herdr`, which is what every checkout was then.
   */
  managed_by: Schema.Literals(["git", "herdr"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("herdr" as const)),
  ),
  /** The workspace herdr opened on it, which is what removing it names. */
  workspace_id: Schema.NullOr(Schema.String),
  /**
   * When git wrote this checkout's `.git` file, as milliseconds. It is what says the
   * checkout at that path is still the one Collie made: a path and a branch are not
   * provenance, because a human can make a worktree at a path Collie's used to be at,
   * on the same branch, and pruning must never touch a checkout it did not create. A
   * record without it — one written before this was kept — is never a candidate.
   */
  made_at: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The shell tab and pane herdr's new workspace came with, which this Run's first
   * agent takes over rather than leaving behind. Both null for a checkout that was
   * opened rather than created, and for a record written before they were kept.
   */
  root_tab_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  root_pane_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}).mapFields(Struct.map(Schema.mutableKey));
export type WorktreeRecord = Schema.Schema.Type<typeof WorktreeRecordSchema>;

/** One ticket's build within a step that slices: what it was, and how it went. */
const SliceRecordSchema = Schema.Struct({
  ticket: Schema.String,
  title: Schema.String,
  status: StepStatusSchema,
  output: Schema.NullOr(Schema.String),
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
  /**
   * What this slice committed, by subject, and the HEAD it left behind. Recorded once
   * when the slice ends so the hand-off to the next one is a few lines of fact rather
   * than a git call per render — and never the transcript.
   */
  commits: optionalList(Schema.String),
  head: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** What was verified while it ran, as `name: result` — the evidence half of the hand-off. */
  verifications: optionalList(Schema.String),
}).mapFields(Struct.map(Schema.mutableKey));

const StepRecordSchema = Schema.Struct({
  id: Schema.String,
  status: StepStatusSchema,
  iteration: Schema.Number,
  note: Schema.NullOr(Schema.String),
  /**
   * When this step started and stopped, ISO, or `null` where it has not yet. Both
   * default to null so a Run recorded before they were kept still decodes — and a step
   * that was skipped rather than run has no start at all, which is what makes its
   * duration nothing rather than zero.
   */
  started_at: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  finished_at: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  variants: optionalList(VariantRecordSchema),
  /**
   * One entry per ticket for a step that builds a plan in slices. A resumed Run skips
   * the slices that are `done` and picks up at the first that is not, so a build that
   * stopped at ticket 3 of 5 does not build tickets 1 and 2 again.
   */
  slices: optionalList(SliceRecordSchema),
}).mapFields(Struct.map(Schema.mutableKey));
export type SliceRecord = Schema.Schema.Type<typeof SliceRecordSchema>;
export type VariantRecord = Schema.Schema.Type<typeof VariantRecordSchema>;
export type HandoffRecord = Schema.Schema.Type<typeof HandoffRecordSchema>;
export type ChoiceRecord = Schema.Schema.Type<typeof ChoiceRecordSchema>;
export type StepRecord = Schema.Schema.Type<typeof StepRecordSchema>;

/**
 * A Choice that started one Run per repository of a plan that spans several: the order
 * the waves may start in, the Run each repository got, and where the fan-out has got to
 * (CONTEXT.md, Wave). A repository with no entry in `runs` was never started.
 */
const FanoutSchema = Schema.Struct({
  /**
   * The Choice that started it, so a resumed Driver picks up the right one. Both halves:
   * titles are deliberately not unique across steps (CONTEXT.md, Choice), and everything
   * else that answers a Choice — `choices` entries, `decisions` — is keyed by step id.
   * A record written before the step was kept has an empty one, which matches any step.
   */
  step: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  title: Schema.String,
  waves: Schema.Array(Schema.Array(Schema.String).pipe(Schema.mutable)).pipe(Schema.mutable),
  runs: Schema.Record(Schema.String, Schema.String.pipe(Schema.mutableKey)),
  /** The merge request each repository's run opened, once it has ended. */
  mrs: Schema.Record(Schema.String, Schema.String.pipe(Schema.mutableKey)),
  /** Which wave is being waited on, 1-based; 0 once no wave is. */
  wave: Schema.Number,
  /**
   * The repository that stopped the waves, and what became of its run: `failed`,
   * `stopped`, or `not started` where nothing could be started for it at all. The
   * status travels with the repository because a row that read "failed" for a run the
   * operator had stopped contradicted the note the run wrote for itself.
   */
  blocked: Schema.NullOr(Schema.Struct({ repo: Schema.String, status: Schema.String })),
});
export type FanoutRecord = Schema.Schema.Type<typeof FanoutSchema>;

/** One repository of a fan-out, and what became of the Repo run it was given. */
export interface FanoutRepo {
  repo: string;
  /** Its Repo run, and null for a repository the fan-out never got to. */
  run: string | null;
  /** The merge request that run opened, where it got that far. */
  mr: string | null;
}

/**
 * Every repository the fan-out covers, in the order its waves may start, with what
 * became of each. The one place the record's shape is picked apart: the board's row,
 * the parent's summary, the CLI's child lines and the resume check are four readers of
 * one answer, and each deriving it from `waves`, `runs` and `mrs` itself is how they
 * come to disagree about what "not started" means.
 */
export function fanoutRepos(fanout: FanoutRecord): FanoutRepo[] {
  return fanout.waves.flat().map((repo) => ({
    repo,
    run: fanout.runs[repo] ?? null,
    mr: fanout.mrs[repo] ?? null,
  }));
}

/**
 * Whether a fan-out still has something to do: a wave in flight, a repository that
 * stopped it, or one that was never started. A resumed parent re-enters it rather than
 * asking its menu again.
 */
export function fanoutUnfinished(fanout: FanoutRecord): boolean {
  return (
    fanout.blocked !== null ||
    fanout.wave !== 0 ||
    fanoutRepos(fanout).some((entry) => entry.run === null)
  );
}

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
  /**
   * The whole of what this Run is named after — the work source's own value, not the
   * short label beside it. A chained Run is named after its parent, and a name that was
   * already cut short cannot be caught by cutting it again, so the child's branch is
   * judged against this rather than against `slug`. Empty where nothing named the Run —
   * which a child must refuse rather than invent a shared name for — and null only for a
   * Run recorded before this was kept, which falls back to the slug as it always did.
   */
  named_after: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  workflow: Schema.String,
  cwd: Schema.String,
  session: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  /**
   * The Task this Run belongs to, recorded at creation and carried by every Run the
   * work chains into. Null for a Run started before Tasks existed, which is read as
   * belonging to none rather than assigned to one.
   */
  task: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  workspace_label: Schema.NullOr(Schema.String),
  workspace_worktree: Schema.NullOr(Schema.String),
  /** Where the Run was started from, before it was given a checkout of its own. */
  activated_cwd: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** This Run's own checkout, for a workflow that changes the repository. */
  worktree: Schema.NullOr(WorktreeRecordSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
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
  /** The repository runs a Choice fanned out, for a parent that waits on them. */
  fanout: Schema.NullOr(FanoutSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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
  /**
   * The workflow this Run is running, frozen in its own directory at creation. A Run
   * recorded before this existed has `null` and resolves from the layers as it always
   * did — under a step-id guard, because what those layers say may have moved since.
   */
  definition: Schema.NullOr(
    Schema.Struct({
      hash: Schema.String,
      layer: Schema.Literals(["baseline", "user", "project"]),
      path: Schema.String,
      snapshot: Schema.String,
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The commands Collie may run itself for this Run, copied from the layers when it
   * started. Recorded rather than read live so that editing the file changes the next Run
   * and never a running one — a permission that moved under a Run is not a permission.
   */
  approved_verifications: Schema.Array(VerifySpecSchema).pipe(
    Schema.mutable,
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /**
   * The kind of result this Run has to prove. Null for a Run recorded before outcomes
   * existed, and for one nobody classified — which is read as `unspecified` rather than
   * as `feature`, so a docs or investigation Run is never asked for a feature's evidence.
   */
  outcome: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** What the evidence gate found missing, as it last ran. Empty when nothing is. */
  evidence_gaps: optionalList(Schema.String),
  /**
   * What is in this Run's way, in one sentence, when something identifiable is: a command
   * failing the same way over and over. It is shown to the human and given to the next
   * prompt so the approach can change. It stops nothing — a counter is not a verdict.
   */
  obstacle: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Why a converging loop stopped for the human, as `attention` reports it. */
  halt: Schema.NullOr(
    Schema.Literals([
      "no_progress",
      "dispute_unresolved",
      "fix_unverified",
      "definition_changed",
      "evidence_missing",
    ]),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The blocking findings the last review raised, so the next can say nothing moved. */
  blocking_seen: Schema.NullOr(
    Schema.Struct({ iteration: Schema.Number, keys: Schema.Array(Schema.String) }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The last fix's own account of itself, where no review followed it. */
  unreviewed: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** The finished Run whose review this one was given, when it is a second look. */
  previous_review: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  mr_url: Schema.NullOr(Schema.String),
  linear_issues: optionalList(Schema.String),
  /**
   * The Helle claim this Run is holding, and whether it queued for it or took over one
   * the operator already had. Null means there is none to give back — which is what
   * keeps a resumed Run from releasing a claim it never acquired.
   */
  helle: Schema.NullOr(
    Schema.Struct({ slug: Schema.String, claim: Schema.Literals(["mine", "adopted"]) }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
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

  /**
   * A step's status, with the clock. Every transition goes through here rather than
   * assigning `status` directly, because the timings are the kind of fact that gets
   * stamped at four sites and forgotten at the fifth — and a step with a start and no
   * end reads on the board as one that has been running since it was skipped.
   */
  mark(id: string, status: StepStatus) {
    const record = this.step(id);
    return Effect.gen(function* () {
      const at = yield* nowIso();
      record.status = status;
      if (status === "running") {
        record.started_at = at;
        record.finished_at = null;
      } else if (status === "pending") {
        // Back round the loop: this iteration has not started, so it has no timings.
        record.started_at = null;
        record.finished_at = null;
      } else {
        record.finished_at = at;
      }
    }).pipe(Effect.withSpan("Run.mark"));
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

/**
 * A Run a `resume` could pick up again: not finished, and with Steps left to run. It
 * is not the same as "running" — a Choice nobody answered and an agent that stopped
 * both leave a Run `blocked`, and `resume` restarts it in the directory it recorded.
 */
export function resumable(run: Run): boolean {
  return run.record.status !== "done" && run.unfinished().length > 0;
}

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

export function withRunLock<A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) {
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

/**
 * The kinds nobody chooses: a `plan` proves it wrote tickets and a `review` proves it wrote
 * a review a human can read. Recorded at creation, like a chosen one, so the board, `run
 * show` and the finish read one field for every Run.
 */
function fixedOutcome(workflow: string): string | null {
  return workflow === "plan" || workflow === "review" ? workflow : null;
}

export interface CreateRunOptions {
  workflow: string;
  cwd: string;
  inputs: Record<string, string>;
  inputSources: Record<string, string>;
  /** What the human answered at launch for the Choice steps this Run will reach. */
  decisions?: Record<string, string>;
  /**
   * The resolved workflow this Run will execute. Given it, `create` freezes it in the
   * run directory and takes the step ids from it, so a Run can never record the steps of
   * one definition beside a snapshot of another. Omitted only by callers that have no
   * workflow to freeze — a fixture standing a Run up to be read, never one to be driven.
   */
  definition?: ResolvedWorkflow;
  /** What Collie may run itself for this Run; seeded from the layers, then fixed. */
  approvedVerifications?: ReadonlyArray<VerifySpec>;
  stepIds: string[];
  maxIterations: number;
  /**
   * What this Run is called after, whole — its branch where it has one, so the name says
   * the same thing the checkout does. Never a path: two plans under one `tasks/`
   * directory slug to the same clipped name, and two identical rows on the board tell
   * the human nothing.
   */
  namedAfter: string;
  /**
   * The short form to build the slug from, where an Input offered one — a merge
   * request's `!42` rather than the target that spells out its project. Defaults to
   * `namedAfter`, which is what a Run whose name has no shorter form uses.
   */
  slugFrom?: string;
  parent?: string;
  session?: string | null;
  workspace?: string | null;
  /** The Task this Run belongs to; a chained or resumed Run inherits its parent's. */
  task?: string | null;
  workspaceLabel?: string | null;
  workspaceWorktree?: string | null;
  activatedCwd?: string | null;
  worktree?: WorktreeRecord | null;
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
      const slug = `${opts.workflow}-${slugify(opts.slugFrom ?? opts.namedAfter)}`;
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
        named_after: opts.namedAfter,
        workflow: opts.workflow,
        cwd: opts.cwd,
        session: opts.session ?? null,
        workspace: opts.workspace ?? null,
        task: opts.task ?? null,
        workspace_label: opts.workspaceLabel ?? null,
        workspace_worktree: opts.workspaceWorktree ?? null,
        activated_cwd: opts.activatedCwd ?? null,
        worktree: opts.worktree ?? null,
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
          started_at: null,
          finished_at: null,
          variants: [],
          slices: [],
        })),
        parent: opts.parent ?? null,
        children: [],
        choices: [],
        decisions: opts.decisions ?? {},
        fanout: null,
        awaiting: null,
        handoffs: [],
        disputed: [],
        deferred: [],
        outstanding: [],
        target_label: null,
        synthesis: null,
        unpushed: null,
        fixed: 0,
        definition: null,
        // The Run's own Input, read once here: every front door and every chain settles
        // Inputs before creating the Run, and a second place to read this from is a
        // second place for it to disagree with what the Run was started with.
        outcome: fixedOutcome(opts.workflow) ?? (opts.inputs.outcome?.trim() || null),
        evidence_gaps: [],
        obstacle: null,
        approved_verifications: (opts.approvedVerifications ?? []).map((spec) => ({
          ...spec,
          argv: [...spec.argv],
        })),
        halt: null,
        blocking_seen: null,
        unreviewed: null,
        notified: [],
        previous_review: null,
        mr_url: null,
        linear_issues: [],
        helle: null,
        summary: null,
      };
      const run = new Run(path.join(root, id), record);
      // Before the first save, so a Run is never on disk without the definition it
      // records — a reader that found one would have to guess which way round they are.
      if (opts.definition) record.definition = yield* writeSnapshot(run.dir, opts.definition);
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
  finished(cwd: string, task?: string | null) {
    const list = this.list();
    return Effect.gen(function* () {
      return (yield* list).filter(
        (run) =>
          run.record.cwd === cwd &&
          run.record.status === "done" &&
          // A repository match alone is not membership. A fresh start asks about no
          // Task and so sees the Runs recorded before Tasks existed — transition
          // compatibility, deliberate: an upgraded installation's earlier plans stay
          // findable until they have a Task of their own.
          run.record.task === (task ?? null),
      );
    }).pipe(Effect.withSpan("RunStore.finished"));
  }

  /**
   * The newest finished Run of this repo that reviewed this exact target and wrote a
   * review. `before` is the asking Run's own id, so a Run never finds itself.
   */
  previousReview(cwd: string, target: string, before?: string, task?: string | null) {
    const finished = this.finished(cwd, task);
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
      return (yield* list).filter(resumable);
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

/**
 * What a board row's marks need of a Run's record, in one place: two callers read it, and
 * a `null` record is a Run whose file could not be loaded rather than a Run with no marks.
 */
export function markedFrom(record: RunRecord | null) {
  return {
    awaiting: record?.awaiting ?? null,
    harnesses: record === null ? [] : runningHarnesses(record),
  };
}

/** The harnesses a Run's running agents are on, deduplicated. */
function runningHarnesses(record: RunRecord): ReadonlyArray<string> {
  return [
    ...new Set(
      record.steps
        .flatMap((step) => step.variants)
        .filter((variant) => variant.status === "running")
        .map((variant) => variant.harness),
    ),
  ];
}

/** The agents a Run's record still has running, by name. */
export function runningAgents(record: RunRecord): ReadonlyArray<string> {
  return record.steps
    .flatMap((step) => step.variants)
    .filter((variant) => variant.status === "running" && variant.agent !== "")
    .map((variant) => variant.agent);
}
