// Every Run a reader can see, as one shape, from the host's rows.

import { Effect, Schema } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { PluginEnv } from "./env";
import { resultText, runViews } from "./lifecycle";
import { HOLD, STOP, evidenceDir, runDir, type RunView } from "./engine";
import type { Settled } from "./strategies";
import type { WorktreeRecord } from "./run";

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
  readonly asking: ReadonlyArray<Asked>;
  readonly held: boolean;
  /** Why it is not moving or why it ended, in its own words, where it said. */
  readonly note: string | null;
  readonly summary: string | null;
}

const isText = Schema.is(Schema.String);

const textOf = (value: Schema.Json): string => (isText(value) ? value : JSON.stringify(value));

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
    case "pending":
      return stopped ? "stopped" : "running";
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
  mr: view.mr,
  workspace: view.workspace,
  worktree: view.worktree,
  dir: runDir(stateDir, view.runId),
  evidence: evidenceDir(stateDir, view.runId),
  asking: view.waiting
    .filter((one) => one.answer === null)
    .map((one) => ({ name: one.name, prompt: one.prompt, options: one.options })),
  held: view.controls.includes(HOLD),
  note:
    view.parked ??
    (view.status.status === "failed"
      ? [view.status.reason, view.diagnostic].filter((part) => part !== null).join(" — ")
      : view.diagnostic),
  summary: view.status.status === "complete" ? resultText(view.status.value) : null,
});

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Every Run in this state directory, newest first. A host that will not answer costs the
 * caller the Runs, never the read it was part of.
 */
export const listRuns = Effect.fn("Runs.list")(function* (env: PluginEnv) {
  const live = yield* runViews(env, null);
  return live.runs
    .map((view) => factsOfView(env.stateDir, view))
    .sort((a, b) => b.created.localeCompare(a.created));
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
