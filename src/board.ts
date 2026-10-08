// The board's own model: one TaskView per Task, and one per Run belonging to no Task.
//
// Read-only and derived: nothing here writes or infers what the files do not say. What
// became of a Run's work is the disposition's answer alone — a finished Run with a merge
// request has not been merged by anyone.

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { AUDIT_FILE, readAudit } from "./audit";
import { nothingApproved } from "./outcome";
import { FINAL_DIFF, planDirOf } from "./run-detail";
import { approvedFrom, type VerifySpec } from "./verify-spec";
import { openReports, readDrift } from "./drift";
import { describeAction } from "./lines";
import type { PickItem } from "./inputs";
import { LEADING_GLYPH, type AgentInfo } from "./herdr";
import { latest, readDispositions } from "./disposition";
import { runTitle } from "./naming";
import { planIssuesIn, planReposOf } from "./plan";
import { diffTargetOf } from "./strategies";
import { everyJournal, pendingFor, type ProposalLine } from "./proposals";
import { everyRegistered, type AgentEntry } from "./registry";
import { listRuns, newestFirst, settled as ended, type RunFacts, type RunState } from "./runs";
import type { PluginEnv } from "./env";
import { listTasks, type TaskRecord } from "./task";
import { ago, agoMs, agoShort, spanned, epochMs } from "./time";
import { readVerifications, type Verification } from "./verify";
import { markersOf, runningCheck } from "./checks";
import { readForge, readMrStates } from "./merges";
import { filed, standingOf } from "./standing";
import { offersOf } from "./lifecycle";
import { shell } from "./mr";
import type { OfferView } from "./board-model";
import { everyDelivery, SENT_STATES, toldIn, type Delivery } from "./steering";
import { readCards } from "./cards";
import {
  Answered,
  EVIDENCE_GATE,
  mrLabel,
  SECTIONS,
  sectionOf,
  sortBoard,
  type BoardAgent,
  type BoardChild,
  type BoardOffer,
  type BoardStep,
  type Checks,
  type Decision,
  type Gate,
  type MrState,
  type Proposal,
  type Question,
  type Reopened,
  type Section,
  type StepState,
  type TaskState,
  type TaskView,
} from "./board-model";

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

const LANDED_STATES: ReadonlySet<MrState> = new Set(["merged", "on-stage", "in-prod"]);
const DEPLOYED = { "on-stage": " On stage.", "in-prod": " In production." } as const;

/** When a Run ended: its own record, else the final card its finish wrote. Null for neither. */
const finishedAt = Effect.fn("Board.finishedAt")(function* (run: RunFacts) {
  if (run.finished !== null) return epochMs(run.finished);
  const cards = yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []));
  const final = cards.findLast((card) => card.kind === "final");
  return final === undefined ? null : epochMs(final.at);
});

/** The first line the Run's log recorded telling `agent` something, the newest such. */
const toldBy = Effect.fn("Board.toldBy")(function* (
  stateDir: string,
  runId: string,
  agent: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const log = yield* fs
    .readFileString(`${stateDir}/agents/${runId}/agents.log`)
    .pipe(Effect.orElseSucceed(() => ""));
  return toldIn(log, agent);
});

/**
 * A finished Run is Reopened by a steer Delivery to one of its agents, dated after it
 * ended and taken by herdr. Derived, never stored: the ledger says what was sent and when.
 */
const reopenedOf = Effect.fn("Board.reopenedOf")(function* (
  stateDir: string,
  run: RunFacts,
  deliveries: ReadonlyArray<Delivery>,
  live: ReadonlyMap<string, AgentInfo>,
) {
  const ended = yield* finishedAt(run);
  if (ended === null) return null;
  const steer = deliveries
    .filter(
      (one) =>
        one.run === run.id &&
        one.cause.kind === "steer" &&
        SENT_STATES.has(one.state) &&
        epochMs(one.at) > ended,
    )
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  if (steer === undefined) return null;
  return {
    delivery: steer.id,
    agent: steer.agent,
    told: yield* toldBy(stateDir, run.id, steer.agent),
    status: live.get(steer.agent)?.status ?? "gone",
  } satisfies Reopened;
});

/** What the forge said of a merge request's own checks: a pipeline or a check rollup. */
export type ForgeChecks =
  | { readonly state: "passed" | "running" | "unknown" }
  | { readonly state: "failed"; readonly name: string };

