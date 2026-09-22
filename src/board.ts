// The board's own model: one TaskView per Task, and one per Run belonging to no Task.
//
// Read-only and derived: nothing here writes or infers what the files do not say. What
// became of a Run's work is the disposition's answer alone — a finished Run with a merge
// request has not been merged by anyone.

import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { openReports, readDrift } from "./drift";
import { describeAction } from "./lines";
import type { PickItem } from "./inputs";
import { LEADING_GLYPH, type AgentInfo } from "./herdr";
import { latest, readDispositions } from "./disposition";
import { displayName, oneLine, runLabel } from "./naming";
import { planIssuesIn } from "./plan";
import { diffTargetOf, recorded, workSourceOf } from "./strategies";
import { pendingFor, proposalsPath, read as readProposals, type ProposalLine } from "./proposals";
import {
  fanoutRepos,
  needsHuman,
  RunStore,
  type Run,
  type RunRecord,
  type StepStatus,
} from "./run";
import { herdOf } from "./steering";
import { listTasks, type TaskRecord } from "./task";
import { ago, agoShort, atClock, spanned } from "./time";
import { readVerifications, type Verification } from "./verify";
import { runStatus } from "./operations";
import { readMrStates } from "./merges";
import { filed, standingOf } from "./standing";

/** How a card reads, and the order Tasks take inside a section. */
export type TaskState =
  | "blocked"
  | "active"
  | "quiet"
  | "failed"
  | "stopped"
  | "abandoned"
  | "done";
const STATE_ORDER: ReadonlyArray<TaskState> = [
  "blocked",
  "active",
  "quiet",
  "failed",
  "stopped",
  "abandoned",
  "done",
];

/** Where a Task is in its pipeline, one glyph per step. */
export type StepState = "done" | "active" | "blocked" | "failed" | "todo";

/** The character each state is drawn as, wherever it is drawn. The colour is the pane's. */
export const GLYPH_FOR: Readonly<Record<TaskState, string>> = {
  blocked: "◆",
  active: "●",
  quiet: "●",
  failed: "✗",
  stopped: "■",
  abandoned: "■",
  done: "✓",
};

export const STEP_GLYPH_FOR: Readonly<Record<StepState, string>> = {
  done: "✓",
  active: "●",
  blocked: "◆",
  failed: "✗",
  todo: "○",
};

/**
 * A question put to the human, as every board renders one: the menu of a Choice, the
 * free text of an ask, or the list a gate holds work against. The shape the rows and the
 * drawer both draw, wherever the question came from.
 */
export interface PendingChoice {
  id: string;
  kind: "menu" | "ask" | "gate";
  run: string;
  step: string;
  header: string;
  footer: string;
  items: readonly PickItem[];
  /** A gate's list: the verifications this Run would be held to. */
  verifications?: readonly string[];
}

export interface BoardStep {
  name: string;
  state: StepState;
}

/** A question a Run's Driver is holding open, with the options to answer it with. */
export interface Question {
  kind: "question";
  run: string;
  /** The Choice id an answer names, so a question replaced meanwhile is not answered. */
  id: string;
  step: string;
  /** What the answer is about, for the sentence. */
  topic: string;
  text: string;
  /** Empty for a question typed into rather than picked from. */
  options: ReadonlyArray<{ id: string; title: string; subtitle: string | null }>;
}

/** A correction Collie proposes, which only a human may confirm. */
export interface Proposal {
  kind: "proposal";
  id: string;
  /** The payload a yes names exactly; a changed action hashes differently. */
  hash: string;
  text: string;
  actions: ReadonlyArray<{ text: string; allowed: boolean }>;
}

/** An evidence gate a Run is holding at until the verification list is approved. */
export interface Gate {
  kind: "gate";
  run: string;
  id: string;
  step: string;
  verifications: ReadonlyArray<string>;
}

export type Decision = Question | Proposal | Gate;

/** One live agent of the Task, as a card counts them and a search matches them. */
export interface BoardAgent {
  /** herdr's own name for it, which carries the role it was started as. */
  name: string;
  status: string;
  /** What it says it is doing, from its pane's title, or null where it publishes none. */
  now: string | null;
  run: string;
}

/** One repository of a plan that spans several, and what became of its Run. */
export interface BoardChild {
  repo: string;
  /** Null for a repository the fan-out never got to. */
  run: string | null;
  state: StepState;
  mr: string | null;
}

/** One Task as the board draws it. */
export interface TaskView {
  /** The Task's id, or the Run's own where it belongs to no Task. */
  id: string;
  name: string;
  project: string;
  state: TaskState;
  steps: ReadonlyArray<BoardStep>;
  sentence: string;
  age: string;
  /** What drifted, in one line, or null where nothing has. */
  drift: string | null;
  /** `⏸ Held until 14:00.`, or null while nothing is holding it. */
  held: string | null;
  /** Who asked for the hold and why, which the drawer says and the card does not. */
  heldBy: { by: string; reason: string } | null;
  decision: Decision | null;
  agents: ReadonlyArray<BoardAgent>;
  children: ReadonlyArray<BoardChild>;
  mr: string | null;
  branch: string | null;
  /** What became of the work, where someone recorded it. */
  disposition: string | null;
  /**
   * Whether the work needs nothing more from anyone: a disposition was recorded, or the
   * Run succeeded at a Workflow that produces nothing to land. Places the card in
   * Finished rather than Waiting on you.
   */
  landed: boolean;
  /** When the leading Run ended, or null while it has not. Orders Waiting on you. */
  ended: number | null;
  /** What GitLab last said about the merge request, where Collie has asked. */
  mrState: MrState | null;
  /** A plan that finished and nobody has implemented: its card's first action starts that. */
  planReady: boolean;
  /** The Run a card's actions act on: the one the sentence is about. */
  run: string;
  /** Every Run of this Task, newest first, for the drawer. */
  runs: ReadonlyArray<string>;
  /** When this Task last changed, in epoch milliseconds, which is what orders the board. */
  at: number;
}

