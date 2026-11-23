import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Option, Schema } from "effect";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type * as Types from "effect/Types";
import { boardOption, holdPath } from "./board-model";
import type { RequestedBy, RunReport, Solution } from "./board-model";
import type { PluginEnv } from "./env";
import type { Park } from "./park-cause";
import { resultText, runView, runViews } from "./lifecycle";
import { HOLD, STOP, evidenceDir, runDir } from "./engine";
import type { RunView } from "./engine";
import { isSetAside, isUnanswered } from "./store";
import type { Settled } from "./strategies";
import type { WorktreeRecord } from "./run";
import type { Landing } from "./landing";
import { awaitingLine } from "./awaiting";
import type { Awaiting } from "./awaiting";
import type { AskedFact, Execution, UsageWait } from "./flow";
import type { ShippingGo } from "./shipping";
import type { NarrativeReport } from "./narrative-model";
import { stringifyJson } from "./json";

export type RunState = "running" | "waiting" | "succeeded" | "ended" | "failed" | "stopped";

export interface Asked {
  readonly shipping?: ShippingGo;
  readonly name: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<Solution>;
  readonly hold?: { readonly offered: boolean; readonly why: string | null };
  readonly shortfall?: string;
  readonly steer?: string;
}

export interface RunFacts {
  readonly narratives?: ReadonlyArray<NarrativeReport>;
  readonly requestedBy?: RequestedBy;
  readonly report?: RunReport;
  readonly id: string;
  readonly workflow: string;
  readonly project: string;
  readonly cwd: string;
  readonly task: string | null;
  readonly parent: string | null;
  readonly outcome: string;
  readonly created: string;
  readonly finished: string | null;
  readonly state: RunState;
  readonly settled: Settled;
  readonly branch: string | null;
  readonly mr: string | null;
  readonly landing: Landing | null;
  readonly workspace: string | null;
  readonly worktree: WorktreeRecord | null;
  readonly dir: string;
  readonly evidence: string;
  readonly asking: ReadonlyArray<Asked>;
  readonly superseding?: ReadonlyArray<string>;
  readonly answered: ReadonlyArray<Asked & { readonly answer: string }>;
  readonly held: boolean;
  readonly repo: string | null;
  readonly change?: string | null;
  readonly parked: string | null;
  readonly recovery?: ReadonlyArray<string>;
  readonly park?: Park | null;
  readonly awaiting: Awaiting | null;
  readonly usage?: UsageWait | null;
  readonly undriven: boolean;
  readonly note: string | null;
  readonly summary: string | null;
  readonly engine?: {
    readonly questions: ReadonlyArray<AskedFact>;
    readonly wakes: string | null;
    readonly execution: Execution;
  };
}

const isText = Schema.is(Schema.String);

export const textOf: (value: Schema.Json) => string = (value) =>
  isText(value) ? value : stringifyJson(value);

const stateOf: (view: RunView) => RunState = (view) => {
  const stopped = view.controls.includes(STOP);
  switch (view.status.status) {
    case "ended":
      return "ended";
    case "complete":
      return "succeeded";
    case "failed":
      return stopped ? "stopped" : "failed";
    // WARNING: a stop suspends the Run; otherwise only a question or a parked Run is waiting.
    case "suspended":
      if (stopped) return "stopped";
      return view.parked !== null || Arr.some(view.waiting, isUnanswered) ? "waiting" : "running";
    // WARNING: concurrent work can keep the Run pending while one Activity is parked.
    case "pending":
      if (stopped) return "stopped";
      return view.parked !== null ? "waiting" : "running";
  }
};