/** The forge's word on a merge request's checks, and the head revision it said it of. */
export interface ForgeFacts {
  readonly checks: ForgeChecks;
  readonly head: string | null;
}

/**
 * Collie's own checks and the forge's, as one: any failure fails, anything running is
 * running, and passed needs every source that said anything to have passed.
 */
export function withForge(collie: Checks, forge: ForgeFacts | null): Checks {
  const said = forge?.checks ?? { state: "unknown" };
  const at = forge?.head ?? ("at" in collie ? collie.at : "");
  if (said.state === "failed") return { state: "failed", name: said.name, at };
  if (collie.state === "failed") return collie;
  if (said.state === "running" || collie.state === "running") return { state: "running" };
  if (said.state === "passed") return { state: "passed", at };
  return collie;
}

/** Everything the sentence is made of, apart from the TaskView so the formatter is pure. */
export interface Sentence {
  state: TaskState;
  decision: Decision | null;
  /** The step the work is on, and which round of the loop it is in. */
  step: { id: string; round: { at: number; of: number | null } | null } | null;
  /** The step's own verb, where the definition gives one. */
  verb: string | null;
  /** What a check Collie is running says about itself, which outranks the step. */
  checking: string | null;
  /** A Reopened Run's agent at work on what it was told after the Run ended. */
  reopened: Pick<Reopened, "agent" | "told"> | null;
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
  /** What checked that merge request, where it is open; null reads as unchecked. */
  checks: Checks | null;
  /** A live agent of the Run's, which the next move can be handed to. */
  agent: string | null;
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
    "gate-fix": "Fixing what the checks found",
    "second-opinion": "Getting a second opinion on the plan",
    revise: "Revising the plan",
    refine: "Refining the plan",
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
  return VERBS.get(kind) ?? VERBS.get(kind.split("-")[0]!) ?? "Working on it";
}

function roundOf(step: Sentence["step"]): string {
  if (!step?.round) return "";
  const { at, of } = step.round;
  return of === null ? `, round ${at}` : `, round ${at} of ${of}`;
}

/**
 * The step an operation is, as the shipped workflows name them: `fix-1` is round 1 of
 * fixing, `review-2-1` the first seat of round 2's review, `review-2` the second seat of
 * round 1's (`reviewing.ts` numbers only later rounds), and `02-parse.md` a ticket.
 */
export function stepOfOperation(operation: string): Pick<Sentence, "step" | "verb"> {
  const ticket = /^(\d+)-.*\.md$/.exec(operation);
  if (ticket) return { step: { id: "build", round: null }, verb: `Building ticket ${ticket[1]}` };
  // A review seat's name is free text (`gpt-5`): only a leading number is its round.
  const seat = /^review-(?:(\d+)-.)?/.exec(operation);
  if (seat) {
    return {
      step: { id: "review", round: { at: seat[1] ? Number(seat[1]) : 1, of: null } },
      verb: null,
    };
  }
  const counted = /^(.+?)-(\d+)$/.exec(operation);
  if (counted === null) return { step: { id: operation, round: null }, verb: null };
  return {
    step: { id: counted[1]!, round: { at: Number(counted[2]), of: null } },
    verb: null,
  };
}

/** Where the Driver keeps a Run's launch order, one operation a line. */
const launchesOf = (stateDir: string, runId: string) => `${stateDir}/agents/${runId}/launches`;

/** The operation the Driver last launched an agent for, as its launch order records it. */
const lastLaunched = Effect.fn("Board.lastLaunched")(function* (stateDir: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const order = yield* fs
    .readFileString(launchesOf(stateDir, runId))
    .pipe(Effect.catch(() => Effect.succeed("")));
  return (
    order
      .split("\n")
      .filter((line) => line !== "")
      .at(-1) ?? null
  );
});

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
    case "gate": {
      const holding =
        decision.repo === undefined
          ? `Holding at the ${decision.step} gate`
          : `${decision.repo} is holding at the ${decision.step} gate`;
      return decision.verifications.length > 0
        ? `${holding} until you approve the list.`
        : `${holding}, and nothing is offered to approve. Grant a check with chat's set_verification, or collie run intent verification ${decision.run} --name <name> -- <command>.`;
    }
  }
}

const short = (sha: string) => sha.slice(0, 7);