/** `on-stage` and `in-prod` are merged too: the furthest its deploy jobs have taken it. */
export type MrState = "open" | "merged" | "closed" | "on-stage" | "in-prod";
const LANDED_STATES: ReadonlySet<MrState> = new Set(["merged", "on-stage", "in-prod"]);
const DEPLOYED = { "on-stage": " On stage.", "in-prod": " In production." } as const;

/** Everything the sentence is made of, apart from the TaskView so the formatter is pure. */
export interface Sentence {
  state: TaskState;
  decision: Decision | null;
  /** The step the work is on, and which round of the loop it is in. */
  step: { id: string; round: { at: number; of: number } | null } | null;
  /** The step's own verb, where the definition gives one. */
  verb: string | null;
  /** How long it has written nothing, where it has gone quiet. */
  silent: string | null;
  /** How long ago its Driver died, for a Run nothing drives and no agent works on. */
  abandoned: string | null;
  /** A plan that finished and has not been implemented: work waiting to be started. */
  planReady: boolean;
  mrState: MrState | null;
  wave: {
    at: number;
    of: number;
    landed: ReadonlyArray<string>;
    building: ReadonlyArray<string>;
    /** A repository whose Run stopped the waves, which is not "next" and not building. */
    stopped: ReadonlyArray<string>;
    next: ReadonlyArray<string>;
  } | null;
  /** The verification that stopped it, and how many times in a row it failed. */
  failure: { name: string; times: number } | null;
  /** Why it stopped, where no verification says. */
  note: string | null;
  /** The answer the work carried on with. */
  resumed: string | null;
  disposition: { kind: string; ref: string; ago: string; by: string } | null;
  /** The merge request the work opened or was pointed at, where there is one. */
  mr: string | null;
  /**
   * Where a human is being waited for, when no Decision says: the pane of the agent
   * herdr will not prompt, or the step the Driver recorded itself waiting on. Null
   * when nothing is waiting — or when nothing named which pane it is in.
   */
  stalled: string | null;
}

/** What a step is doing, for every step whose definition names no `summary` of its own. */
const VERBS = new Map(
  Object.entries({
    grill: "Working out what you want",
    spec: "Writing the spec",
    tickets: "Cutting the plan into tickets",
    build: "Building",
    fix: "Fixing the review findings",
    review: "Reviewing",
    synthesize: "Reconciling the reviews",
    post: "Posting the review",
    mr: "Opening the merge request",
    next: "Deciding what happens next",
    architecture: "Reading the architecture",
    track: "Tracking the update branches",
    assess: "Assessing the updates",
    merge: "Merging what passed",
    release: "Cutting the release",
    record: "Recording what happened",
  }),
);

/** An embedded workflow's step is that workflow's: `review.synthesize` is a synthesis. */
function verbOf(facts: Sentence): string {
  if (facts.verb !== null) return facts.verb;
  if (facts.step === null) return "Starting";
  const id = facts.step.id;
  const kind = id.slice(id.lastIndexOf(".") + 1);
  // Never the step id: a card says what is happening in words.
  return VERBS.get(kind) ?? "Working on it";
}

function roundOf(step: Sentence["step"]): string {
  return step?.round ? `, round ${step.round.at} of ${step.round.of}` : "";
}

/** `2 times` reads as a count; twice reads as a sentence. */
function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

function clause(repos: ReadonlyArray<string>, singular: string, plural: string): string[] {
  if (repos.length === 0) return [];
  return [`${repos.join(", ")} ${repos.length === 1 ? singular : plural}`];
}

function waveSentence(wave: NonNullable<Sentence["wave"]>): string {
  const parts = [
    ...clause(wave.landed, "landed", "landed"),
    ...clause(wave.building, "is building", "are building"),
    ...clause(wave.stopped, "stopped", "stopped"),
    ...clause(wave.next, "is next", "are next"),
  ];
  const where = `Wave ${wave.at} of ${wave.of}.`;
  return parts.length === 0 ? where : `${where} ${parts.join(", ")}.`;
}

function decisionSentence(decision: Decision): string {
  switch (decision.kind) {
    case "question":
      return `Waiting on your answer about ${decision.topic}.`;
    case "proposal":
      return "Collie proposes a correction and waits for your yes.";
    case "gate":
      return `Holding at the ${decision.step} gate until you approve the list.`;
  }
}

function doneSentence(
  disposition: Sentence["disposition"],
  mr: string | null = null,
  mrState: MrState | null = null,
  planReady = false,
): string {
  if (disposition === null) {
    if (planReady) return "Plan ready to implement.";
    if (mr === null) return "Finished; nothing merged yet.";
    if (mrState === "closed") return `Merge request ${mrLabel(mr)} closed without merging.`;
    return `Finished; ${mrLabel(mr)} is open.`;
  }
  switch (disposition.kind) {
    case "merged": {
      const deployed = mrState === "on-stage" || mrState === "in-prod" ? DEPLOYED[mrState] : "";
      // GitLab's word carries no time of its own: the stamp is when Collie asked.
      if (disposition.by === "gitlab")
        return (disposition.ref === "" ? "Merged." : `Merged as ${disposition.ref}.`) + deployed;
      return (
        (disposition.ref === ""
          ? `Merged ${disposition.ago}.`
          : `Merged as ${disposition.ref} ${disposition.ago}.`) + deployed
      );
    }
    case "abandoned":
      return "Abandoned.";
    default:
      return disposition.ref === "" ? "Superseded." : `Superseded by ${disposition.ref}.`;
  }
}

