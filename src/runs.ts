// Every Run a reader can see, as one shape, from the host's rows.

import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { RequestedBy, RunReport } from "./board-model";
import type { PluginEnv } from "./env";
import { resultText, runView, runViews } from "./lifecycle";
import { HOLD, STOP, evidenceDir, runDir, type RunView } from "./engine";
import type { Settled } from "./strategies";
import type { WorktreeRecord } from "./run";
import type { Landing } from "./landing";
import { awaitingLine, type Awaiting } from "./awaiting";
import type { AskedFact, Execution, UsageWait } from "./flow";

/** Where a Run is, in the words every board and listing uses. */
export type RunState = "running" | "waiting" | "succeeded" | "failed" | "stopped";

/** A question a Run is waiting on a human for. */
export interface Asked {
  readonly name: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
}

export interface RunFacts {
  readonly requestedBy?: RequestedBy;
  readonly report?: RunReport;
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
  /** Its landing of that merge request, which the merge watch spares it by. */
  readonly landing: Landing | null;
  /** A workspace of its own; null lives in its Task's. */
  readonly workspace: string | null;
  /** The checkout Collie made for it, which is what says it may take it away again. */
  readonly worktree: WorktreeRecord | null;
  /** Where what it produced is kept: its plan, review, cards, Intent and dispositions. */
  readonly dir: string;
  /** Where its verifications are kept. */
  readonly evidence: string;
  readonly asking: ReadonlyArray<Asked>;
  /** The questions it has been answered, oldest first. */
  readonly answered: ReadonlyArray<Asked & { readonly answer: string }>;
  readonly held: boolean;
  /** The repository of a fan-out this Run builds, or null for a Run that is no Repo run. */
  readonly repo: string | null;
  /** Why it parked its own work, in its own words, or null while it has not. */
  readonly parked: string | null;
  /** What it waits for that ends without anyone repairing anything, or null. */
  readonly awaiting: Awaiting | null;
  /** The Subscription its work waits on to reset, where it waits on one. */
  readonly usage?: UsageWait | null;
  /** Whether the engine could not be asked about it, so nothing drives it. */
  readonly undriven: boolean;
  /** Why it is not moving or why it ended, in its own words, where it said. */
  readonly note: string | null;
  readonly summary: string | null;
  /**
   * What the engine stored of its work: every question it asked, when it next wakes on a
   * durable timer, and where its execution is. Absent where it was not read from a view.
   */
  readonly engine?: {
    readonly questions: ReadonlyArray<AskedFact>;
    readonly wakes: string | null;
    readonly execution: Execution;
  };
}

const isText = Schema.is(Schema.String);

export const textOf = (value: Schema.Json): string =>
  isText(value) ? value : JSON.stringify(value);

const stateOf = (view: RunView): RunState => {
  const stopped = view.controls.includes(STOP);
  switch (view.status.status) {
    case "complete":
      return "succeeded";
    case "failed":
      return stopped ? "stopped" : "failed";
    // A stop suspends the Run; otherwise only a question or a parked Run is waiting.
    case "suspended":
      if (stopped) return "stopped";
      return view.parked !== null || view.waiting.some((one) => one.answer === null)
        ? "waiting"
        : "running";
    // Concurrent work can keep the Run pending while one Activity is parked.
    case "pending":
      if (stopped) return "stopped";
      return view.parked !== null ? "waiting" : "running";
  }
};

export const factsOfView = (stateDir: string, view: RunView): RunFacts => ({
  id: view.runId,
  requestedBy: view.requestedBy,
  report: view.report,
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
  mr: view.mr,
  landing: view.landing,
  workspace: view.workspace,
  worktree: view.worktree,
  dir: runDir(stateDir, view.runId),
  evidence: evidenceDir(stateDir, view.runId),
  asking: view.waiting
    .filter((one) => one.answer === null)
    .map((one) => ({ name: one.name, prompt: one.prompt, options: one.options })),
  answered: view.waiting.flatMap(({ name, prompt, options, answer }) =>
    answer === null ? [] : [{ name, prompt, options, answer }],
  ),
  held: view.controls.includes(HOLD),
  repo: view.options.repo ?? null,
  parked: view.parked,
  awaiting: view.awaiting,
  usage: view.usage ?? null,
  undriven: view.diagnostic !== null,
  note:
    view.parked ??
    (view.awaiting === null ? null : awaitingLine(view.awaiting)) ??
    (view.status.status === "failed"
      ? [view.status.reason, view.diagnostic].filter((part) => part !== null).join(" — ")
      : view.diagnostic),
  summary: view.status.status === "complete" ? resultText(view.status.value) : null,
  engine: {
    questions: view.waiting.map((one) => ({
      name: one.name,
      asked: one.asked ?? null,
      answered: one.answered ?? null,
      by: one.by ?? null,
      open: one.answer === null,
      text: one.prompt,
      options: one.options.map((value) => ({ id: value, title: value, subtitle: null })),
    })),
    wakes: view.wakes ?? null,
    execution: executionOf(view),
  },
});

const executionOf = (view: RunView): Execution => {
  if (view.controls.includes(STOP)) return "stopped";
  if (view.diagnostic !== null && view.status.status === "pending") return "died";
  switch (view.status.status) {
    case "pending":
      return "running";
    case "suspended":
      return "suspended";
    case "complete":
      return "completed";
    case "failed":
      return "failed";
  }
};

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Every Run in this state directory, newest first. A host that will not answer costs the
 * caller the Runs, never the read it was part of.
 */
export const listRuns = Effect.fn("Runs.list")(function* (env: PluginEnv) {
  const live = yield* runViews(env, null);
  return newestFirst(live.runs.map((view) => factsOfView(env.stateDir, view)));
});

export const newestFirst = (runs: ReadonlyArray<RunFacts>): RunFacts[] =>
  [...runs].sort((a, b) => b.created.localeCompare(a.created));

/** One Run by id, or null where there is none. */
export const findRun = (
  env: PluginEnv,
  id: string,
): Effect.Effect<RunFacts | null, never, Client> =>
  runView(env, id).pipe(
    Effect.map((view) => (view === null || "ok" in view ? null : factsOfView(env.stateDir, view))),
  );

/** Whether a Run has ended, which a question it is waiting on is not. */
export const settled = (run: Pick<RunFacts, "state">): boolean =>
  run.state === "succeeded" || run.state === "failed" || run.state === "stopped";

/** Where this Machine's live Runs work, or null where the host could not be asked. */
export const liveCheckouts = (
  env: PluginEnv,
): Effect.Effect<ReadonlyArray<string> | null, never, Client> =>
  runViews(env, null).pipe(
    Effect.map(({ runs, unreadable }) =>
      unreadable !== null
        ? null
        : runs
            .map((view) => factsOfView(env.stateDir, view))
            .filter((run) => !settled(run))
            .map((run) => run.cwd),
    ),
  );
