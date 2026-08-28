// The Run directory: one per execution, the audit trail and the resume state.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  disputed: Finding[];
  /** Architecture candidates the architect did not apply. */
  deferred: Finding[];
  /** Findings still open when a fix loop hit max_iterations. */
  outstanding: Finding[];
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
    writeFileSync(join(this.dir, "run.json"), `${JSON.stringify(this.record, null, 2)}\n`);
  }

  step(id: string): StepRecord {
    const found = this.record.steps.find((s) => s.id === id);
    if (!found) throw new Error(`run ${this.record.id} has no step "${id}"`);
    return found;
  }

  stepDir(stepId: string, variantKey: string | null): string {
    const dir = variantKey ? join(this.dir, "steps", stepId, variantKey) : join(this.dir, "steps", stepId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  outputPath(stepId: string, variantKey: string | null, filename: string): string {
    return join(this.stepDir(stepId, variantKey), filename);
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
  }): Run {
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
      disputed: [],
      deferred: [],
      outstanding: [],
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

  load(id: string): Run {
    const dir = join(this.root, id);
    const path = join(dir, "run.json");
    if (!existsSync(path)) throw new Error(`no run "${id}" in ${this.root}`);
    const record = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    // A run recorded by an older version has fewer lists than this one expects.
    record.children ??= [];
    record.choices ??= [];
    record.deferred ??= [];
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