export const factsOfView: (stateDir: string, view: RunView) => RunFacts = (stateDir, view) => ({
  narratives: view.narratives,
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
  finished: view.status.status === "ended" ? view.status.at : null,
  state: stateOf(view),
  settled: {
    inputs: Rec.fromEntries(
      Arr.map(Rec.toEntries(view.input), ([name, value]) => [name, textOf(value)] as const),
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
  asking: Arr.map(
    Arr.filter(view.waiting, (one) => isAsking(view, one)),
    (one) => {
      const asked: Types.Mutable<Asked> = {
        name: one.name,
        prompt: one.prompt,
        options: one.options,
      };
      const hold = holdPath(one, view.controls.includes(HOLD));
      if (hold !== undefined) asked.hold = hold;
      if (one.shortfall != null) asked.shortfall = one.shortfall;
      if (one.shipping != null) asked.shipping = one.shipping;
      if (one.steer != null) asked.steer = one.steer;
      return asked;
    },
  ),
  superseding:
    Option.getOrUndefined(Arr.findLast(view.waiting, (one) => isSetAside(view.waiting, one)))
      ?.messaged ?? [],
  answered: Arr.flatMap(view.waiting, ({ name, prompt, options, answer }) =>
    answer === null ? [] : [{ name, prompt, options, answer }],
  ),
  held: view.controls.includes(HOLD),
  repo: view.options.repo ?? null,
  change: view.options.change ?? null,
  parked: view.parked,
  recovery: view.recovery ?? [],
  park: view.park ?? null,
  awaiting: view.awaiting,
  usage: view.usage ?? null,
  undriven: view.diagnostic !== null,
  note:
    view.parked ??
    (view.awaiting === null ? null : awaitingLine(view.awaiting)) ??
    (view.status.status === "ended"
      ? "Ended; outcome unavailable without its terminal result"
      : view.status.status === "failed"
        ? Arr.join(
            Arr.filter([view.status.reason, view.diagnostic], (part) => part !== null),
            " — ",
          )
        : view.diagnostic),
  summary: view.status.status === "complete" ? resultText(view.status.value) : null,
  engine: {
    questions: Arr.map(view.waiting, (one) => ({
      name: one.name,
      asked: one.asked ?? null,
      answered: one.answered ?? null,
      by: one.by ?? null,
      open: isAsking(view, one),
      superseded: isSetAside(view.waiting, one),
      text: one.prompt,
      options: Arr.map(one.options, boardOption),
    })),
    wakes: view.wakes ?? null,
    execution: executionOf(view),
  },
});

// WARNING: a stop leaves the question open in the engine for a resume, so an ended Run asks only through its agent.
const isAsking: (view: RunView, one: RunView["waiting"][number]) => boolean = (view, one) => {
  const state = stateOf(view);
  return isUnanswered(one) && (!settled({ state }) || (one.asker != null && state !== "stopped"));
};

const executionOf: (view: RunView) => Execution = (view) => {
  if (view.controls.includes(STOP)) return "stopped";
  if (view.diagnostic !== null && view.status.status === "pending") return "died";
  switch (view.status.status) {
    case "pending":
      return "running";
    case "suspended":
      return "suspended";
    case "complete":
    case "ended":
      return "completed";
    case "failed":
      return "failed";
  }
};

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

// WARNING: a host that will not answer costs the caller its Runs, never the whole read.
export const listRuns = Effect.fn("Runs.list")(function* (env: PluginEnv) {
  const live = yield* runViews(env, null);
  return newestFirst(Arr.map(live.runs, (view) => factsOfView(env.stateDir, view)));
});

export const newestFirst: (runs: ReadonlyArray<RunFacts>) => Array<RunFacts> = (runs) =>
  [...runs].sort((a, b) => pipe_(b.created, Str.localeCompare(a.created)));

export const findRun: (
  env: PluginEnv,
  id: string,
) => Effect.Effect<RunFacts | null, never, Client> = (env, id) =>
  runView(env, id).pipe(
    Effect.map((view) => (view === null || "ok" in view ? null : factsOfView(env.stateDir, view))),
  );

export const settled: (run: Pick<RunFacts, "state">) => boolean = (run) =>
  run.state === "succeeded" ||
  run.state === "ended" ||
  run.state === "failed" ||
  run.state === "stopped";

export const liveCheckouts: (
  env: PluginEnv,
) => Effect.Effect<ReadonlyArray<string> | null, never, Client> = (env) =>
  runViews(env, null).pipe(
    Effect.map(({ runs, unreadable }) =>
      unreadable !== null
        ? null
        : Arr.map(
            Arr.filter(
              Arr.map(runs, (view) => factsOfView(env.stateDir, view)),
              (run) => !settled(run),
            ),
            (run) => run.cwd,
          ),
    ),
  );
