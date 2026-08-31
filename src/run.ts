// The Run directory: one per execution, the audit trail and the resume state.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { breakStaleLock, holdsLock, releaseOwnLock, tryClaimLock } from "./lock";
import { unsafePathComponent } from "./naming";
import type { Finding } from "./output";
import { slugify } from "./template";

export type StepStatus = "pending" | "running" | "done" | "blocked" | "failed";
export type RunStatus = "running" | "done" | "blocked" | "failed";

export interface VariantRecord {
  harness: string;
  model: string;
  effort: string | null;
  agent: string;
  /** The readable tab/pane name; the agent name is length-constrained. */
  label: string;
  tabId: string | null;
  paneId: string | null;
  status: StepStatus;
  /** Path of the Output file, relative to the run dir. */
  output: string | null;
  error: string | null;
}

/** A prompt one Run handed to another Run's live agent. Both Runs record it. */
export interface HandoffRecord {
  /** One identity for the exchange, shared by both sides, so merges deduplicate.
   * Absent on records written before Hand-offs had ids; handoffKey falls back. */
  id?: string;
  direction: "sent" | "received";
  /** The role at the other end: `implementer`, `planner`. */
  role: string;
  agent: string;
  /** The other Run in the exchange. */
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
  /** Monotonic per state dir; keeps agent names unique inside 32 characters. */
  seq: number;
  slug: string;
  workflow: string;
  cwd: string;
  /** The herdr session the Run was started in, as its socket path. */
  session: string | null;
  /** The workspace it was started in; a Session is session + workspace + cwd. */
  workspace: string | null;
  /** That workspace's label, so a recycled workspace id is caught. */
  workspace_label: string | null;
  created_at: string;
  finished_at: string | null;
  status: RunStatus;
  iteration: number;
  max_iterations: number;
  inputs: Record<string, string>;
  input_sources: Record<string, string>;
  steps: StepRecord[];
  /** Set when this Run was chained from a Choice in another Run. */
  parent: string | null;
  /** Runs chained from a Choice in this one. */
  children: string[];
  choices: ChoiceRecord[];
  /** The step this Run is waiting on the human for, so the workspace tab can say so. */
  awaiting: string | null;
  /** Prompts this Run sent to another Run's live agents. */
  handoffs: HandoffRecord[];
  disputed: Finding[];
  /** Architecture candidates the architect did not apply. */
  deferred: Finding[];
  /** Findings still open when a fix loop hit max_iterations. */
  outstanding: Finding[];
  /** What the run is pointed at, as its tab shows it; the engine fills it in. */
  target_label: string | null;
  /** The Synthesis Output `review.md` was rendered from, relative to the run dir. */
  synthesis: string | null;
  /** The merge request the `mr` step opened, when it ran. */
  mr_url: string | null;
  /** Linear tickets this run answered, as the MR step resolved them. */
  linear_issues: string[];
  summary: string | null;
}

export class Run {
  constructor(
    readonly dir: string,
    readonly record: RunRecord,
  ) {}

  get id(): string {
    return this.record.id;
  }

  save(): void {
    mkdirSync(this.dir, { recursive: true });
    // Under the run lock, so the merge-read and the rename are one step against
    // a Hand-off writer in another process: nothing lands between them and is lost.
    withRunLock(this.dir, () => {
      this.mergeHandoffs(join(this.dir, RUN_FILE));
      writeRecord(this.dir, this.record);
    });
  }

  /**
   * Another process may have recorded a Hand-off here since this record was
   * loaded; a save from that older in-memory state must keep it, exactly once.
   * Everything else is this Driver's to overwrite — the merge is only the list
   * another process appends to.
   */
  private mergeHandoffs(path: string): void {
    let disk: RunRecord;
    try {
      disk = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    } catch {
      // No file yet, or one mid-write: nothing external to preserve.
      return;
    }
    const have = new Set(this.record.handoffs.map(handoffKey));
    for (const handoff of disk.handoffs ?? []) {
      const key = handoffKey(handoff);
      if (have.has(key)) continue;
      have.add(key);
      this.record.handoffs.push(handoff);
    }
  }

  step(id: string): StepRecord {
    const found = this.record.steps.find((s) => s.id === id);
    if (!found) throw new Error(`run ${this.record.id} has no step "${id}"`);
    return found;
  }

  /**
   * Defence in depth behind definition validation: a value that is not a plain
   * path component must never become a path, or it could land outside the Run.
   */
  private component(value: string): string {
    // The same predicate the validation layer uses, so the two cannot drift.
    if (unsafePathComponent(value) !== null) {
      throw new Error(`run ${this.record.id}: "${value}" cannot name a file or directory inside the run`);
    }
    return value;
  }

  stepDir(stepId: string, variantKey: string | null): string {
    const dir = variantKey
      ? join(this.dir, "steps", this.component(stepId), this.component(variantKey))
      : join(this.dir, "steps", this.component(stepId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  outputPath(stepId: string, variantKey: string | null, filename: string): string {
    return join(this.stepDir(stepId, variantKey), this.component(filename));
  }

  /**
   * Where a Persona is written for one harness. Guarded here because a resumed
   * Run re-resolves its definitions without re-validating them, so a persona
   * name edited to something unsafe since the Run was created must still be
   * unable to name a file outside the Run.
   */
  personaPath(persona: string, harness: string): string {
    const dir = join(this.dir, "personas");
    mkdirSync(dir, { recursive: true });
    return join(dir, this.component(`${persona}.${harness}.md`));
  }

  log(line: string): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "log.txt"), `${new Date().toISOString()} ${line}\n`);
  }

  /** Steps that still have work, i.e. what a resume would restart. */
  unfinished(): StepRecord[] {
    return this.record.steps.filter((s) => s.status !== "done");
  }
}