function failedSentence(facts: Sentence): string {
  if (facts.failure !== null)
    return `Stopped after ${facts.failure.name} failed ${times(facts.failure.times)} in a row.`;
  return facts.note === null ? "Stopped without finishing." : `Stopped: ${facts.note}.`;
}

/**
 * A Task waiting on a human with nothing on the card to answer: the answer is in the
 * agent's own pane. Named, because "needs you" over four cards is four panes to find.
 */
function stalledSentence(facts: Sentence): string {
  return `Waiting for you in ${facts.stalled ?? "its pane"}.`;
}

function workingSentence(facts: Sentence): string {
  if (facts.resumed !== null) return `Resumed with “${facts.resumed}”.`;
  if (facts.wave !== null) {
    const wave = waveSentence(facts.wave);
    return facts.silent === null ? wave : `${wave} Silent for ${facts.silent}.`;
  }
  const doing = `${verbOf(facts)}${roundOf(facts.step)}`;
  return facts.silent === null ? `${doing}.` : `${doing}, but silent for ${facts.silent}.`;
}

/**
 * One plain sentence about a Task: no step names or glyph codes, only round counts and
 * merge-request references. A pending decision outranks every other state, because it is
 * the one where nothing moves until someone answers.
 */
export function sentenceFor(facts: Sentence): string {
  if (facts.decision !== null) return decisionSentence(facts.decision);
  switch (facts.state) {
    case "done":
      return doneSentence(facts.disposition, facts.mr, facts.mrState, facts.planReady);
    case "failed":
      return alsoBecame(failedSentence(facts), facts.disposition);
    case "stopped":
      return alsoBecame("Stopped by you.", facts.disposition);
    case "abandoned":
      return alsoBecame(`Its Driver died ${facts.abandoned ?? "a while ago"}.`, facts.disposition);
    // Only reachable with no Decision: one above would have answered already.
    case "blocked":
      return stalledSentence(facts);
    default:
      return workingSentence(facts);
  }
}

/**
 * What became of the work, after how the Run ended. Both, because a disposition is
 * recorded beside a status and never over it: a Run that failed and whose branch someone
 * merged by hand did both, and a card that said only the first would be hiding the second.
 */
function alsoBecame(sentence: string, disposition: Sentence["disposition"]): string {
  return disposition === null ? sentence : `${sentence} ${doneSentence(disposition)}`;
}

/** `group/project!42` from a GitLab URL or an `mr:` target; anything else as it is. */
export function mrLabel(mr: string): string {
  const url = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(mr);
  if (url) return `${url[1]}!${url[2]}`;
  const bare = mr.startsWith("mr:") ? mr.slice(3) : mr;
  // `host/group/project!42` reads as `group/project!42`: the host is where, not what.
  const host = /^[^/!]+\.[^/!]+\/(.+)$/.exec(bare);
  return host ? host[1]! : bare;
}

/** The second line a held Task carries, under its sentence. */
export function heldLine(until: string | null): string {
  return until === null ? "⏸ Held." : `⏸ Held until ${until}.`;
}

/**
 * Which of the board's four sections a Task belongs in. A decision beats liveness,
 * liveness beats history, and history is split by whether the work landed.
 */
export type Section = "needs-you" | "working" | "waiting" | "finished";

export function sectionOf(view: Pick<TaskView, "state" | "landed">): Section {
  // Read off the state alone, because a Decision is not the only way to stop for a
  // human: an agent at its harness's own dialog is one too, and a section derived from
  // the Decision could not see it. `stateOf` is where the two become one word.
  if (view.state === "blocked") return "needs-you";
  if (view.state === "active" || view.state === "quiet") return "working";
  return view.landed ? "finished" : "waiting";
}

const SECTION_ORDER = new Map<Section, number>([
  ["needs-you", 0],
  ["working", 1],
  ["waiting", 2],
  ["finished", 3],
]);
const STATE_RANK = new Map(STATE_ORDER.map((state, at) => [state, at]));

/**
 * The board's order: the three sections, then the state order inside each, then whatever
 * changed last. Nothing else is ranked — a board that reordered itself on every tick is
 * one a human cannot point at.
 */
export function sortBoard(views: ReadonlyArray<TaskView>): TaskView[] {
  return [...views].sort(
    (a, b) =>
      SECTION_ORDER.get(sectionOf(a))! - SECTION_ORDER.get(sectionOf(b))! ||
      (sectionOf(a) === "needs-you" ? STATE_RANK.get(a.state)! - STATE_RANK.get(b.state)! : 0) ||
      // What moved last is at the top: in Working what is doing something, in Waiting on
      // you what you were just doing.
      (b.ended ?? b.at) - (a.ended ?? a.at),
  );
}

const STEP_STATE: Readonly<Record<StepStatus, StepState>> = {
  pending: "todo",
  running: "active",
  done: "done",
  blocked: "blocked",
  failed: "failed",
};

/** The step a decision is holding, where the decision names one. */
function blockedStep(decision: Decision | null): string | null {
  return decision === null || decision.kind === "proposal" ? null : decision.step;
}