/** An open merge request: whether it is ready, and the human's next move. */
function openSentence(mr: string, checks: Checks | null, agent: string | null): string {
  const label = mrLabel(mr);
  const handed = agent === null ? "" : `, or tell ${agent} to`;
  const seen: Checks = checks ?? { state: "unchecked" };
  switch (seen.state) {
    case "passed":
      return `Ready to release: ${label} is open and its checks passed at ${short(seen.at)}. Next: merge it${handed}.`;
    case "failed":
      return `${label} is open, but ${seen.name} failed at ${short(seen.at)}. Next: fix ${seen.name}${handed}.`;
    case "running":
      return `${label} is open; its pipeline is still running.`;
    case "unchecked":
      return `${label} is open; nothing has checked it.`;
  }
}

function doneSentence(
  disposition: Sentence["disposition"],
  mr: string | null = null,
  mrState: MrState | null = null,
  planReady = false,
  checks: Checks | null = null,
  agent: string | null = null,
): string {
  if (disposition === null) {
    if (planReady) return "Plan ready to implement.";
    if (mr === null) return "Finished; nothing merged yet.";
    if (mrState === "closed") return `Merge request ${mrLabel(mr)} closed without merging.`;
    return openSentence(mr, checks, agent);
  }
  switch (disposition.kind) {
    case "merged": {
      const deployed = mrState === "on-stage" || mrState === "in-prod" ? DEPLOYED[mrState] : "";
      // The forge's word carries no time of its own: the stamp is when Collie asked.
      if (disposition.by === "gitlab" || disposition.by === "github")
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
  if (facts.checking !== null) return facts.checking;
  if (facts.reopened !== null)
    return facts.reopened.told === null
      ? `Working on what you told ${facts.reopened.agent}.`
      : `Working on what you told ${facts.reopened.agent}: “${facts.reopened.told}”.`;
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
      return doneSentence(
        facts.disposition,
        facts.mr,
        facts.mrState,
        facts.planReady,
        facts.checks,
        facts.agent,
      );
    case "failed":
      return alsoBecame(failedSentence(facts), facts.disposition);
    case "stopped":
      return alsoBecame("Stopped by you.", facts.disposition);
    case "abandoned":
      return alsoBecame(
        `Its Driver died ${facts.abandoned ?? "a while ago"}${facts.note === null ? "" : `: ${facts.note}`}.`,
        facts.disposition,
      );
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

/** The second line a held Task carries, under its sentence. */
export function heldLine(until: string | null): string {
  return until === null ? "⏸ Held." : `⏸ Held until ${until}.`;
}

const STEP_STATE: Readonly<Record<RunState, StepState>> = {
  running: "active",
  waiting: "blocked",
  succeeded: "done",
  failed: "failed",
  stopped: "failed",
};

/** The Task's pipeline: its Runs in the order they started, each as it now stands. */
function stepsOf(runs: ReadonlyArray<RunFacts>): BoardStep[] {
  return [...runs].reverse().map((run) => ({ name: run.workflow, state: STEP_STATE[run.state] }));
}

/** What a Run is, in the board's words. A decision outranks whatever it was doing. */
function stateOf(
  status: RunState,
  silent: boolean,
  decision: Decision | null,
  /** Something is waiting for the human in a pane, with no Decision to say so. */
  stalled: boolean,
): TaskState {
  if (decision !== null) return "blocked";
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (status === "succeeded") return "done";
  // Under the endings, because only a Run still going can be waiting for anyone: a Run
  // someone stopped while its agent sat at a prompt was stopped, and says so.
  if (stalled) return "blocked";
  return silent ? "quiet" : "active";
}

/** The first question any of these Runs is waiting on, as a card asks it. */
function questionOf(runs: ReadonlyArray<RunFacts>): Question | null {
  for (const run of runs) {
    const asked = run.asking[0];
    if (asked === undefined) continue;
    return {
      kind: "question",
      run: run.id,
      id: asked.name,
      step: run.workflow,
      topic: asked.name,
      text: asked.prompt,
      options: asked.options.map((option) => ({ id: option, title: option, subtitle: null })),
    };
  }
  return null;
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

/**
 * What Collie's own checks say at one revision: the branch's head where it could be read,
 * else the newest revision Collie checked. An agent's record is a claim and never counts.
 */
export function checksAt(records: ReadonlyArray<Verification>, head: string | null): Checks {
  const collie = records.filter((record) => record.by === "collie");
  const at = head ?? collie.at(-1)?.end.head_sha ?? "";
  const newest = new Map<string, Verification>();
  for (const record of collie)
    if (at !== "" && record.end.head_sha === at) newest.set(record.name, record);
  if (newest.size === 0) return { state: "unchecked" };
  const red = [...newest.values()].find((record) => record.result !== record.expect);
  return red === undefined ? { state: "passed", at } : { state: "failed", name: red.name, at };
}

/** The commit the Run's branch is at now in its checkout, or null where that cannot be read. */
const branchHead = Effect.fn("Board.branchHead")(function* (run: RunFacts, now: number) {
  if (run.branch === null) return null;
  const key = `${run.cwd}\0${run.branch}`;
  const known = heads.get(key);
  if (known !== undefined && now - known.at < HEAD_FOR_MS) return known.sha;
  const read = yield* shell(
    "git",
    ["rev-parse", "--verify", "--quiet", `${run.branch}^{commit}`],
    run.cwd,
  );
  const sha = read.stdout.trim();
  const head = read.code === 0 && sha !== "" ? sha : null;
  heads.set(key, { at: now, sha: head });
  return head;
});

/** How long a branch head read stands, so a board refresh does not spawn git per card. */
const HEAD_FOR_MS = 60_000;
// ponytail: one entry per checkout and branch for the process's life; prune if that grows.
const heads = new Map<string, { readonly at: number; readonly sha: string | null }>();

/** An absolute path, wherever one sits in a name, read as what it points at. */
function withoutPaths(text: string): string {
  return text.replace(/(?:^|\s)\/(?:[^\s/]+\/)+([^\s/]+)/g, (whole, last: string) =>
    whole.startsWith(" ") ? ` ${last}` : last,
  );
}

/** What the Task is called, and whose project it is: the workspace label's two halves. */
function namesOf(label: string, run: RunFacts) {
  const clean = withoutPaths(label.replace(LEADING_GLYPH, "").trim());
  const at = clean.indexOf(" | ");
  if (at >= 0) return { project: clean.slice(0, at), name: clean.slice(at + 3) };
  const name = runTitle(run);
  // A label that names the Run says nothing the card does not: the checkout names the
  // project then, and a project the name already says is said once.
  const named = clean === "" || clean === name;
  const project = named ? basename(run.project) : name.includes(clean) ? "" : clean;
  return { project, name };
}

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").at(-1) ?? path;
}

/**
 * The Task's agents herdr still has. One entry per live agent, however many Runs it
 * worked for: a card counts agents, not the work they took.
 */
function agentsOf(
  runs: ReadonlyArray<RunFacts>,
  registered: ReadonlyArray<AgentEntry>,
  live: ReadonlyMap<string, AgentInfo>,
): BoardAgent[] {
  const found = new Map<string, BoardAgent>();
  for (const run of runs) {
    for (const entry of registered) {
      const agent = entry.runId === run.id ? live.get(entry.agent) : undefined;
      if (agent === undefined || found.has(agent.name)) continue;
      found.set(agent.name, {
        name: agent.name,
        status: agent.status,
        now: agent.title,
        run: run.id,
      });
    }
  }
  return [...found.values()];
}

/** A Run parked at its evidence gate, with the checks its checkout and config would approve. */
export const gateOf = Effect.fn("Board.gateOf")(function* (run: RunFacts, userDir: string) {
  if (run.parked !== nothingApproved(run.id)) return null;
  const offered = yield* approvedFrom({ cwd: run.cwd, userDir }).pipe(
    Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => []),
  );
  const gate: Gate = {
    kind: "gate",
    run: run.id,
    id: EVIDENCE_GATE,
    // Words, not the workflow's id: the sentence reads "Holding at the evidence gate".
    step: "evidence",
    verifications: offered.map((spec) => spec.name),
  };
  return run.repo === null ? gate : { ...gate, repo: run.repo };
});

/** The gate of the first Repo run, in wave order, parked there with nothing approved. */
const repoGateOf = Effect.fn("Board.repoGateOf")(function* (
  rows: ReadonlyArray<BoardChild>,
  children: ReadonlyArray<RunFacts>,
  userDir: string,
) {
  for (const { run } of rows) {
    const child = children.find((one) => one.id === run);
    const gate = child === undefined ? null : yield* gateOf(child, userDir);
    if (gate !== null) return gate;
  }
  return null;
});

/** Who set the hold that stands, and why, as the Run's audit trail recorded it. */
const holderOf = Effect.fn("Board.holderOf")(function* (run: RunFacts) {
  const lines = yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => []));
  const last = lines.findLast((line) => line.operation === "hold" || line.operation === "unhold");
  return last?.operation === "hold" ? { by: last.actor.origin, reason: last.reason ?? "" } : null;
});