/**
 * The dedupe identity of one side of one exchange. Direction is part of it:
 * a Run handing off to its own agent carries both sides under one id, and the
 * "received" entry must not be dropped as a duplicate of the "sent" one. A
 * record written before Hand-offs had ids is identified by its fields instead.
 */
export function handoffKey(h: HandoffRecord): string {
  return h.id ? `${h.direction}|${h.id}` : [h.direction, h.role, h.run, h.at, h.note].join("|");
}

const RUN_FILE = "run.json";

/** Whole file, then renamed into place, so a concurrent reader never sees a torn record. */
function writeRecord(dir: string, record: RunRecord): void {
  const tmp = join(dir, `${RUN_FILE}.tmp-${process.pid}`);
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, join(dir, RUN_FILE));
}

/**
 * run.json is read-modify-written by its Driver and by Hand-off writers in other
 * processes; this lock serialises those critical sections, and fn never runs
 * without it. A crashed holder's lock is broken the moment its pid is dead and a
 * reused pid is spotted by its start time, so waiting is only ever for a live
 * holder, whose critical section is microseconds. A verified-live holder wedged
 * past the deadline — a suspended process — makes this throw rather than write
 * unlocked or break a living lock: the lost update and the broken lock are each
 * worse than a loud failure.
 */
function withRunLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, `${RUN_FILE}.lock`);
  const deadline = Date.now() + 15_000;
  let held = false;
  while (!held && Date.now() < deadline) {
    // Anything but contention — the run directory itself missing, say — throws
    // out of the claim; spinning on it here would burn the deadline hot.
    // The claim is re-read after winning it: a contender that raced the same
    // stale break may have removed this one's fresh lock before claiming its own.
    if (tryClaimLock(lock) && holdsLock(lock)) held = true;
    else if (!breakStaleLock(lock)) Bun.sleepSync(5);
  }
  if (!held) throw new Error(`${lock} could not be acquired; not writing unlocked`);
  try {
    return fn();
  } finally {
    releaseOwnLock(lock);
  }
}

export class RunStore {
  constructor(private readonly stateDir: string) {}

  get root(): string {
    return join(this.stateDir, "runs");
  }

  create(opts: {
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
  }): Run {
    // Validation rejects such a name earlier with a friendlier error; this is the
    // defence in depth, because the workflow name becomes the Run directory itself.
    const badWorkflow = unsafePathComponent(opts.workflow);
    if (badWorkflow) {
      throw new Error(`workflow name "${opts.workflow}" ${badWorkflow}, so it cannot name a Run directory`);
    }
    const slug = `${opts.workflow}-${slugify(opts.primaryInput)}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    let id = `${slug}-${stamp}`;
    for (let n = 2; existsSync(join(this.root, id)); n++) id = `${slug}-${stamp}-${n}`;

    const record: RunRecord = {
      id,
      seq: this.nextSeq(),
      slug,
      workflow: opts.workflow,
      cwd: opts.cwd,
      session: opts.session ?? null,
      workspace: opts.workspace ?? null,
      workspace_label: opts.workspaceLabel ?? null,
      created_at: new Date().toISOString(),
      finished_at: null,
      status: "running",
      iteration: 1,
      max_iterations: opts.maxIterations,
      inputs: opts.inputs,
      input_sources: opts.inputSources,
      steps: opts.stepIds.map((id) => ({ id, status: "pending", iteration: 0, note: null, variants: [] })),
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
    const run = new Run(join(this.root, id), record);
    run.save();
    return run;
  }

  private nextSeq(): number {
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, ".seq");
    const current = existsSync(path) ? Number.parseInt(readFileSync(path, "utf8").trim(), 10) : 0;
    const next = Number.isFinite(current) ? current + 1 : 1;
    writeFileSync(path, String(next));
    return next;
  }

  /**
   * Records one Hand-off on a Run another process may be driving. Loaded fresh
   * and written under the run lock, so the entry can neither be lost to a
   * concurrent save nor roll back state that Run's Driver wrote in the meantime,
   * and the same exchange appended twice is kept once.
   */
  appendHandoff(runId: string, handoff: HandoffRecord): Run {
    return withRunLock(join(this.root, runId), () => {
      const run = this.load(runId);
      if (!run.record.handoffs.some((h) => handoffKey(h) === handoffKey(handoff))) {
        run.record.handoffs.push(handoff);
        writeRecord(run.dir, run.record);
      }
      return run;
    });
  }

  load(id: string): Run {
    const dir = join(this.root, id);
    const path = join(dir, "run.json");
    if (!existsSync(path)) throw new Error(`no run "${id}" in ${this.root}`);
    const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    // A run recorded by an older version has fewer lists than this one expects.
    record.children ??= [];
    record.choices ??= [];
    record.session ??= null;
    record.workspace ??= null;
    record.workspace_label ??= null;
    record.awaiting ??= null;
    record.handoffs ??= [];
    record.deferred ??= [];
    record.target_label ??= null;
    record.synthesis ??= null;
    record.mr_url ??= null;
    record.linear_issues ??= [];
    record.parent ??= null;
    return new Run(dir, record);
  }

  /** Newest first. */
  list(): Run[] {
    if (!existsSync(this.root)) return [];
    const runs: Run[] = [];
    for (const name of readdirSync(this.root)) {
      if (name.startsWith(".")) continue;
      try {
        runs.push(this.load(name));
      } catch {
        // A half-written run dir must not break the resume list.
      }
    }
    return runs.sort((a, b) => b.record.created_at.localeCompare(a.record.created_at));
  }

  resumable(): Run[] {
    return this.list().filter((r) => r.record.status !== "done" && r.unfinished().length > 0);
  }
}