/**
 * The Task's pipeline across its Runs, in the order it went through them, each step with
 * the state its newest Run left it in. A step that loops shows once: the record keeps one
 * entry per step whatever round it last ran in, and a Task that re-ran a step keeps the
 * place that step first took.
 */
function stepsOf(runs: ReadonlyArray<Run>, decision: Decision | null): BoardStep[] {
  const states = new Map<string, StepState>();
  for (const run of [...runs].reverse()) {
    for (const step of run.record.steps) states.set(step.id, STEP_STATE[step.status]);
  }
  const holding = blockedStep(decision);
  return [...states].map(([name, state]) => ({
    name,
    state: name === holding ? "blocked" : state,
  }));
}

/** The step whichever Run of this Task stopped on for a human, or null when none did. */
function stepAwaited(records: ReadonlyArray<RunRecord>): string | null {
  const step = records.find(needsHuman)?.awaiting ?? null;
  return step === null ? null : `the ${step} step`;
}

/** What a Run is, in the board's words. A decision outranks whatever it was doing. */
function stateOf(
  status: string,
  silent: boolean,
  decision: Decision | null,
  abandoned: boolean,
  /** Something is waiting for the human in a pane, with no Decision to say so. */
  stalled: boolean,
): TaskState {
  if (decision !== null) return "blocked";
  if (abandoned) return "abandoned";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (status === "succeeded") return "done";
  // Under the endings, because only a Run still going can be waiting for anyone: a Run
  // someone stopped while its agent sat at a prompt was stopped, and says so.
  if (stalled) return "blocked";
  return silent ? "quiet" : "active";
}

/** What the frozen definition says this step is doing, where it said anything. */
function verbFrom(record: RunRecord): string | null {
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  return step?.summary ?? null;
}

/** The step the work is on, and which round of the loop it is in. */
function stepNow(record: RunRecord): Sentence["step"] {
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  if (!step) return null;
  return {
    id: step.id,
    round: step.iteration > 1 ? { at: step.iteration, of: record.max_iterations } : null,
  };
}

/**
 * The answer the work carried on with, where it has not moved past the step that asked.
 * Only what the record keeps: a Choice's title. A Run that has gone on to the next step
 * is doing that step, not still resuming.
 */
function resumedWith(record: RunRecord): string | null {
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  if (!step) return null;
  return [...record.choices].reverse().find((c) => c.step === step.id)?.title ?? null;
}

/** Why a Run stopped, in its own words, where no verification explains it. */
function noteOf(record: RunRecord): string | null {
  if (record.obstacle !== null) return record.obstacle;
  return record.steps.filter((s) => s.note && s.status !== "done").at(-1)?.note ?? null;
}

/**
 * The verification that stopped a Run, and how many times in a row it failed. The trailing
 * run of failures of the newest failing check: a check that failed, was fixed and failed
 * again is not failing "three times in a row".
 */
export function lastFailure(
  records: ReadonlyArray<Verification>,
): { name: string; times: number } | null {
  const last = records.at(-1);
  if (last === undefined || last.result !== "fail") return null;
  let times = 0;
  for (const record of [...records].reverse()) {
    if (record.name !== last.name) continue;
    if (record.result !== "fail") break;
    times += 1;
  }
  return { name: last.name, times };
}

/** What the Task is called, and whose project it is: the workspace label's two halves. */
/** An absolute path, wherever one sits in a name, read as what it points at. */
function withoutPaths(text: string): string {
  return text.replace(/(?:^|\s)\/(?:[^\s/]+\/)+([^\s/]+)/g, (whole, last: string) =>
    whole.startsWith(" ") ? ` ${last}` : last,
  );
}

function namesOf(label: string, record: RunRecord) {
  const clean = withoutPaths(label.replace(LEADING_GLYPH, "").trim());
  const at = clean.indexOf(" | ");
  if (at >= 0) return { project: clean.slice(0, at), name: clean.slice(at + 3) };
  // No task workspace to take a name from: the workspace names the project, and the Run
  // names itself — by the plan directory's own name where an older Run was named after
  // its whole path, and never the same words twice.
  const name = withoutPaths(legacyPlanName(record) ?? pathNamed(record) ?? runLabel(record));
  // A workspace that was named after the Run says nothing the card does not: the checkout
  // names the project then.
  const named = clean === "" || clean === name || clean === runLabel(record);
  // A project the name already says is said once: `Renovate · api` needs no `api` after it.
  const project = named ? basename(record.cwd) : name.includes(clean) ? "" : clean;
  return { project, name };
}

function legacyPlanName(record: RunRecord): string | null {
  const work = workSourceOf(recorded(record));
  if (record.named_after !== null || work?.kind !== "plan-dir") return null;
  return `${displayName(record.workflow)} · ${basename(work.value)}`;
}

/** A Run named after a checkout's path — a renovate Run — is named after the checkout. */
function pathNamed(record: RunRecord): string | null {
  const after = record.named_after;
  if (after === null || !after.startsWith("/")) return null;
  return `${displayName(record.workflow)} · ${basename(after)}`;
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) ?? path;
}

/** Which repositories a plan that spans several has landed, is building, and has left. */
function waveOf(record: RunRecord, children: ReadonlyArray<BoardChild>): Sentence["wave"] {
  const fan = record.fanout;
  if (fan === null || fan.wave === 0) return null;
  const repos = (state: StepState) =>
    children.filter((child) => child.state === state).map((child) => child.repo);
  return {
    at: fan.wave,
    of: fan.waves.length,
    landed: repos("done"),
    building: [...repos("active"), ...repos("blocked")],
    next: repos("todo"),
    stopped: repos("failed"),
  };
}