/** The answer a Run carried on with, while nothing has been launched since it was given. */
const resumedWith = Effect.fn("Board.resumedWith")(function* (stateDir: string, run: RunFacts) {
  const last = (yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => []))).at(-1);
  if (last?.operation !== "answer") return null;
  const launched = yield* (yield* FileSystem.FileSystem).stat(launchesOf(stateDir, run.id)).pipe(
    Effect.map((info) =>
      Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
    ),
    Effect.orElseSucceed(() => 0),
  );
  if (launched > epochMs(last.at)) return null;
  const answered = Schema.decodeUnknownOption(Answered)(last.result);
  return Option.isSome(answered) ? answered.value.value : null;
});

/**
 * A fan-out's Repo runs as a card lists them, every repository its plan names, and the
 * wave it has got to. Without a readable plan, the Repo runs it has are the one wave.
 */
const fanOf = Effect.fn("Board.fanOf")(function* (
  parent: RunFacts,
  children: ReadonlyArray<RunFacts>,
) {
  const planDir = yield* planDirOf(parent).pipe(Effect.orElseSucceed(() => null));
  const plan =
    planDir === null
      ? null
      : yield* planReposOf(planDir, parent.cwd).pipe(Effect.orElseSucceed(() => null));
  // Newest first, so a repository retried is shown by its newest Run.
  const started = new Map<string, RunFacts>();
  for (const child of children)
    if (!started.has(child.repo ?? "")) started.set(child.repo ?? "", child);
  const planned = plan === null || plan.refusal !== null ? [] : plan.waves;
  const unplanned = [...started.keys()].filter((repo) => !planned.flat().includes(repo));
  const waves = unplanned.length === 0 ? planned : [...planned, unplanned];
  const rows = waves.flat().map((repo): BoardChild => {
    const run = started.get(repo);
    return {
      repo,
      run: run?.id ?? null,
      state: run === undefined ? "todo" : STEP_STATE[run.state],
      mr: run === undefined ? null : mrOf(run),
    };
  });
  const reached = waves.findLastIndex((wave) => wave.some((repo) => started.has(repo)));
  const where = (state: StepState) =>
    rows.filter((row) => row.state === state).map((row) => row.repo);
  return {
    children: rows,
    wave: {
      at: reached + 1,
      of: waves.length,
      landed: where("done"),
      building: [...where("active"), ...where("blocked")],
      stopped: where("failed"),
      next: where("todo"),
    },
  };
});

