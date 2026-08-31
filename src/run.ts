import { Schema, Clock, Effect, FileSystem, Path } from "effect";
import { nowIso } from "./time";
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

const RUN_FILE = "run.json";
const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);
const decodeJson = Schema.decodeUnknownSync(JsonString);
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
    Effect.map((raw) => {
      // SAFETY: run.json is written by writeRecord from RunRecord.
      return decodeJson(raw) as RunRecord;
    }),
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
  yield* fs.writeFileString(tmp, `${encodeJson(record)}\n`);
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
  let id = `${slug}-${stamp}`;
  for (let n = 2; yield* fs.exists(path.join(root, id)); n++) id = `${slug}-${stamp}-${n}`;
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

const nextSeqRun = Effect.fn("RunStore.nextSeq")(function* (store: RunStore) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* store.rootEffect;
  yield* fs.makeDirectory(root, { recursive: true });
  const seqPath = path.join(root, ".seq");
  const current = yield* fs.readFileString(seqPath).pipe(
    Effect.map((x) => Number.parseInt(x.trim(), 10)),
    Effect.catch(() => Effect.succeed(0)),
  );
  const next = Number.isFinite(current) ? current + 1 : 1;
  yield* fs.writeFileString(seqPath, String(next));
  return next;
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
  // SAFETY: run.json is written by writeRecord from RunRecord.
  return new Run(dir, decodeJson(yield* fs.readFileString(file)) as RunRecord);
});

const listRuns = Effect.fn("RunStore.list")(function* (store: RunStore) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* store.rootEffect;
  if (!(yield* fs.exists(root))) return [];
  const runs: Run[] = [];
  for (const name of yield* fs.readDirectory(root)) {
    if (name.startsWith(".")) continue;
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