function childrenOf(record: RunRecord, states: ReadonlyMap<string, StepState>): BoardChild[] {
  const fan = record.fanout;
  if (fan === null) return [];
  return fanoutRepos(fan).map((entry) => ({
    repo: entry.repo,
    run: entry.run,
    state: entry.run === null ? "todo" : (states.get(entry.run) ?? "todo"),
    mr: entry.mr,
  }));
}

/**
 * The Task's agents herdr still has. One entry per live agent, however many steps of
 * however many Runs it worked on: a card counts agents, not the steps they took.
 */
function agentsOf(runs: ReadonlyArray<Run>, live: ReadonlyMap<string, AgentInfo>): BoardAgent[] {
  const found = new Map<string, BoardAgent>();
  for (const run of runs) {
    for (const step of run.record.steps) {
      for (const variant of step.variants) {
        const agent = live.get(variant.agent);
        if (agent === undefined || found.has(agent.name)) continue;
        found.set(agent.name, {
          name: agent.name,
          status: agent.status,
          now: agent.title,
          run: run.id,
        });
      }
    }
  }
  return [...found.values()];
}

/** The Run a card is about: the newest still going, else the newest. */
function leaderOf(runs: ReadonlyArray<Run>): Run {
  return runs.find((run) => run.record.status === "running") ?? runs[0]!;
}

/** How long finished work stays on the board. A day, so an evening's work is still there
    in the morning — midnight is not when a human stops calling it today. */
const FINISHED_FOR_MS = 24 * 60 * 60 * 1000;

const SETTLED: ReadonlySet<string> = new Set(["succeeded", "failed", "stopped"]);

/** How long a `running` Run with no Driver and no agent has to have been silent. */
const ABANDONED_MS = 60_000;

/** Waiting on you shows a week open; what is older folds into one counted line. */
export const WAIT_FOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When the Run last did anything, as `touchedDirAt` measures it but without the one file
 * Collie writes about a Run from outside: a disposition recorded by a human or by the
 * merge watch is bookkeeping, and must not make a dead Run look alive for another minute.
 */
const lastActivityAt = Effect.fn("Board.lastActivityAt")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((stat) => (Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0)),
      Effect.catch(() => Effect.succeed(0)),
    );
  let newest = 0;
  for (const name of yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])))) {
    if (name !== "steering") {
      newest = Math.max(newest, yield* at(path.join(dir, name)));
      continue;
    }
    const inside = yield* fs
      .readDirectory(path.join(dir, name))
      .pipe(Effect.catch(() => Effect.succeed([])));
    for (const entry of inside) {
      if (entry === "disposition.jsonl") continue;
      newest = Math.max(newest, yield* at(path.join(dir, name, entry)));
    }
  }
  return newest;
});

/** The checkout's branch, or null: a record written before the Run had one says "". */
function branchOf(run: Run): string | null {
  const branch = run.record.worktree?.branch ?? null;
  return branch === null || branch === "" ? null : branch;
}

/** The merge request this Run opened, or the one it was pointed at; null for neither. */
function mrOf(run: Run): string | null {
  const target = diffTargetOf(recorded(run.record))?.value ?? null;
  return run.record.mr_url ?? (isMrTarget(target) ? target : null);
}

/** Whether this Run left anything anyone has to file, read from the Run and not its name. */
const filedBy = Effect.fn("Board.filedBy")(function* (run: Run) {
  return filed({
    branch: branchOf(run),
    mr: mrOf(run),
    planIssues: yield* planIssuesIn(run.dir),
  });
});

/**
 * Whether settled Runs' work landed, from the record: a disposition, or nothing that
 * anyone has to file in the first place.
 */