/** The Run a card is about: the newest still going, else the newest. */
function leaderOf(runs: ReadonlyArray<RunFacts>): RunFacts {
  return runs.find((run) => !ended(run)) ?? runs[0]!;
}

/** How long finished work stays on the board. A day, so an evening's work is still there
    in the morning — midnight is not when a human stops calling it today. */
const FINISHED_FOR_MS = 24 * 60 * 60 * 1000;

/**
 * When anything in this directory was last written, as `touchedDirAt` measures it but
 * without the files Collie writes about a Run from outside: a disposition, the diff kept
 * for its drawer and the trail of who asked for what are bookkeeping, and must not make
 * a dead Run look alive or ended just now.
 */
const writtenIn = Effect.fn("Board.writtenIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((stat) => (Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : 0)),
      Effect.catch(() => Effect.succeed(0)),
    );
  let newest = 0;
  for (const name of yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])))) {
    if (name === FINAL_DIFF || name === AUDIT_FILE) continue;
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

/** When the Run last did anything: its own directory, its agents' and its evidence. */
const lastActivityAt = Effect.fn("Board.lastActivityAt")(function* (
  stateDir: string,
  run: RunFacts,
) {
  return Math.max(
    yield* writtenIn(run.dir),
    yield* writtenIn(`${stateDir}/agents/${run.id}`),
    yield* writtenIn(run.evidence),
  );
});

const isMrTarget = (target: string | null): target is string =>
  target !== null && target.startsWith("mr:");

/** The merge request this Run opened, or the one it was pointed at; null for neither. */
export function mrOf(run: RunFacts): string | null {
  const target = diffTargetOf(run.settled)?.value ?? null;
  return run.mr ?? (isMrTarget(target) ? target : null);
}

/**
 * Whether settled Runs' work landed, from what they left: a disposition, or nothing that
 * anyone has to file in the first place.
 */
const landedByRecord = Effect.fn("Board.landedByRecord")(function* (runs: ReadonlyArray<RunFacts>) {
  for (const run of runs) {
    const toFile = filed({
      branch: run.branch,
      mr: mrOf(run),
      planIssues: yield* planIssuesIn(run.dir),
    });
    if (!toFile) continue;
    const seen = latest(
      yield* readDispositions(run.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    if (seen === null) return false;
  }
  return true;
});

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

/** Every Herd's proposals: the host serves every Herd on its Machine, not the one it came from. */
const proposalsOf = (stateDir: string) =>
  everyJournal(stateDir).pipe(Effect.map((journals) => journals.flatMap(({ lines }) => lines)));

/** How long a Run has been going by default before silence is worth saying. */
const DEFAULT_QUIET_MS = 5 * 60_000;

/**
 * Every Task on the Herd's board, Herd-wide, in the order the board draws them.
 *
 * Herd-wide on purpose: the board is one board per Herd (ADR-0009), and a workspace is a
 * filter over it rather than a board of its own.
 */
export const buildBoard = Effect.fn("Board.build")(function* (opts: {
  env: PluginEnv;
  /** What herdr says is alive, so a card can say who is on it. */
  alive?: ReadonlyArray<AgentInfo>;
  /** The Runs and Tasks already read, so a caller drawing two views reads them once. */
  runs?: ReadonlyArray<RunFacts>;
  tasks?: ReadonlyArray<TaskRecord>;
  registered?: ReadonlyArray<AgentEntry>;
  proposals?: ReadonlyArray<ProposalLine>;
  now?: number;
  /** How long a Run may write nothing before its card says it has gone quiet. */
  quietMs?: number;
  /** What the forge last said about each merge request, by the reference the card carries. */
  mrStates?: ReadonlyMap<string, MrState>;
  /** What the forge last said about each merge request's checks, by its label. */
  forge?: ReadonlyMap<string, ForgeFacts>;
  /** Every steer and step Delivery the ledgers hold; read from them where not given. */
  deliveries?: ReadonlyArray<Delivery>;
  /** What a Run offers now; the host is asked where this is not given. */
  offers?: (runId: string) => Effect.Effect<ReadonlyArray<OfferView>>;
}) {
  const { stateDir } = opts.env;
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const all = newestFirst(opts.runs ?? (yield* listRuns(opts.env)));
  const tasks = new Map(
    (opts.tasks ?? (yield* listTasks(stateDir))).map((task) => [task.id, task]),
  );
  const registered = opts.registered ?? (yield* everyRegistered(stateDir));
  const proposals = opts.proposals ?? (yield* proposalsOf(stateDir));
  const mrStates = opts.mrStates ?? (yield* readMrStates(stateDir));
  const forge = opts.forge ?? (yield* readForge(stateDir));
  const live = new Map((opts.alive ?? []).map((agent) => [agent.name, agent]));
  const markers = yield* markersOf(all);
  const deliveries = opts.deliveries ?? (yield* everyDelivery(stateDir));
  const offersOfRun =
    opts.offers ??
    ((runId: string) =>
      offersOf(opts.env, runId).pipe(
        Effect.map((listed) => ("ok" in listed ? [] : listed)),
        Effect.orElseSucceed((): ReadonlyArray<OfferView> => []),
      ));

  // A Repo run is its fan-out's card's child rather than a card of its own.
  const present = new Set(all.map((run) => run.id));
  const repoRunsOf = new Map<string, RunFacts[]>();
  for (const run of all)
    if (run.repo !== null && run.parent !== null && present.has(run.parent))
      repoRunsOf.set(run.parent, [...(repoRunsOf.get(run.parent) ?? []), run]);
  const groups = new Map<string, RunFacts[]>();
  for (const run of all) {
    if (run.parent !== null && repoRunsOf.get(run.parent)?.includes(run)) continue;
    const key = run.task ?? run.id;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const views: TaskView[] = [];
  for (const [id, runs] of groups) {
    const children = runs.flatMap((run) => repoRunsOf.get(run.id) ?? []);
    // What a card answers for and who works on it includes its Repo runs'.
    const everyRun = [...runs, ...children];
    const pending = everyRun.flatMap((run) => pendingFor(proposals, run.id, now));
    const touched = new Map<string, number>();
    for (const run of everyRun) touched.set(run.id, yield* lastActivityAt(stateDir, run));
    // A Run records no end of its own: its last activity is when it ended, and a Run
    // that wrote nothing ended no later than it began.
    const endedAt = (run: RunFacts) =>
      run.finished === null ? touched.get(run.id) || epochMs(run.created) : epochMs(run.finished);
    const last = Math.max(0, ...runs.map(endedAt).filter(Number.isFinite));
    // Finished work older than a day is History's, behind `older…` — landed work only:
    // an unmerged branch from last week is still waiting on you, however old.
    if (
      runs.every(ended) &&
      last < now - FINISHED_FOR_MS &&
      pending.length === 0 &&
      (yield* landedByRecord(runs))
    )
      continue;
    const leader = leaderOf(runs);
    const fanned = runs.find((run) => repoRunsOf.has(run.id));
    const fan = fanned === undefined ? null : yield* fanOf(fanned, repoRunsOf.get(fanned.id)!);
    const proposed = pending[0];
    const decision: Decision | null = proposed
      ? asProposal(proposed)
      : (questionOf(everyRun) ??
        (yield* gateOf(leader, opts.env.userDir)) ??
        (yield* repoGateOf(fan?.children ?? [], children, opts.env.userDir)));

    const status = leader.state;
    // A fan-out waiting on its Repo runs writes nothing itself: their work is its work.
    const working = [leader, ...children];
    const ownsAgent = (agent: { readonly run: string }) =>
      working.some((run) => run.id === agent.run);
    const at = Math.max(...working.map((run) => touched.get(run.id) ?? 0));
    const agents = agentsOf(everyRun, registered, live);
    const check = yield* runningCheck(leader, all, markers, now);
    // An agent mid-turn or a check Collie is running is work, however little it writes.
    const busy =
      check !== null || agents.some((agent) => ownsAgent(agent) && agent.status === "working");
    const going = !ended(leader);
    const silentFor = going && !busy && at > 0 ? now - at : 0;
    // Under a minute has no span to name, and is not silence worth a card saying.
    const span = silentFor > quietMs ? spanned(silentFor) : "";
    const silent = span === "" ? null : span;
    const operation = yield* lastLaunched(stateDir, leader.id);
    const doing = operation === null ? null : stepOfOperation(operation);
    // Stopped for a human with no Decision to answer: herdr reports `blocked` for an agent
    // sitting at its harness's own dialog, and a Run parks where its pane will not take a
    // prompt. herdr's name for the pane first: it is the one a human has to go to.
    const blocked = agents.find((agent) => agent.status === "blocked");
    const stalled =
      (blocked ? `${blocked.name}'s pane` : null) ??
      (leader.state === "waiting" && leader.asking.length === 0 ? "its pane" : null);
    // Nothing drives it and nobody works on it: the host could not take it up again. A
    // Decision outranks it, because answering is still what moves the work.
    const abandoned = decision === null && going && leader.undriven && !agents.some(ownsAgent);
    const reopened = ended(leader) ? yield* reopenedOf(stateDir, leader, deliveries, live) : null;
    // A Reopened Run is the work its agent is doing now, while it does it; then its facts.
    const state = abandoned
      ? "abandoned"
      : decision === null && reopened?.status === "working"
        ? "active"
        : decision === null && reopened?.status === "blocked"
          ? "blocked"
          : stateOf(status, silent !== null, decision, stalled !== null);

    // A hold left on a Run that ended holds nothing, and a finished Run refuses its release.
    const held = runs.find((run) => run.held && !ended(run));
    const settledNow =
      state === "done" || state === "failed" || state === "stopped" || state === "abandoned";
    // Read whatever the state: a merge GitLab reported lands the work even while the Run
    // is still going, and the card must say so.
    const disposition = latest(
      yield* readDispositions(leader.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    const failure =
      state === "failed"
        ? lastFailure(
            yield* readVerifications(leader.evidence).pipe(Effect.catch(() => Effect.succeed([]))),
          )
        : null;
    const open = openReports(
      yield* readDrift(leader.dir).pipe(Effect.catch(() => Effect.succeed([]))),
    );
    const task = leader.task === null ? null : (tasks.get(leader.task) ?? null);
    const { name, project } = namesOf(task?.label ?? "", leader);
    const started = runs.map((run) => epochMs(run.created)).filter(Number.isFinite);
    // A Task is as old as its first Run; a Run with no readable stamp has no age.
    const first = started.length === 0 ? 0 : Math.min(...started);

    const mr = runs.map(mrOf).find((one) => one !== null) ?? null;
    const mrState = mr === null ? null : (mrStates.get(mrLabel(mr)) ?? null);
    const branch = runs.map((run) => run.branch).find((b) => b !== null) ?? null;
    // What the Task left behind: the tickets are whichever of its Runs wrote any.
    let issues = 0;
    for (const run of runs) issues = Math.max(issues, yield* planIssuesIn(run.dir));
    const { planReady, landed } = standingOf({
      settled: settledNow,
      succeeded: status === "succeeded",
      branch,
      mr,
      mrLanded: mrState !== null && LANDED_STATES.has(mrState),
      planIssues: issues,
      disposed: disposition !== null,
      asking: decision !== null,
    });
    const awaitingMerge =
      state === "done" &&
      mr !== null &&
      disposition === null &&
      !landed &&
      (mrState === null || mrState === "open");
    // Collie's own evidence counts at the head the forge reported, where it reported one.
    const forged = mr === null ? null : (forge.get(mrLabel(mr)) ?? null);
    const checks = awaitingMerge
      ? withForge(
          checksAt(
            yield* readVerifications(leader.evidence).pipe(Effect.catch(() => Effect.succeed([]))),
            forged?.head ?? (yield* branchHead(leader, now)),
          ),
          forged,
        )
      : null;
    const finishedAt = settledNow ? endedAt(leader) : 0;
    const view: TaskView = {
      id,
      name,
      project,
      state,
      steps: stepsOf(runs),
      sentence: sentenceFor({
        mr,
        mrState,
        checks,
        agent: agents.find((one) => one.run === leader.id)?.name ?? null,
        planReady,
        abandoned: abandoned && at > 0 ? agoMs(at, now) : null,
        state,
        decision,
        step: doing?.step ?? null,
        // Never the pane's title: a terminal names its harness or file, not the work.
        verb: doing?.verb ?? null,
        checking: check?.sentence ?? null,
        reopened: state === "active" ? reopened : null,
        silent,
        wave: fan !== null && fanned === leader ? fan.wave : null,
        failure,
        note: leader.note,
        resumed: going ? yield* resumedWith(stateDir, leader) : null,
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
      // was judged against a tree that has moved since.
      drift:
        open.length === 0
          ? null
          : `${open[0]!.constraint}${open.length > 1 ? ` (and ${open.length - 1} more)` : ""}`,
      held: held === undefined ? null : heldLine(null),
      heldBy: held === undefined ? null : yield* holderOf(held),
      decision,
      agents,
      children: fan?.children ?? [],
      mr,
      branch,
      disposition:
        disposition === null
          ? null
          : disposition.ref === ""
            ? disposition.kind
            : `${disposition.kind} ${disposition.ref}`,
      landed,
      ended: finishedAt > 0 ? finishedAt : null,
      mrState,
      checks,
      ready: checks?.state === "passed",
      check,
      reopened,
      planReady,
      // Only a ready plan's first action is an offer; asking every card would ask every refresh.
      offer: planReady ? primaryOf(yield* offersOfRun(leader.id)) : null,
      run: leader.id,
      runs: runs.map((run) => run.id),
      at: at === 0 ? first : at,
    };
    views.push(task?.herd ? { ...view, herd: task.herd } : view);
  }
  return sortBoard(views);
});

/** Each Ready to release card's Run, with the revision its checks passed at and its sentence. */
export function readyRuns(
  views: ReadonlyArray<TaskView>,
): ReadonlyMap<string, { at: string; sentence: string }> {
  return new Map(
    views.flatMap((view) =>
      view.ready && view.checks?.state === "passed"
        ? [[view.run, { at: view.checks.at, sentence: view.sentence }] as const]
        : [],
    ),
  );
}

/** The offer a card presents first: the one its module marks primary and can make now. */
const primaryOf = (offers: ReadonlyArray<OfferView>): BoardOffer | null => {
  const first = offers.find((one) => one.primary && one.unavailable === null);
  return first === undefined ? null : { id: first.id, title: first.title };
};

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
  const label: Record<Section, (rows: ReadonlyArray<TaskView>) => string> = {
    "needs-you": () => "Needs you",
    waiting: waitingLabel,
    working: workingLabel,
    finished: (rows) => finishedLabel(rows, true),
  };
  return SECTIONS.flatMap(([section]) => {
    const rows = views.filter((view) => sectionOf(view) === section);
    const always = section === "needs-you" || section === "working";
    return rows.length === 0 && !always ? [] : textSection(label[section](rows), rows, under);
  });
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
