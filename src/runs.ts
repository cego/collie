// Every Run a reader can see, as one shape, from the host's rows.
//
// A Run is either one the host is holding or one an older Collie recorded and the importer
// read into history. Readers — the board, History, chat, inference — ask which Runs there
// are and what each is; they never ask which engine recorded one, and never open a
// `run.json` to find out.

import { Effect, Option, Schema } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { PluginEnv } from "./env";
import { nativeHistory, nativeRuns } from "./lifecycle";
import { HOLD, STOP, evidenceDir, runDir, type RunView } from "./native";
import type { Settled } from "./strategies";
import type { HistoryRow } from "./store";
import { WorktreeRecordSchema, type WorktreeRecord } from "./run";

/** Where a Run is, in the words every board and listing uses. */
export type RunState = "running" | "waiting" | "succeeded" | "failed" | "stopped";

/** A question a Run is waiting on a human for. */
export interface Asked {
  readonly name: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
}

export interface RunFacts {
  readonly id: string;
  readonly workflow: string;
  /** The checkout it was started for, which is what "done here before" asks about. */
  readonly project: string;
  /** Where it works: its own worktree, or the checkout it was started for. */
  readonly cwd: string;
  readonly task: string | null;
  readonly parent: string | null;
  readonly outcome: string;
  readonly created: string;
  /** When it ended, where that was recorded. */
  readonly finished: string | null;
  readonly state: RunState;
  /** Its values, what each was inferred by, and where each came from. */
  readonly settled: Settled;
  readonly branch: string | null;
  readonly mr: string | null;
  /** A workspace of its own; null lives in its Task's. */
  readonly workspace: string | null;
  /** The checkout Collie made for it, which is what says it may take it away again. */
  readonly worktree: WorktreeRecord | null;
  /** Where what it produced is kept: its plan, review, cards, Intent and dispositions. */
  readonly dir: string;
  /** Where its verifications are kept. */
  readonly evidence: string;
  /** Recorded by the engine Collie no longer has: readable, never resumable. */
  readonly imported: boolean;
  readonly asking: ReadonlyArray<Asked>;
  readonly held: boolean;
  /** Why it is not moving or why it ended, in its own words, where it said. */
  readonly note: string | null;
  readonly summary: string | null;
}

const isText = Schema.is(Schema.String);

const textOf = (value: Schema.Json): string => (isText(value) ? value : JSON.stringify(value));

const stateOf = (view: RunView): RunState => {
  switch (view.status.status) {
    case "complete":
      return "succeeded";
    case "failed":
      return view.controls.includes(STOP) ? "stopped" : "failed";
    // Suspended is also an agent at work: only a question or a parked Run is waiting.
    case "suspended":
      return view.parked !== null || view.waiting.some((one) => one.answer === null)
        ? "waiting"
        : "running";
    case "pending":
      return "running";
  }
};

export const factsOfView = (stateDir: string, view: RunView): RunFacts => ({
  id: view.runId,
  workflow: view.workflow,
  project: view.project,
  cwd: view.cwd,
  task: view.task,
  parent: view.parent,
  outcome: view.outcome,
  created: view.created,
  finished: null,
  state: stateOf(view),
  settled: {
    inputs: Object.fromEntries(
      Object.entries(view.input).map(([name, value]) => [name, textOf(value)]),
    ),
    strategies: view.strategies,
    sources: view.provenance,
  },
  branch: view.branch,
  mr: null,
  workspace: view.workspace,
  worktree: view.worktree,
  dir: runDir(stateDir, view.runId),
  evidence: evidenceDir(stateDir, view.runId),
  imported: false,
  asking: view.waiting
    .filter((one) => one.answer === null)
    .map((one) => ({ name: one.name, prompt: one.prompt, options: one.options })),
  held: view.controls.includes(HOLD),
  note:
    view.parked ?? view.diagnostic ?? (view.status.status === "failed" ? view.status.reason : null),
  summary: view.status.status === "complete" ? view.status.value : null,
});

const Strings = Schema.Record(Schema.String, Schema.String);
const Kept = Schema.fromJsonString(
  Schema.Struct({
    sources: Schema.optional(Strings),
    strategies: Schema.optional(Strings),
  }),
);
const Evidence = Schema.fromJsonString(
  Schema.Struct({
    dir: Schema.String,
    mr: Schema.NullOr(Schema.String),
    worktree: Schema.optional(Schema.Unknown),
  }),
);
const decodeWorktree = Schema.decodeUnknownOption(WorktreeRecordSchema);
const decodeStrings = Schema.decodeUnknownOption(Schema.fromJsonString(Strings));
const decodeKept = Schema.decodeUnknownOption(Kept);
const decodeEvidence = Schema.decodeUnknownOption(Evidence);

/** What an imported Run ended as, in the words a live one uses. */
const importedState = (status: string): RunState =>
  status === "done" ? "succeeded" : status === "interrupted" ? "stopped" : "failed";

export const factsOfHistory = (stateDir: string, row: HistoryRow): RunFacts => {
  const kept = decodeKept(row.provenance);
  const inputs = decodeStrings(row.inputs);
  const evidence = decodeEvidence(row.evidence);
  const dir = evidence._tag === "Some" ? evidence.value.dir : runDir(stateDir, row.run);
  return {
    id: row.run,
    workflow: row.workflow,
    project: row.project,
    cwd: row.project,
    task: row.task,
    parent: row.parent,
    outcome: row.outcome,
    created: row.created,
    finished: row.finished,
    state: importedState(row.status),
    settled: {
      inputs: inputs._tag === "Some" ? inputs.value : {},
      strategies: kept._tag === "Some" ? (kept.value.strategies ?? {}) : {},
      sources: kept._tag === "Some" ? (kept.value.sources ?? {}) : {},
    },
    branch: null,
    mr: evidence._tag === "Some" ? evidence.value.mr : null,
    workspace: null,
    worktree:
      evidence._tag === "Some" && evidence.value.worktree !== undefined
        ? Option.getOrNull(decodeWorktree(evidence.value.worktree))
        : null,
    dir,
    // The old engine filed a Run's evidence inside its own directory.
    evidence: dir,
    imported: true,
    asking: [],
    held: false,
    note: null,
    summary: row.summary,
  };
};

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Every Run in this state directory, newest first: the host's and the imported ones. A
 * host that will not answer costs the caller the Runs, never the read it was part of.
 */
export const listRuns = Effect.fn("Runs.list")(function* (env: PluginEnv) {
  const live = yield* nativeRuns(env, null);
  const history = yield* nativeHistory(env, null);
  const runs = [
    ...live.runs.map((view) => factsOfView(env.stateDir, view)),
    ...history.rows.map((row) => factsOfHistory(env.stateDir, row)),
  ];
  return runs.sort((a, b) => b.created.localeCompare(a.created));
});

/** One Run by id, or null where there is none. */
export const findRun = (
  env: PluginEnv,
  id: string,
): Effect.Effect<RunFacts | null, never, Client> =>
  listRuns(env).pipe(Effect.map((runs) => runs.find((run) => run.id === id) ?? null));

/** Whether a Run has ended, which a question it is waiting on is not. */
export const settled = (run: Pick<RunFacts, "state">): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "stopped";