const landedByRecord = Effect.fn("Board.landedByRecord")(function* (runs: ReadonlyArray<Run>) {
  for (const run of runs) {
    if (!(yield* filedBy(run))) continue;
    const seen = latest(
      yield* readDispositions(run.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    if (seen === null) return false;
  }
  return true;
});

/** When the newest of these Runs last did anything, from the record alone. */
function lastTouched(runs: ReadonlyArray<Run>): number {
  const stamps = runs
    .map((run) => Date.parse(run.record.finished_at ?? run.record.created_at))
    .filter(Number.isFinite);
  return stamps.length === 0 ? 0 : Math.max(...stamps);
}

const isMrTarget = (target: string | null): target is string =>
  target !== null && target.startsWith("mr:");

/** The Runs a fan-out of this one started, as Runs: a plan's card speaks for them. */
function childRuns(run: Run, byId: ReadonlyMap<string, Run>): Run[] {
  const fan = run.record.fanout;
  if (fan === null) return [];
  return fanoutRepos(fan).flatMap((entry) => {
    const found = entry.run === null ? undefined : byId.get(entry.run);
    return found === undefined ? [] : [found];
  });
}

function asProposal(line: Extract<ProposalLine, { kind: "proposal" }>): Proposal {
  return {
    kind: "proposal",
    id: line.id,
    hash: line.content_hash,
    text: line.interpretation,
    actions: line.actions.map((action, at) => ({
      text: describeAction(action),
      allowed: line.allowed_now.includes(at),
    })),
  };
}

/** The Herd's proposals journal, or none where there is no herdr to name the Herd. */
const proposalsOf = Effect.fn("Board.proposalsOf")(function* (
  stateDir: string,
  socketPath: string | null,
) {
  const key = yield* herdOf(socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return [];
  return yield* readProposals(yield* proposalsPath(stateDir, key));
});

/** How long a Run has been going by default before silence is worth saying. */
const DEFAULT_QUIET_MS = 5 * 60_000;

/**
 * Every Task on the Herd's board, Herd-wide, in the order the board draws them.
 *
 * Herd-wide on purpose: the board is one board per Herd (ADR-0009), and a workspace is a
 * filter over it rather than a board of its own. The Runs a fan-out started are not Tasks
 * of their own here — they are the children of the plan that spans them, which is what
 * makes a multi-repository plan one card.
 */
export const buildBoard = Effect.fn("Board.build")(function* (opts: {
  stateDir: string;
  /** The Herd's socket, for its proposals journal; null where there is no herdr to ask. */
  socketPath?: string | null;
  /** What herdr says is alive, so a card can say who is on it. */
  alive?: ReadonlyArray<AgentInfo>;
  /** The Runs and Tasks already read, so a caller drawing two views scans the dir once. */
  runs?: ReadonlyArray<Run>;
  tasks?: ReadonlyArray<TaskRecord>;
  proposals?: ReadonlyArray<ProposalLine>;
  now?: number;
  /** How long a Run may write nothing before its card says it has gone quiet. */
  quietMs?: number;
  /** The Runs whose Driver a caller already knows to be live; else each is asked. */
  driversLive?: ReadonlySet<string>;
  /** What GitLab last said about each merge request, by the reference the card carries. */
  mrStates?: ReadonlyMap<string, MrState>;
}) {
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const all = opts.runs ?? (yield* new RunStore(opts.stateDir).list());
  const tasks = new Map(
    (opts.tasks ?? (yield* listTasks(opts.stateDir))).map((task) => [task.id, task]),
  );
  const proposals = opts.proposals ?? (yield* proposalsOf(opts.stateDir, opts.socketPath ?? null));
  const mrStates = opts.mrStates ?? (yield* readMrStates(opts.stateDir));
  const live = new Map((opts.alive ?? []).map((agent) => [agent.name, agent]));

  // Every Run a fan-out started belongs to the plan that started it, not to the board.
  const fanned = new Set(
    all.flatMap((run) =>
      run.record.fanout === null
        ? []
        : fanoutRepos(run.record.fanout).flatMap((entry) => entry.run ?? []),
    ),
  );

  const statuses = new Map<string, string>();
  for (const run of all) statuses.set(run.id, yield* runStatus(run));

  const groups = new Map<string, Run[]>();
  for (const run of all) {
    if (fanned.has(run.id)) continue;
    const key = run.record.task ?? run.id;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  // A child's state, for the parent's own children list and its wave sentence.
  const childStates = new Map<string, StepState>();
  for (const run of all) {
    if (!fanned.has(run.id)) continue;
    const status = statuses.get(run.id)!;
    childStates.set(
      run.id,
      status === "succeeded"
        ? "done"
        : status === "running" || status === "waiting"
          ? "active"
          : status === "failed"
            ? "failed"
            : "todo",
    );
  }

  const byId = new Map(all.map((run) => [run.id, run]));

  const views: TaskView[] = [];
  for (const [id, runs] of groups) {
    // A repository run has no card of its own, so its decisions are the plan's.
    const spokenFor = [...runs, ...runs.flatMap((run) => childRuns(run, byId))];
    const pending = spokenFor.flatMap((run) => pendingFor(proposals, run.id, now));
    // Finished work older than a day is History's, behind `older…` — landed work only:
    // an unmerged branch from last week is still waiting on you, however old.
    if (
      runs.every((run) => SETTLED.has(statuses.get(run.id)!)) &&
      lastTouched(runs) < now - FINISHED_FOR_MS &&
      pending.length === 0 &&
      (yield* landedByRecord(runs))
    )
      continue;
    const leader = leaderOf(runs);
    const record = leader.record;
    const proposed = pending[0];
    const decision: Decision | null = proposed ? asProposal(proposed) : null;

    const status = statuses.get(leader.id)!;
    const touched = yield* lastActivityAt(leader.dir);
    // `waiting` is a Run whose Driver is at a question or a gate; it is going, and it is
    // as dead as a `running` one when nothing drives it.
    const going = status === "running" || status === "waiting";
    const silentFor = going && touched > 0 ? now - touched : 0;
    // Under a minute has no span to name, and is not silence worth a card saying.
    const span = silentFor > quietMs ? spanned(silentFor) : "";
    const silent = span === "" ? null : span;
    // A record that says `running` is a claim; a Driver that owns it or an agent herdr
    // still has is the proof. Neither, for over a minute, and the Run is Abandoned. Only
    // a Driver proven live counts: a claim whose pid answers but whose identity cannot be
    // read is, two weeks on, a pid the machine reused.
    const agentAlive = runs.some((run) =>
      run.record.steps.some((step) => step.variants.some((v) => live.has(v.agent))),
    );
    const driverLive = going && (opts.driversLive?.has(leader.id) ?? false);
    const abandoned = going && !driverLive && !agentAlive && silentFor > ABANDONED_MS;
    const agents = agentsOf(runs, live);
    // Stopped for a human with no Decision to answer. Two sources, because neither sees
    // the other: the Driver records `awaiting` when it is the one waiting, and herdr
    // reports `blocked` for an agent sitting at its harness's own dialog — a permission
    // prompt mid-step, which the Driver never learns about and writes no record for.
    // herdr's name for the pane first: it is the one a human has to go to.
    const blocked = agents.find((agent) => agent.status === "blocked");
    // No second check that a Driver is still there to consume the answer: `abandoned`
    // is this board's one verdict on that, with the grace a fresh or resumed Run is
    // owed, and `stateOf` already puts it above this. A stricter gate here would be the
    // same judgement made twice, to different thresholds.
    const stalled =
      (blocked ? `${blocked.name}'s pane` : null) ?? stepAwaited(runs.map((run) => run.record));
    const state = stateOf(status, silent !== null, decision, abandoned, stalled !== null);

    // Whichever Run of this Task is held: a Task is held when any of its Runs is.
    const holding = runs.find((run) => run.record.held !== null)?.record.held ?? null;
    const children = childrenOf(record, childStates);
    const settled =
      state === "done" || state === "failed" || state === "stopped" || state === "abandoned";
    // Read whatever the state: a merge GitLab reported lands the work even while the record
    // still calls the Run going, and the card must say so.
    const disposition = latest(
      yield* readDispositions(leader.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    const failure =
      state === "failed"
        ? lastFailure(
            yield* readVerifications(leader.dir).pipe(Effect.catch(() => Effect.succeed([]))),
          )
        : null;
    const open = openReports(
      yield* readDrift(leader.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    const task = record.task === null ? null : (tasks.get(record.task) ?? null);
    const { name, project } = namesOf(task?.label ?? record.workspace_label ?? "", record);
    const started = runs.map((run) => Date.parse(run.record.created_at)).filter(Number.isFinite);
    // A Task is as old as its first Run; a record with no readable stamp has no age.
    const first = started.length === 0 ? 0 : Math.min(...started);

    // What it opened, else what it was pointed at: `implement` produces one and
    // `review` is given one.
    const mr =
      runs.map((run) => run.record.mr_url).find((url) => url !== null) ??
      runs.map((run) => diffTargetOf(recorded(run.record))?.value ?? null).find(isMrTarget) ??
      null;
    const mrState = mr === null ? null : (mrStates.get(mrLabel(mr)) ?? null);
    const branch = runs.map(branchOf).find((b) => b !== null) ?? null;
    // What the Task left behind, and nothing about what ran it: the tickets are whichever
    // of its Runs wrote any, exactly as the branch and the merge request are.
    let issues = 0;
    for (const run of runs) issues = Math.max(issues, yield* planIssuesIn(run.dir));
    const { planReady, landed } = standingOf({
      settled,
      succeeded: status === "succeeded",
      branch,
      mr,
      mrLanded: mrState !== null && LANDED_STATES.has(mrState),
      planIssues: issues,
      disposed: disposition !== null,
      asking: decision !== null,
    });
    const ended =
      settled && leader.record.finished_at !== null
        ? Date.parse(leader.record.finished_at)
        : settled && touched > 0
          ? touched
          : null;
    views.push({
      id,
      name,
      project,
      state,
      steps: stepsOf(runs, decision),
      sentence: sentenceFor({
        mr,
        mrState,
        planReady,
        abandoned: abandoned ? `${spanned(now - touched)} ago` : null,
        state,
        decision,
        step: stepNow(record),
        verb: verbFrom(record),
        silent,
        wave: waveOf(record, children),
        failure,
        note: noteOf(record),
        resumed: resumedWith(record),
        stalled,
        disposition:
          disposition === null
            ? null
            : {
                kind: disposition.kind,
                // Recorded refs vary in shape; the card reads them all the one way.
                ref: disposition.ref === "" ? "" : mrLabel(disposition.ref),
                ago: ago(disposition.at, now),
                by: disposition.by,
              },
      }),
      age: agoShort(first, now),
      // The leading Run's own open drift: what an earlier Run of this Task drifted from
      // was judged against a tree that has moved since, and is its record, not this card's.
      drift:
        open.length === 0
          ? null
          : `${open[0]!.constraint}${open.length > 1 ? ` (and ${open.length - 1} more)` : ""}`,
      held:
        holding === null
          ? null
          : heldLine(holding.until === null ? null : atClock(holding.until, now)),
      heldBy: holding === null ? null : { by: holding.by, reason: holding.reason },
      decision,
      agents,
      children,
      mr,
      branch,
      disposition:
        disposition === null
          ? null
          : disposition.ref === ""
            ? disposition.kind
            : `${disposition.kind} ${disposition.ref}`,
      landed,
      ended,
      mrState,
      planReady,
      run: leader.id,
      runs: runs.map((run) => run.id),
      at: touched === 0 ? first : touched,
    });
  }
  return sortBoard(views);
});

export interface Sections {
  needs: TaskView[];
  working: TaskView[];
  waiting: TaskView[];
  finished: TaskView[];
}

/** Waiting on you, split at a week: what is older folds into one counted line. */
export function foldWaiting(waiting: ReadonlyArray<TaskView>, now: number) {
  const recent = waiting.filter((view) => (view.ended ?? view.at) >= now - WAIT_FOLD_MS);
  const older = waiting.filter((view) => (view.ended ?? view.at) < now - WAIT_FOLD_MS);
  return { recent, older };
}

/** What a search is matched against: what a human remembers about a Task, and no ids. */
function haystack(view: TaskView): string {
  return [
    view.name,
    view.project,
    view.branch ?? "",
    ...view.agents.flatMap((agent) => [agent.name, agent.now ?? ""]),
  ]
    .join(" ")
    .toLowerCase();
}

export function matchesTask(view: TaskView, query: string): boolean {
  const wanted = query.trim().toLowerCase();
  return wanted === "" || haystack(view).includes(wanted);
}

/**
 * The three sections, in the order the board draws them, from a list already in the
 * board's own order. The search narrows all three the same way: a Task hidden from one
 * section must not be visible in another.
 */
export function sectionsOf(views: ReadonlyArray<TaskView>, query: string): Sections {
  const found = views.filter((view) => matchesTask(view, query));
  return {
    needs: found.filter((view) => sectionOf(view) === "needs-you"),
    working: found.filter((view) => sectionOf(view) === "working"),
    waiting: found.filter((view) => sectionOf(view) === "waiting"),
    finished: found.filter((view) => sectionOf(view) === "finished"),
  };
}

/** The one sentence over the board, and whether anything in it wants a human. */
export interface HeaderSentence {
  text: string;
  urgent: boolean;
}

/**
 * Counted over every Task: a decision the search is hiding is still waiting. Waiting on
 * you counts the week's endings; what the fold holds is counted on the fold's own line,
 * because a header that says 56 over four cards worth a look reads as 56 obligations.
 */
export function headerSentence(views: ReadonlyArray<TaskView>, now?: number): HeaderSentence {
  const needs = views.filter((view) => sectionOf(view) === "needs-you").length;
  const working = views.filter((view) => sectionOf(view) === "working");
  const quiet = working.filter((view) => view.state === "quiet").length;
  const opening =
    needs === 0
      ? "Nothing needs you."
      : // Not "decisions": an agent at its harness's own dialog is counted here too, and
        // it is a pane to go to rather than anything this board can answer.
        `${needs === 1 ? "One task is" : `${needs} tasks are`} waiting on you.`;
  const gone = quiet === 0 ? "" : `, ${quiet} gone quiet`;
  const waitingAll = views.filter((view) => sectionOf(view) === "waiting");
  const waiting =
    now === undefined ? waitingAll.length : foldWaiting(waitingAll, now).recent.length;
  const held = waiting === 0 ? "" : ` ${waiting} waiting on you.`;
  return { text: `${opening} ${working.length} working${gone}.${held}`, urgent: needs > 0 };
}

export function waitingLabel(waiting: ReadonlyArray<TaskView>): string {
  return `Waiting on you · ${waiting.length}`;
}

export function workingLabel(working: ReadonlyArray<TaskView>): string {
  return `Working · ${working.length}`;
}

/**
 * Finished, as one line until it is opened. Closed it says what the day came to; open it
 * is a section label like the other two.
 */
export function finishedLabel(
  finished: ReadonlyArray<TaskView>,
  open: boolean,
  /** Given the clock, "today" is the day's endings and the rest are counted as older. */
  now?: number,
): string {
  // Nothing finished today, but this checkout's earlier runs are still behind this line.
  if (finished.length === 0) return "Earlier work";
  if (open) return `Finished · ${finished.length}`;
  const today =
    now === undefined
      ? finished
      : finished.filter((view) => (view.ended ?? view.at) >= now - FINISHED_FOR_MS);
  const failed = today.filter((view) => view.state === "failed").length;
  const older = finished.length - today.length;
  return `${today.length} finished today${failed === 0 ? "" : `, ${failed} failed`}${older === 0 ? "" : `, ${older} older`}`;
}

/** The step a Task has got to, in one word, or `done` where it is past the last of them. */
export function whereItIs(view: TaskView): string {
  if (view.steps.length === 0) return "";
  return view.steps.find((step) => step.state !== "done")?.name ?? "done";
}

/** How many agents are on it, or nothing where herdr has none left. */
export function agentCount(view: TaskView): string {
  const n = view.agents.length;
  return n === 0 ? "" : `${n} ${n === 1 ? "agent" : "agents"}`;
}

/**
 * The same three sections as text, for a pane whose renderer will not start. One line per
 * Task, its sentence included: a human on the escape hatch must not be shown a shorter,
 * more reassuring version of the herd than the board shows.
 *
 * Finished is printed only when there is any — closed, it is the one line the board folds
 * it into, and a section that says "(nothing)" every day is noise on every refresh.
 */
export function boardLines(
  views: ReadonlyArray<TaskView>,
  /** Lines to put under one Task's own: the question a dumb terminal answers in place. */
  under: { run: string; lines: ReadonlyArray<string> } | null = null,
): string[] {
  const { needs, working, waiting, finished } = sectionsOf(views, "");
  const section = (label: string, rows: ReadonlyArray<TaskView>) => textSection(label, rows, under);
  return [
    ...section("Needs you", needs),
    ...section(workingLabel(working), working),
    ...(waiting.length === 0 ? [] : section(waitingLabel(waiting), waiting)),
    ...(finished.length === 0 ? [] : section(finishedLabel(finished, true), finished)),
  ];
}

function textSection(
  label: string,
  views: ReadonlyArray<TaskView>,
  under: { run: string; lines: ReadonlyArray<string> } | null,
): string[] {
  const rows = views.flatMap((view) => [
    `  ${GLYPH_FOR[view.state]} ${view.name} · ${view.project} — ${view.sentence}`,
    ...(view.drift === null ? [] : [`    ↯ ${view.drift}`]),
    ...(view.held === null ? [] : [`    ${view.held}`]),
    ...(under !== null && under.run === view.run ? under.lines : []),
  ]);
  return ["", label, ...(rows.length === 0 ? ["  (nothing)"] : rows)];
}
