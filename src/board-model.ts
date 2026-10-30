// What a board is made of, as every front door decodes it, and the pure rules that place
// and count its cards, decide what each one offers and read what it names. No I/O and no
// Bun-only import: a browser bundle imports this too.

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { IntentSeedSchema } from "./intent-model";
import { ScheduleChange, ScheduleChanged, ScheduleListing } from "./schedule-model";
import { VerifyEvent, Pass, VerificationSchema } from "./verify-model";
import { MeasureEvent } from "./measurement-model";
export { PASSES, Pass } from "./verify-model";
import { IntentChangeSchema, ChangedIntent } from "./intent-model";
import { UsageReading } from "./usage-model";
import { HarnessCatalogue } from "./catalogue-model";
import { Connection, ConnectionLogin } from "./connection-model";
import { HostDefinitions, SharedDefinition } from "./definitions-model";
import { SlackChoices } from "./slack";
import { VerifySpecSchema } from "./verify-spec";

const STATE_ORDER = [
  "blocked",
  "active",
  "quiet",
  "failed",
  "stopped",
  "abandoned",
  "done",
] as const;

/** How a card reads, and the order Tasks take inside a section. */
export const TaskState = Schema.Literals(STATE_ORDER);
export type TaskState = typeof TaskState.Type;

/** Where a Task is in its pipeline, one glyph per step. */
export const StepState = Schema.Literals(["done", "active", "blocked", "failed", "todo"]);
export type StepState = typeof StepState.Type;

export const BoardStep = Schema.Struct({ name: Schema.String, state: StepState });
export type BoardStep = typeof BoardStep.Type;

/** Where one Step stands, as every door draws it. */
export const FlowState = Schema.Literals([
  "done",
  "running",
  "needs-you",
  "waiting",
  "failed",
  "stopped",
  "not-run",
  "expected",
]);
export type FlowState = typeof FlowState.Type;

export const FlowAction = Schema.Literals([
  "pause",
  "note",
  "retry-noted",
  "terminal",
  "tell",
  "retry",
  "answer",
  "proposal",
  "continue",
  "open",
  "start",
  "log",
  "evidence",
]);
export type FlowAction = typeof FlowAction.Type;
export const FlowLaneAction = Schema.Literals(["hold", "release", "stop", "resume", "follow-up"]);
export type FlowLaneAction = typeof FlowLaneAction.Type;

/** The strip a card draws: the leading Run's Steps, then its merge request's way out. */
export const FlowStrip = Schema.Struct({
  glyphs: Schema.Array(Schema.Struct({ title: Schema.String, state: FlowState })),
  /** How many of the glyphs, at the end, are the Release row's. */
  release: Schema.Finite,
  current: Schema.NullOr(
    Schema.Struct({ title: Schema.String, said: Schema.NullOr(Schema.String) }),
  ),
});
export type FlowStrip = typeof FlowStrip.Type;

/** A question a Run's Driver is holding open, with the options to answer it with. */
export const Question = Schema.Struct({
  kind: Schema.Literal("question"),
  run: Schema.String,
  /** The Choice id an answer names, so a question replaced meanwhile is not answered. */
  id: Schema.String,
  step: Schema.String,
  /** What the answer is about, for the sentence. */
  topic: Schema.String,
  text: Schema.String,
  /** Empty for a question typed into rather than picked from. */
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      subtitle: Schema.NullOr(Schema.String),
    }),
  ),
});
export type Question = typeof Question.Type;

/** A correction Collie proposes, which waits for someone to confirm it. */
export const Proposal = Schema.Struct({
  kind: Schema.Literal("proposal"),
  id: Schema.String,
  /** The payload a yes names exactly; a changed action hashes differently. */
  hash: Schema.String,
  text: Schema.String,
  actions: Schema.Array(Schema.Struct({ text: Schema.String, allowed: Schema.Boolean })),
});
export type Proposal = typeof Proposal.Type;

export const Decision = Schema.Union([Question, Proposal]);
export type Decision = typeof Decision.Type;

/** One live agent of the Task, as a card counts them and a search matches them. */
export const BoardAgent = Schema.Struct({
  /** herdr's own name for it, which carries the role it was started as. */
  name: Schema.String,
  /** The persona role it was registered as; absent from an older host. */
  role: Schema.optionalKey(Schema.String),
  status: Schema.String,
  /** Its pane's terminal title, or null for none: what the harness shows, not the step. */
  now: Schema.NullOr(Schema.String),
  run: Schema.String,
});
export type BoardAgent = typeof BoardAgent.Type;

/** One repository of a plan that spans several, and what became of its Run. */
export const BoardChild = Schema.Struct({
  repo: Schema.String,
  /** Null for a repository the fan-out never got to. */
  run: Schema.NullOr(Schema.String),
  state: StepState,
  mr: Schema.NullOr(Schema.String),
});
export type BoardChild = typeof BoardChild.Type;

/** An offer a card can invoke by id, under the title its workflow gave it. */
export const BoardOffer = Schema.Struct({ id: Schema.String, title: Schema.String });
export type BoardOffer = typeof BoardOffer.Type;

/** `on-stage` and `in-prod` are merged too: the furthest its deploy jobs have taken it. */
export const MrState = Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]);
export type MrState = typeof MrState.Type;

/** What checked an open merge request's branch, at the revision named. */
export const Checks = Schema.Union([
  Schema.Struct({ state: Schema.Literal("passed"), at: Schema.String }),
  Schema.Struct({ state: Schema.Literal("failed"), name: Schema.String, at: Schema.String }),
  Schema.Struct({ state: Schema.Literal("running") }),
  Schema.Struct({ state: Schema.Literal("unchecked") }),
]);
export type Checks = typeof Checks.Type;

/**
 * What the forge said of a merge request's own checks: a pipeline or a check rollup. `none`
 * is no pipeline at all; `unknown` is one that has not passed at its head: canceled, manual,
 * skipped, or run on an older head.
 */
export const ForgeChecks = Schema.Union([
  Schema.Struct({
    state: Schema.Literals(["passed", "running", "unknown", "none"]),
    url: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    name: Schema.String,
    url: Schema.optionalKey(Schema.String),
  }),
]);
export type ForgeChecks = typeof ForgeChecks.Type;

/** Whether the forge would merge it now, and its own word for why not. */
export const Mergeability = Schema.Struct({
  state: Schema.Literals(["mergeable", "blocked", "unknown"]),
  said: Schema.String,
});
export type Mergeability = typeof Mergeability.Type;

/** One fact Ready to release still lacks; `settling` where it may come without anyone acting. */
export const MissingFact = Schema.Struct({
  fact: Schema.Literals([
    "succeeded",
    "leads",
    "mr-open",
    "not-draft",
    "checks",
    "ci",
    "review",
    "mergeable",
  ]),
  said: Schema.String,
  settling: Schema.Boolean,
});
export type MissingFact = typeof MissingFact.Type;

/** Whether the work is mergeable now, and what it lacks where it is not. */
export const ReadyToRelease = Schema.Struct({
  ready: Schema.Boolean,
  missing: Schema.Array(MissingFact),
});
export type ReadyToRelease = typeof ReadyToRelease.Type;

/** What Ready to release is decided from. */
export interface ReleaseFacts {
  readonly succeeded: boolean;
  readonly mr: string | null;
  /** What the forge last said; null where it has not been asked. */
  readonly mrState: MrState | null;
  readonly draft: boolean;
  /** Collie's approved checks at the merge request's head. */
  readonly checks: Checks | null;
  /** The forge's pipeline at that head; null where it has not been asked. */
  readonly ci: ForgeChecks | null;
  /** Blocking review findings nobody has resolved. */
  readonly blocking: number;
  readonly mergeable: Mergeability | null;
}

/**
 * Ready to release: the leading Run succeeded, its merge request is open and not a draft,
 * Collie's checks and CI passed at its head, no blocking finding is open, and the forge
 * says it can merge. The board, `run show` and `run wait` all ask this.
 */
export function readyToRelease(facts: ReleaseFacts): ReadyToRelease {
  const missing: MissingFact[] = [];
  const lack = (fact: MissingFact["fact"], said: string, settling = false) =>
    missing.push({ fact, said, settling });
  if (!facts.succeeded) lack("succeeded", "the leading Run has not succeeded");
  if (facts.mr === null) lack("mr-open", "there is no merge request");
  else {
    const label = mrLabel(facts.mr);
    if (facts.mrState === null)
      lack("mr-open", `the forge has not said whether ${label} is open`, true);
    else if (facts.mrState !== "open") lack("mr-open", `${label} is ${facts.mrState}`);
    if (facts.draft) lack("not-draft", `${label} is a draft`);
    const checks = facts.checks ?? { state: "unchecked" };
    if (checks.state === "failed")
      lack("checks", `${checks.name} failed at ${pipe(checks.at, Str.slice(0, 7))}`);
    else if (checks.state === "running") lack("checks", "Collie's checks are still running", true);
    else if (checks.state === "unchecked")
      lack("checks", "its checks have not all run at its head");
    if (facts.ci === null) lack("ci", "the forge has not been asked about its pipeline", true);
    else if (facts.ci.state === "failed") lack("ci", `${facts.ci.name} failed in CI`);
    else if (facts.ci.state === "running") lack("ci", "CI is still running", true);
    else if (facts.ci.state === "unknown") lack("ci", "its pipeline has not passed at its head");
    if (facts.mergeable === null)
      lack("mergeable", "the forge has not said whether it can merge", true);
    else if (facts.mergeable.state === "blocked")
      lack("mergeable", `the forge says it cannot merge: ${facts.mergeable.said}`);
    else if (facts.mergeable.state === "unknown")
      lack("mergeable", "the forge is still working out whether it can merge", true);
  }
  if (facts.blocking > 0)
    lack("review", `${facts.blocking} blocking review finding(s) are unresolved`);
  return { ready: missing.length === 0, missing };
}

/** A check running now, and what it is measured against. */
export const RunningCheck = Schema.Struct({
  name: Schema.String,
  pass: Pass,
  round: Schema.NullOr(Schema.Finite),
  revision: Schema.String,
  base: Schema.NullOr(Schema.String),
  /** The pipeline job a `ci` pass waits on. */
  job: Schema.optionalKey(Schema.String),
  /** How long it has run, or null where the marker does not say when it started. */
  elapsedMs: Schema.NullOr(Schema.Finite),
  /** The median of its last five completed runs in this repository, or null for none. */
  usualMs: Schema.NullOr(Schema.Finite),
  /** Other checks this host is running now. */
  others: Schema.Finite,
  sentence: Schema.String,
  /** Where its output is being written, or null for a marker that does not say. */
  log: Schema.NullOr(Schema.String),
  /** The last lines it has written, oldest first. */
  lastLines: Schema.Array(Schema.String),
});
export type RunningCheck = typeof RunningCheck.Type;

/** A steer a finished Run's agent took after the Run ended, and what herdr says it is doing. */
export const Reopened = Schema.Struct({
  delivery: Schema.String,
  agent: Schema.String,
  /** The first line of what it was told, as the Run's log recorded it, or null for none. */
  told: Schema.NullOr(Schema.String),
  status: Schema.String,
});
export type Reopened = typeof Reopened.Type;

/** One Task as the board draws it. */
export const TaskView = Schema.Struct({
  /** The Task's id, or the Run's own where it belongs to no Task. */
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  /** The Herd the Task's workspace is in, where its record says; a `herds` id. */
  herd: Schema.optionalKey(Schema.String),
  state: TaskState,
  steps: Schema.Array(BoardStep),
  sentence: Schema.String,
  age: Schema.String,
  /** What drifted, in one line, or null where nothing has. */
  drift: Schema.NullOr(Schema.String),
  /** `⏸ Held until 14:00.`, or null while nothing is holding it. */
  held: Schema.NullOr(Schema.String),
  /** Who asked for the hold and why, which the drawer says and the card does not. */
  heldBy: Schema.NullOr(Schema.Struct({ by: Schema.String, reason: Schema.String })),
  decision: Schema.NullOr(Decision),
  /** Every question the Task's Runs have open, as the card asks them; absent from an older host. */
  questions: Schema.optionalKey(Schema.Array(Question)),
  agents: Schema.Array(BoardAgent),
  children: Schema.Array(BoardChild),
  mr: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  /** What became of the work, where someone recorded it. */
  disposition: Schema.NullOr(Schema.String),
  /**
   * Whether the work needs nothing more from anyone: a disposition was recorded, or the
   * Run succeeded at a Workflow that produces nothing to land. Places the card in
   * Finished rather than Waiting on you.
   */
  landed: Schema.Boolean,
  /** Its leading Run reported something nobody has seen yet; absent from an older host. */
  unseen: Schema.optionalKey(Schema.Boolean),
  /** When the leading Run ended, or null while it has not. Orders Waiting on you. */
  ended: Schema.NullOr(Schema.Finite),
  /** What the forge last said about the merge request, where Collie has asked. */
  mrState: Schema.NullOr(MrState),
  /** What checked the open merge request's branch, or null where no merge request waits. */
  checks: Schema.optionalKey(Schema.NullOr(Checks)),
  /** Ready to release: whether the work is mergeable now (`readyToRelease`). */
  ready: Schema.optionalKey(Schema.Boolean),
  /** What Ready to release still lacks; absent from a host older than the field. */
  readiness: Schema.optionalKey(ReadyToRelease),
  /** The check Collie is running for the leading Run now, or null for none. */
  check: Schema.optionalKey(Schema.NullOr(RunningCheck)),
  /** A finished Run whose agent was told something after it ended, or null (ADR-0041 D5). */
  reopened: Schema.optionalKey(Schema.NullOr(Reopened)),
  /** A plan that finished and nobody has implemented: its card's first action starts that. */
  planReady: Schema.Boolean,
  /** That action: the Run's primary offer as its module declares it now, or null for none. */
  offer: Schema.NullOr(BoardOffer),
  /** The Run a card's actions act on: the one the sentence is about. */
  run: Schema.String,
  /** Every Run of this Task, newest first, for the drawer. */
  runs: Schema.Array(Schema.String),
  /** When this Task last changed, in epoch milliseconds, which is what orders the board. */
  at: Schema.Finite,
  /** The strip its card draws of its Flow; absent from an older host. */
  flow: Schema.optionalKey(FlowStrip),
});
export type TaskView = typeof TaskView.Type;

/** Text a panel read from a file, or why it has none. */
export const Panel = Schema.Union([
  Schema.TaggedStruct("None", { reason: Schema.String }),
  Schema.TaggedStruct("Text", { text: Schema.String, truncated: Schema.Boolean }),
]);
export type Panel = typeof Panel.Type;

/** One ticket of a run's plan, as the panel lists it. */
export const PlanTicket = Schema.Struct({
  /** Its file name inside `plan/issues/`, which is what orders the list. */
  file: Schema.String,
  title: Schema.String,
  /** Whether every checkbox in it is checked, or a succeeded Run built from this plan finished it. */
  done: Schema.Boolean,
  /** Changes whenever its file does; an older host sends none. */
  stamp: Schema.optional(Schema.String),
});
export type PlanTicket = typeof PlanTicket.Type;

/** The plan a run is building from: its spec, and the tickets under it. */
export const PlanPanel = Schema.Struct({
  spec: Panel,
  /** Changes whenever SPEC.md does; an older host sends none. */
  specStamp: Schema.optional(Schema.String),
  tickets: Schema.Array(PlanTicket),
});
export type PlanPanel = typeof PlanPanel.Type;

/** One step's Output: what it was asked for, and what is actually there. */
export const OutputPanel = Schema.Struct({
  step: Schema.String,
  /** Where it was asked for, relative to the run dir, so the path is readable. */
  where: Schema.String,
  /** `recorded`, `missing`, or `unreadable` — the states `src/output.ts` already models. */
  state: Schema.Literals(["recorded", "missing", "unreadable"]),
  text: Schema.String,
});
export type OutputPanel = typeof OutputPanel.Type;

/**
 * What a Run wants from whoever is watching it. `none` is the ordinary case — the Run
 * is working and nobody has to do anything — and everything else is a reason to come
 * back to it.
 */
export const AttentionCategory = Schema.Literals([
  "none",
  "question",
  "drift",
  "completed",
  "interrupted",
]);
export type AttentionCategory = typeof AttentionCategory.Type;

export const Attention = Schema.Struct({
  category: AttentionCategory,
  /** Stable across releases; the code an agent branches on. */
  reason: Schema.String,
  explanation: Schema.String,
  /** The `run` subcommands that make sense here, by name. */
  actions: Schema.Array(Schema.String),
});
export type Attention = typeof Attention.Type;

/** What a Run cost and how it went, for `run metrics` and the detail panel. */
export const Metrics = Schema.Struct({
  /** From the Run's creation to the first collected verification, in seconds. */
  timeToFirstEvidence: Schema.NullOr(Schema.Finite),
  verifications: Schema.Struct({
    pass: Schema.Finite,
    fail: Schema.Finite,
    unstable: Schema.Finite,
    byCollie: Schema.Finite,
  }),
  slices: Schema.Struct({ done: Schema.Finite, total: Schema.Finite }),
  /** Fix rounds plus halts: how much of this Run was doing work again. */
  rework: Schema.Finite,
  /** The largest context sample any agent reported, and which agent. */
  peakContext: Schema.NullOr(Schema.Struct({ agent: Schema.String, tokens: Schema.Finite })),
  halts: Schema.Array(Schema.String),
  obstacles: Schema.Array(Schema.String),
});
export type Metrics = typeof Metrics.Type;

/**
 * The merge request behind a review, as the app's panel shows it. Every field but the
 * iid is optional on the wire — glab's shape varies with the GitLab version and what
 * the token may see — so a field nobody answered renders as unknown rather than
 * taking the panel down.
 */
export const MrDetails = Schema.TaggedStruct("Details", {
  iid: Schema.String,
  project: Schema.NullOr(Schema.String),
  title: Schema.String,
  /** `opened`, `merged`, `closed`, or `draft` where the MR says it is one. */
  state: Schema.String,
  author: Schema.String,
  /**
   * Who has to get this merged, by username. Empty where GitLab named nobody — which is
   * a merge request waiting for someone, not one that is mine.
   */
  assignees: Schema.Array(Schema.String),
  sourceBranch: Schema.String,
  fork: Schema.optionalKey(Schema.Boolean),
  targetBranch: Schema.String,
  /** The head pipeline's status, or `""` when there is no pipeline to report. */
  pipeline: Schema.String,
  /** The forge's checks as the card reads them, where the forge said. */
  checks: Schema.optionalKey(ForgeChecks),
  /** Phrased, because "2" alone does not say whether that is good. */
  approvals: Schema.String,
  /** Whether a discussion is still blocking, which is the one a reviewer chases. */
  unresolved: Schema.Boolean,
  notes: Schema.Finite,
  /** Seven characters: enough to tell two heads apart, short enough to read. */
  headSha: Schema.String,
  /** The head revision in full, which evidence is matched against, or "" where unsaid. */
  head: Schema.optionalKey(Schema.String),
  /** The commit the merge put on the target branch, in full, or "" while it is not merged. */
  mergedSha: Schema.String,
  /** When the forge says it merged, where it says. */
  mergedAt: Schema.optionalKey(Schema.String),
  /** When the forge last saw it change, in epoch milliseconds, or 0 when it did not say. */
  updatedAt: Schema.Finite,
  url: Schema.String,
  /** Whether it merges itself once its checks are green. */
  autoMerge: Schema.optionalKey(Schema.Boolean),
  /** Whether the forge would merge it now, by its own rules. */
  mergeable: Schema.optionalKey(Mergeability),
});
export type MrDetails = typeof MrDetails.Type;

/** Why the panel has nothing to show — one line, and nothing else in the panel breaks. */
export const MrUnavailable = Schema.TaggedStruct("Unavailable", { reason: Schema.String });
export type MrUnavailable = typeof MrUnavailable.Type;

export const MrPanel = Schema.Union([MrDetails, MrUnavailable]);
export type MrPanel = typeof MrPanel.Type;

/** One file the Run changed; `added` and `removed` are null for a binary file. */
export const DiffFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted"]),
  added: Schema.NullOr(Schema.Int),
  removed: Schema.NullOr(Schema.Int),
});

export type DiffFile = typeof DiffFile.Type;

/**
 * The Run's branch against its merge base. `live` while the Run works: what its checkout
 * holds now, committed or not. Each file's own diff is fetched by reference, `diff:<path>`.
 */
export const RunDiff = Schema.Struct({
  base: Schema.String,
  live: Schema.Boolean,
  files: Schema.Array(DiffFile),
});

export type RunDiff = typeof RunDiff.Type;

/** One verification as the drawer lists it; its output is fetched as `verification:<id>`. */
export const VerificationView = Schema.Struct({
  step: VerificationSchema.fields.step,
  place: VerificationSchema.fields.place,
  id: Schema.String,
  name: Schema.String,
  result: Schema.Literals(["pass", "fail", "unstable"]),
  expect: Schema.Literals(["pass", "fail"]),
  exit: Schema.Int,
  at: Schema.String,
  by: Schema.Literals(["agent", "collie"]),
});

export type VerificationView = typeof VerificationView.Type;

/** One review finding; `file` and `line` point into the diff, or at `file:<path>`. */
export const ReviewFinding = Schema.Struct({
  severity: Schema.String,
  title: Schema.String,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Finite),
  detail: Schema.NullOr(Schema.String),
});
export type ReviewFinding = typeof ReviewFinding.Type;

/** One steering card, newest per slice of work. */
export const SteeringCard = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  at: Schema.String,
  readiness: Schema.String,
  significance: Schema.String,
  narrative: Schema.NullOr(Schema.String),
  missing: Schema.Array(Schema.String),
});

export type SteeringCard = typeof SteeringCard.Type;

/** A file the Run kept, fetched as `evidence:<name>`, or `handoff:<name>` for a handoff note. */
export const EvidenceFile = Schema.Struct({ name: Schema.String, bytes: Schema.Int });
export type EvidenceFile = typeof EvidenceFile.Type;

/** A file the Run was given, fetched as `attachment:<name>`. */
export const AttachmentFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Int,
  mediaType: Schema.String,
});
export type AttachmentFile = typeof AttachmentFile.Type;

/** What a reference fetches: text as it is, anything else as base64. */
export const RunFile = Schema.Struct({
  ref: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  /** The whole item's size in bytes, of which `content` is the part asked for. */
  size: Schema.Int,
});

/** Part of a file on a host's Machine: `content` is base64, `size` the whole file's. */
export const HostFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  mediaType: Schema.String,
  content: Schema.String,
});
export type HostFile = typeof HostFile.Type;

/** The most one part of a file carries: of a `runFile` item, a read, an upload or a staging. */
export const PART_BYTES = 4 * 1024 * 1024;

export type RunFile = typeof RunFile.Type;

/** The harness, model and effort an agent ran on. */
export const RanOn = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});

/** A paired Machine, by its installation and the name herdr gives it. */
export const MachineRef = Schema.Struct({ installation: Schema.String, name: Schema.String });
export type MachineRef = typeof MachineRef.Type;

export const RequestedBy = Schema.Struct({
  run: Schema.String,
  agent: Schema.String,
  machine: MachineRef,
});
export type RequestedBy = typeof RequestedBy.Type;
export const requestedByLine = (who: RequestedBy) =>
  `Started by ${who.agent} of ${who.run} on ${who.machine.name}`;

export const RunReport = Schema.Struct({
  state: Schema.Literals(["delivered", "undelivered"]),
  at: Schema.String,
  note: Schema.String,
  closed: Schema.Boolean,
  closure: Schema.optionalKey(Schema.String),
});
export type RunReport = typeof RunReport.Type;

export const RunAgent = Schema.Struct({
  operation: Schema.String,
  agent: Schema.String,
  harness: Schema.String,
  /** Null in a launch recorded before the model was. */
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  /** The choice it fell back from (ADR-0049 D11). */
  from: Schema.NullOr(RanOn),
  /** Why it fell back, or why nothing it could fall back to had room. */
  why: Schema.NullOr(Schema.String),
  /** When it was given this work (ISO); null in a launch recorded before that was. */
  at: Schema.NullOr(Schema.String),
});
export type RunAgent = typeof RunAgent.Type;

const choiceSaid = (on: {
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
}) => `${on.harness}/${on.model ?? "default"}${on.effort === null ? "" : ` ${on.effort}`}`;

/**
 * What an agent ran on, as every door says it: `claude/opus xhigh`, or
 * `codex/default (fell back from claude/opus: session 100%, resets 15:45)`.
 */
export const ranOn = (agent: RunAgent) => {
  const on = choiceSaid(agent);
  if (agent.from !== null) return `${on} (fell back from ${choiceSaid(agent.from)}: ${agent.why})`;
  return agent.why === null ? on : `${on} (${agent.why})`;
};

export const FlowAttempt = Schema.Struct({
  at: Schema.String,
  /** Why it ran again: the host restarted, or the Run was resumed. Null for the first. */
  cause: Schema.NullOr(Schema.Literals(["restarted", "resumed"])),
});
export type FlowAttempt = typeof FlowAttempt.Type;

export const FlowQuestion = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  open: Schema.optionalKey(Schema.Boolean),
  text: Schema.optional(Schema.String),
  options: Schema.optional(Question.fields.options),
  name: Schema.String,
  asked: Schema.NullOr(Schema.String),
  answered: Schema.NullOr(Schema.String),
  by: Schema.NullOr(Schema.String),
});
export type FlowQuestion = typeof FlowQuestion.Type;

/** What holds a Step up, where something other than its own work does. */
export const FlowWait = Schema.Literals([
  "timer",
  "proposal",
  "stalled",
  "parked",
  "hold",
  "memory",
  "usage",
  "check",
  "ci",
]);
export type FlowWait = typeof FlowWait.Type;

/** Another Run a node stands for: a child of a Task of its own, or a Repo run. */
export const FlowLink = Schema.Struct({
  /** Null for a Repo run its fan-out has not started yet. */
  run: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  state: FlowState,
  said: Schema.NullOr(Schema.String),
  /** When its host last told us; null on this host. */
  asOf: Schema.optionalKey(Schema.NullOr(Schema.String)),
  canResume: Schema.optional(Schema.Boolean),
});
export type FlowLink = typeof FlowLink.Type;

const FlowNodeFields = {
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(["agent", "question", "workflow", "check", "release", "offer", "link"]),
  description: Schema.String,
  role: Schema.NullOr(Schema.String),
  /** False for a node made from work no Step declared. */
  declared: Schema.Boolean,
  state: FlowState,
  /** Its fact line, worded once by the host. */
  said: Schema.NullOr(Schema.String),
  wait: Schema.NullOr(FlowWait),
  produces: Schema.NullOr(Schema.Literals(["plan", "review", "evidence", "merge-request"])),
  offPath: Schema.Boolean,
  /** The round or item a run of a Step is, as its title says it. */
  place: Schema.NullOr(Schema.String),
  started: Schema.NullOr(Schema.String),
  ended: Schema.NullOr(Schema.String),
  attempts: Schema.Array(FlowAttempt),
  ranOn: Schema.NullOr(Schema.String),
  questions: Schema.Array(FlowQuestion),
  /** The Wave a Repo run's repository is in. */
  wave: Schema.optional(Schema.Finite),
  link: Schema.optional(FlowLink),
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  primary: Schema.optionalKey(Schema.NullOr(FlowAction)),
  actions: Schema.optionalKey(Schema.Array(FlowAction)),
  url: Schema.optional(Schema.String),
  proposal: Schema.optional(Proposal),
  log: Schema.optional(Schema.NullOr(Schema.Int)),
  why: Schema.optional(Schema.NullOr(Schema.String)),
  evidence: Schema.optional(Schema.Int),
  usual: Schema.optional(Schema.NullOr(Schema.Finite)),
  long: Schema.optional(Schema.Boolean),
  pauseTarget: Schema.optional(Schema.String),
  notes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        by: Schema.String,
        at: Schema.String,
        text: Schema.String,
        read: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  pause: Schema.optional(Schema.NullOr(Schema.Struct({ by: Schema.String, at: Schema.String }))),
};

/** One round or item of a Step. */
export const FlowRun = Schema.Struct(FlowNodeFields);
export type FlowRun = typeof FlowRun.Type;

export const FlowNode = Schema.Struct({
  ...FlowNodeFields,
  runs: Schema.Array(FlowRun),
  /** Runs its agents started outside this Flow. */
  links: Schema.optional(Schema.Array(FlowRun)),
});
export type FlowNode = typeof FlowNode.Type;

/** One Run's row of Steps. */
export const FlowLane = Schema.Struct({
  run: Schema.String,
  workflow: Schema.String,
  title: Schema.String,
  machine: Schema.String,
  requestedBy: Schema.NullOr(RequestedBy),
  execution: Schema.Literals(["running", "suspended", "completed", "failed", "stopped", "died"]),
  declared: Schema.Boolean,
  nodes: Schema.Array(FlowNode),
  actions: Schema.optionalKey(Schema.Array(FlowLaneAction)),
  /** The Run that started it into this Task, and that Run's Step it was started in. */
  startedBy: Schema.optionalKey(
    Schema.Struct({ run: Schema.String, step: Schema.NullOr(Schema.String) }),
  ),
});
export type FlowLane = typeof FlowLane.Type;

/** A Task drawn as the Steps its Runs took (ADR-draft-a-step-is-declared-where-its-work-is-written). */
export const Flow = Schema.Struct({
  notice: Schema.optional(Schema.NullOr(Schema.String)),
  lanes: Schema.Array(FlowLane),
  /** The Run and node the work is at, or null once it has settled. */
  current: Schema.NullOr(Schema.Struct({ run: Schema.String, node: Schema.String })),
  /** The merge request's way through CI, the merge and deploys, once the Task has one. */
  release: Schema.NullOr(Schema.Array(FlowNode)),
});
export type Flow = typeof Flow.Type;

/** Everything the detail panel shows for the selected Run. */
/** A reply a Run posted to a reviewer's comment, as posted. `kind` is absent where the workflow gave none. */
export const RunReply = Schema.Struct({
  at: Schema.String,
  mr: Schema.String,
  /** The comment's URL. */
  comment: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["fixed", "disputed"])),
  body: Schema.String,
});
export type RunReply = typeof RunReply.Type;

export const RunDetail = Schema.Struct({
  id: Schema.String,
  requestedBy: Schema.optional(RequestedBy),
  /** Who started it, as a sentence; absent where nothing records it, and from an older host. */
  startedBy: Schema.optional(Schema.String),
  report: Schema.optional(RunReport),
  dir: Schema.String,
  title: Schema.String,
  status: Schema.String,
  inputs: Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, source: Schema.String }),
  ),
  /** `took` is how long a finished step took, or how long a running one has been going. */
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      note: Schema.String,
      took: Schema.NullOr(Schema.String),
      agents: Schema.Array(Schema.String),
    }),
  ),
  /** One line each, as the record wrote them. */
  handoffs: Schema.Array(Schema.String),
  /**
   * What this Run is for and what bounds it, so the drawer can judge the work against
   * its intent. Null where the Run has none readable.
   */
  intent: Schema.NullOr(
    Schema.Struct({ goal: Schema.NullOr(Schema.String), constraints: Schema.Array(Schema.String) }),
  ),
  /** The rendered review — the thing the panel exists for. */
  review: Panel,
  /**
   * The plan this Run is building from, so the work can be judged against its intent
   * without leaving the tab. `null` for a Run that has no plan behind it.
   */
  plan: Schema.NullOr(PlanPanel),
  outputs: Schema.Array(OutputPanel),
  /** The end of the run's log while the panel's tail is toggled on; `null` while it is off. */
  tail: Schema.NullOr(Panel),
  logStart: Schema.optional(Schema.Int),
  /**
   * Why the Run is where it is, and what is safe to do about it — the same value the
   * CLI's `run show` and attention wait return. One classification, so the board and an
   * agent driving the CLI cannot tell a human two different stories about one Run.
   */
  attention: Attention,
  /**
   * What this Run has to prove, what it has not proved yet, what is in its way, what to
   * do next, and what became of its work. The panel used to say only why a Run stopped;
   * these say what it was for and whether it got there.
   */
  outcome: Schema.Struct({
    kind: Schema.NullOr(Schema.String),
    gaps: Schema.Array(Schema.String),
    obstacle: Schema.NullOr(Schema.String),
    next: Schema.NullOr(Schema.String),
    delivered: Schema.NullOr(Schema.String),
    /** A performance Run's latest `final` Measurement, or null. Absent from an older host. */
    measurement: Schema.optional(Schema.NullOr(Schema.String)),
    metrics: Metrics,
  }),
  /** When this Run finished, so the merge-request panel can say what moved since. */
  finishedAt: Schema.Finite,
  /** What the host's merge watch last read, for a Run that has a merge request. */
  mr: Schema.NullOr(MrPanel),
  findings: Schema.Array(ReviewFinding),
  verifications: Schema.Array(VerificationView),
  steering: Schema.Array(SteeringCard),
  evidence: Schema.Array(EvidenceFile),
  /** What its agents left in its `handoffs/` directory. Absent from an older host. */
  handoffFiles: Schema.optional(Schema.Array(EvidenceFile)),
  /** Absent from a host older than attachments. */
  attachments: Schema.optional(Schema.Array(AttachmentFile)),
  /** The replies it posted to reviewers. Absent from an older host. */
  replies: Schema.optional(Schema.Array(RunReply)),
  /** Null for a Run with no branch or no checkout left to compare. */
  diff: Schema.NullOr(RunDiff),
  /** Every agent the Run started, in launch order. Absent from an older host. */
  agents: Schema.optional(Schema.Array(RunAgent)),
  /** Its Task's Flow. Absent from an older host. */
  flow: Schema.optional(Flow),
});
export type RunDetail = typeof RunDetail.Type;

/** One offer as a front door shows it, over the wire. */
export const OfferView = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** The workflow it starts, by public id. */
  workflow: Schema.String,
  /** What it takes, as JSON Schema; null where it takes nothing. */
  arguments: Schema.NullOr(Schema.Json),
  kind: Schema.Literals(["action", "follow-up"]),
  primary: Schema.Boolean,
  /** Why it cannot be made now, or null when it can. */
  unavailable: Schema.NullOr(Schema.String),
});
export type OfferView = typeof OfferView.Type;

/** A workflow a front door may start in a project, and the Inputs it asks for. */
export const Startable = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  inputs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      required: Schema.Boolean,
      /** The field's schema as JSON Schema, or null where it would not draw. */
      schema: Schema.NullOr(Schema.Json),
    }),
  ),
});
export type Startable = typeof Startable.Type;

/** One step a Run's agent was given: its operation, who has it, and whether its Output is in. */
export const RunStep = Schema.Struct({
  operation: Schema.String,
  agent: Schema.String,
  done: Schema.Boolean,
});
export type RunStep = typeof RunStep.Type;

/** Where a Run has got to, for `run show`, `run wait` and chat. */
export const RunProgress = Schema.Struct({
  ready: ReadyToRelease,
  /** The forge's pipeline at its merge request's head; null where it has not been asked. */
  ci: Schema.NullOr(ForgeChecks),
  steps: Schema.Array(RunStep),
});
export type RunProgress = typeof RunProgress.Type;

/** Ready to release as one Run reads it: its card's, where it leads that card. */
export function readinessOfRun(
  runId: string,
  card: TaskView | undefined,
  ended: boolean,
): ReadyToRelease {
  if (card === undefined)
    return {
      ready: false,
      missing: [
        ended
          ? { fact: "leads", said: "it ended on no card", settling: false }
          : { fact: "leads", said: "it is on no card yet", settling: true },
      ],
    };
  if (card.run !== runId)
    return {
      ready: false,
      missing: [{ fact: "leads", said: `${card.run} leads its Task now`, settling: false }],
    };
  return card.readiness ?? { ready: card.ready ?? false, missing: [] };
}

/**
 * The board protocol's version. An optional field, a new operation or a new kind of
 * message keeps it; a removal or a change of meaning bumps it.
 */
export const PROTOCOL = 4;

/** One herdr session whose Tasks are on this board. */
export const Herd = Schema.Struct({
  id: Schema.String,
  /** herdr's name for the session, where herdr names its sessions. */
  name: Schema.optionalKey(Schema.String),
});
export type Herd = typeof Herd.Type;

/** Every Task as it is now; whatever follows it is a change to this. */
export const BoardSnapshot = Schema.TaggedStruct("Snapshot", {
  /** Stable for the state directory, so a Machine reached by two routes is one. */
  installation: Schema.String,
  build: Schema.String,
  /** `<version>+<sha>` for a development checkout, which nothing upgrades; absent for a release. */
  development: Schema.optionalKey(Schema.String),
  protocol: Schema.Int,
  /** Whether this host takes files: its file operations, uploads and attachments. */
  files: Schema.optionalKey(Schema.Boolean),
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  seq: Schema.Int,
});
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const TaskUpserted = Schema.TaggedStruct("Upsert", { seq: Schema.Int, task: TaskView });
export type TaskUpserted = typeof TaskUpserted.Type;

export const TaskRemoved = Schema.TaggedStruct("Remove", { seq: Schema.Int, id: Schema.String });
export type TaskRemoved = typeof TaskRemoved.Type;

const KNOWN_MESSAGES: ReadonlyArray<string> = ["Snapshot", "Upsert", "Remove", "Unknown"];

/** A kind of message from a newer host, read as `Unknown` so a client can skip it. */
export const UnknownMessage = Schema.Struct({
  _tag: Schema.String.pipe(Schema.check(Schema.makeFilter((tag) => !KNOWN_MESSAGES.includes(tag)))),
  seq: Schema.optionalKey(Schema.Int),
}).pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Unknown", { kind: Schema.String, seq: Schema.optionalKey(Schema.Int) }),
    {
      decode: SchemaGetter.transform(({ _tag, seq }) =>
        seq === undefined
          ? { _tag: "Unknown" as const, kind: _tag }
          : { _tag: "Unknown" as const, kind: _tag, seq },
      ),
      encode: SchemaGetter.transform(({ kind, seq }) =>
        seq === undefined ? { _tag: kind } : { _tag: kind, seq },
      ),
    },
  ),
);

export const BoardMessage = Schema.Union([
  BoardSnapshot,
  TaskUpserted,
  TaskRemoved,
  UnknownMessage,
]);
export type BoardMessage = typeof BoardMessage.Type;

/** Anything else a host will not do, said in one sentence a caller can show. */
export class HostRefused extends Schema.TaggedError<
  HostRefused,
  { readonly brand: unique symbol }
>()("HostRefused", {
  reason: Schema.String,
}) {}

/**
 * A request id that was accepted for other arguments. Schema-backed, so a host can fail a
 * client with this value rather than a sentence about it: the caller is retrying something
 * it has changed its mind about, and changing an accepted request silently is the one
 * thing an idempotency key must never do.
 */
export class RequestConflict extends Schema.TaggedError<
  RequestConflict,
  { readonly brand: unique symbol }
>()("RequestConflict", {
  request: Schema.String,
  reason: Schema.String,
}) {}

/** What an accepted answer became. `fresh` is false for the same claim arriving twice. */
export const Answered = Schema.Struct({
  runId: Schema.String,
  decision: Schema.String,
  value: Schema.String,
  fresh: Schema.Boolean,
  /** The kind of each credential-shaped value taken out before anything was written. */
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * What a control did. `applied` is whether the run was actually told: a control recorded
 * over work no host is running is an intent, and saying otherwise would be a confirmation
 * nobody can stand behind.
 */
export const Controlled = Schema.Struct({
  runId: Schema.String,
  control: Schema.String,
  set: Schema.Boolean,
  applied: Schema.Boolean,
  detail: Schema.String,
  /** The agents a stop could not close, which may still be changing the workspace. */
  left: Schema.Array(Schema.String),
  /** A stop of a finished Run: the agents it closed, with no control set and no status changed. */
  closed: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * What every door says of a control that left something running, or null where it left
 * nothing: a stop that could not make an agent Quiet is a failed operation, never "Stopped".
 */
export const leftSaid = (done: typeof Controlled.Type): string | null => {
  if (done.left.length === 0) return null;
  if (done.closed !== undefined)
    return `${done.runId} has finished, but ${Arr.join(done.left, "; ")}.`;
  const what = `${done.set ? done.control : `un${done.control}`} ${done.runId}`;
  return `Recorded ${what}, but ${Arr.join(done.left, "; ")}.`;
};

/** What a start became: the run it is, and whether this call is what made it. */
export const Started = Schema.Struct({
  runId: Schema.String,
  registration: Schema.String,
  execution: Schema.String,
  fresh: Schema.Boolean,
  /** The kind of each credential-shaped value taken out before anything was written. */
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

/**
 * What became of a Run's work: `merged` by some other route, `abandoned` on purpose, or
 * `superseded` by the Run that carried it instead. Never a value that edits its status.
 */
export const Disposition = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  kind: Schema.Literals(["merged", "abandoned", "superseded"]),
  /** What backs it up: a merge request, a commit, or the Run that took the work over. */
  ref: Schema.String,
  note: Schema.NullOr(Schema.String),
});
export type Disposition = typeof Disposition.Type;

/** Someone opened or acknowledged a finished Run, once for the Flock. */
export const Seen = Schema.Struct({ at: Schema.String, by: Schema.String });
export type Seen = typeof Seen.Type;

/** One action of a confirmed proposal, and what came of it. */
export const StepResult = Schema.Struct({
  index: Schema.Int,
  kind: Schema.String,
  state: Schema.String,
  note: Schema.String,
  /** The Run it acted on, where it names one, so a board can show a `navigate`'s target. */
  run: Schema.NullOr(Schema.String),
});
export type StepResult = typeof StepResult.Type;

export const ProposalCarried = Schema.Struct({
  proposal: Schema.String,
  results: Schema.Array(StepResult),
});
export type ProposalCarried = typeof ProposalCarried.Type;

/** A yes or a no the proposals journal would not take, and which rule it broke. */
export class ProposalRefused extends Schema.TaggedError<
  ProposalRefused,
  { readonly brand: unique symbol }
>()("ProposalRefused", {
  refused: Schema.String,
  detail: Schema.String,
}) {}

/** What a steer came to, as the front doors print it: a failure carries its code. */
export const SteerOutcome = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.NullOr(Schema.String),
  human: Schema.String,
  data: Schema.Json,
  /** The kind of each credential-shaped value taken out before anything was written. */
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SteerOutcome = typeof SteerOutcome.Type;

/**
 * What the human can ask for and have done: the board's own actions on a named Run, plus
 * starting one. A closed subset of the same union — amending an Intent, forking a
 * definition and changing what a workspace's Runs begin with are collie_propose's, which
 * carries them out in the same call.
 */
export const ASKED_KINDS = [
  "stop",
  "resume",
  "release",
  "answer",
  "deliver",
  "followup",
  "take_offer",
  "start",
] as const;

/** What one action the human asked for came to. */
export const ActionResult = Schema.Struct({
  kind: Schema.String,
  state: Schema.String,
  note: Schema.String,
});
export type ActionResult = typeof ActionResult.Type;

/** One thing Collie made that a sweep removes, its size in bytes, and why it goes. */
export const CleanupItem = Schema.Struct({
  kind: Schema.String,
  target: Schema.String,
  bytes: Schema.Finite,
  reason: Schema.String,
});
export type CleanupItem = typeof CleanupItem.Type;

/** One thing Collie made and keeps, with the one condition that keeps it. */
export const CleanupKept = Schema.Struct({
  kind: Schema.String,
  target: Schema.String,
  reason: Schema.String,
});
export type CleanupKept = typeof CleanupKept.Type;

/** A cleanup listing, or what a sweep did: `remove` is what it would remove, or removed. */
export const CleanupReport = Schema.Struct({
  remove: Schema.Array(CleanupItem),
  keep: Schema.Array(CleanupKept),
  bytes: Schema.Finite,
});
export type CleanupReport = typeof CleanupReport.Type;

/**
 * Which front door is acting: what a channel declares, and what its operations are stamped
 * with. `schedule` is the host itself starting a Schedule's Run, which no channel declares.
 */
export const FrontDoor = Schema.Literals([
  "cli",
  "cli-tty",
  "board",
  "desktop",
  "driver",
  "evaluator",
  "chat",
  "schedule",
  "agent",
  /** A host's own call to a peer, such as a settings sync: never a human. */
  "host",
]);
export type FrontDoor = typeof FrontDoor.Type;

/**
 * Where a channel came from: the computer its front door named, the SSH client a bridge
 * saw, and the paired Machine a link authenticated, which only this host's own link sets.
 */
export const Where = Schema.Struct({
  client: Schema.optionalKey(Schema.String),
  ssh: Schema.optionalKey(Schema.String),
  machine: Schema.optionalKey(MachineRef),
  run: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
});
export type Where = typeof Where.Type;

/** The line before which anything a bridge prints is a login shell's, and after which it is the host's. */
export const BRIDGE_READY = "collie-bridge-ready";

/** What a channel says it is, once. */
export const Declaration = Schema.Struct({
  frontDoor: FrontDoor,
  /** The herdr session socket it runs in, where what it asks names workspaces and panes. */
  session: Schema.optionalKey(Schema.NullOr(Schema.String)),
  from: Schema.optionalKey(Where),
  /** A chat's conversation, and the human's message that turn, as its tool host heard it. */
  conversation: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.String),
  /** The names of the files the human's message carried. */
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The host's own, which only its link knows: what lets `from` name a Machine. */
  stamp: Schema.optionalKey(Schema.String),
});
export type Declaration = typeof Declaration.Type;

/** Whether something is worth interrupting a human for: `decision` > `consequential` > `try-it` > `routine`. */
export const Significance = Schema.Literals(["routine", "try-it", "decision", "consequential"]);
export type Significance = typeof Significance.Type;

/** How many News items one batch carries: a screen's worth. */
export const NEWS_BATCH = 10;

/** What became of a News item in one conversation. */
export const NewsReceipt = Schema.Literals(["read", "sent", "uncertain"]);

/** A conversation's News, as the host handed it over: the newest items and how many it left. */
export const NewsBatch = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      run: Schema.String,
      text: Schema.String,
      at: Schema.String,
      /** Routine from a host whose News did not say. */
      significance: Significance.pipe(Schema.withDecodingDefaultKey(Effect.succeed("routine"))),
    }),
  ),
  omitted: Schema.Int,
});

/**
 * Where a host focused a Run's pane. `session` is null for herdr's default; `pane` and
 * `agent` are the focused agent's pane id and herdr name, absent where only a workspace was
 * found or the host is older.
 */
export const PaneAt = Schema.Struct({
  session: Schema.NullOr(Schema.String),
  workspace: Schema.String,
  tab: Schema.NullOr(Schema.String),
  pane: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
});
export type PaneAt = typeof PaneAt.Type;

/** One of Collie's settings as a Machine has it, and when it was last set; null is unset. */
export const SharedSetting = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.Json),
  at: Schema.String,
});
export type SharedSetting = typeof SharedSetting.Type;

/** A Machine's settings that a Flock shares, and the Desktop that last gave it the Flock's. */
export const SharedSettings = Schema.Struct({
  settings: Schema.Array(SharedSetting),
  flock: Schema.NullOr(Schema.Struct({ by: Schema.String, at: Schema.String })),
});
export type SharedSettings = typeof SharedSettings.Type;

export const MachineOwn = Schema.Struct({
  projectsRoot: Schema.optionalKey(Schema.String),
  chatHarness: Schema.optionalKey(Schema.String),
  harnesses: Schema.Array(Schema.String),
  remembered: Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
});
export type MachineOwn = typeof MachineOwn.Type;

/** Files given with a request, as paths on the host's own Machine, copied into the Run. */
export const Attachments = Schema.Array(Schema.String);

/** The Collie tools a Flock chat has a Machine's host answer, all of them reads. */
export const FLOCK_READS = ["collie_run", "collie_receipts", "collie_workspaces"] as const;

export const ShellResult = Schema.Struct({
  code: Schema.Int,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ShellResult = typeof ShellResult.Type;
export const ShellRequest = Schema.Struct({
  script: Schema.String,
  stdin: Schema.optionalKey(Schema.String),
  request: Schema.String,
});
export type ShellRequest = typeof ShellRequest.Type;

/**
 * What any front door, on this computer or another, may ask a host. Every operation takes
 * a request id: the same one twice is one operation, and with other arguments is refused.
 */
export const FrontDoorRpcs = RpcGroup.make(
  Rpc.make("refresh", {
    payload: { request: Schema.String },
    success: Schema.Boolean,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),

  Rpc.make("shell", {
    payload: ShellRequest,
    success: ShellResult,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("board", { success: BoardMessage, stream: true }),
  /**
   * Once per channel, for good; a channel that never declares is stamped `cli`, never a
   * human. A chat declares again each turn, with that turn's words.
   */
  Rpc.make("declare", {
    payload: Declaration,
    error: HostRefused,
  }),
  Rpc.make("start", {
    payload: {
      project: Schema.String,
      id: Schema.String,
      request: Schema.String,
      /** Values that already have a type, and values as a human typed them. */
      input: Schema.Record(Schema.String, Schema.Json),
      text: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      /** The names among those a front door worked out rather than was told. */
      inferred: Schema.optional(Schema.Array(Schema.String)),
      /** The Projects root the front door resolved, which `workspace=projects-root` names. */
      root: Schema.optional(Schema.String),
      /** The host's own launch options, which never reach the author's payload. */
      options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      // What this work belongs to, which is the caller's to know and the host's to keep.
      // Left out by a caller that is neither continuing a Task nor inside another run.
      task: Schema.optional(Schema.String),
      /** A new Task to open for it under this label, once its checkout is known. */
      taskLabel: Schema.optional(Schema.String),
      parent: Schema.optional(Schema.String),
      intent: Schema.optional(IntentSeedSchema),
      /** The approved set given with the start, over the project's and the user's files. */
      verify: Schema.optional(Schema.Array(VerifySpecSchema)),
      attachments: Schema.optional(Attachments),
    },
    success: Started,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  // The decision is named where a caller knows which question it is answering, and null
  // where it means "the one this run is waiting on" — refused where that is not one.
  Rpc.make("answer", {
    payload: {
      runId: Schema.String,
      decision: Schema.NullOr(Schema.String),
      value: Schema.String,
      request: Schema.String,
    },
    success: Answered,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** A hold or a stop over one run, set or cleared. It reaches no other run and no host. */
  Rpc.make("control", {
    payload: {
      runId: Schema.String,
      control: Schema.Literals(["hold", "stop"]),
      set: Schema.Boolean,
      request: Schema.String,
      /** Why, in the asker's own words: what a held card's drawer says beside who held it. */
      reason: Schema.optional(Schema.String),
      before: Schema.optional(Schema.String),
    },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** Picks a Run up again: what current files allow is registered, then its stop cleared. */
  Rpc.make("withdrawNote", {
    payload: { runId: Schema.String, note: Schema.String, request: Schema.String },
    success: Schema.Boolean,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("resume", {
    payload: { runId: Schema.String, request: Schema.String },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** Where one Run has got to: Ready to release, its steps and its CI, as the board last read them. */
  Rpc.make("progress", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunProgress),
  }),
  /**
   * One Run's details while a drawer is open: current first, then again whenever they
   * change. `refreshMr` asks the merge watch again rather than taking what it last read.
   */
  Rpc.make("runDetail", {
    payload: {
      runId: Schema.String,
      tail: Schema.Boolean,
      pages: Schema.Int,
      refreshMr: Schema.Boolean,
    },
    success: Schema.NullOr(RunDetail),
    stream: true,
  }),
  /**
   * A large item of a Run's, by reference: `log`, `review`, `diff:<path>`, `evidence:<name>`,
   * `verification:<id>`, `plan:<file>`, read-only from its checkout `file:<path>`, and
   * `pipeline:<url>`, the status GitLab gives a pipeline the Run links to.
   */
  Rpc.make("runFile", {
    payload: {
      runId: Schema.String,
      ref: Schema.String,
      /** Where in the item to start, in bytes. */
      offset: Schema.optional(Schema.Int),
      /** How many bytes from there: `PART_BYTES` when not given, and at most. */
      length: Schema.optional(Schema.Int),
    },
    success: RunFile,
    error: HostRefused,
  }),
  /** A yes or a no to a proposal, by its id and the hash of exactly what it would do. */
  Rpc.make("confirm", {
    payload: { proposal: Schema.String, hash: Schema.String, request: Schema.String },
    success: ProposalCarried,
    error: Schema.Union([HostRefused, ProposalRefused, RequestConflict]),
  }),
  /**
   * Actions chat was asked to carry out, recorded as a proposal and carried out at once.
   * The actions are JSON here because the host alone holds their schema.
   */
  Rpc.make("propose", {
    payload: {
      /** The Herd whose journal keeps it; the host's own where null. */
      herd: Schema.NullOr(Schema.String),
      interpretation: Schema.String,
      actions: Schema.Array(Schema.Json),
      request: Schema.String,
    },
    success: SteerOutcome,
  }),
  /** The board's own actions the human asked for by name, carried out with no proposal. */
  Rpc.make("act", {
    payload: { actions: Schema.Array(Schema.Json), request: Schema.String },
    success: Schema.Array(ActionResult),
    error: HostRefused,
  }),
  /** A proposal step nobody can account for, settled by the person who knows. */
  Rpc.make("reconcile", {
    payload: {
      proposal: Schema.String,
      index: Schema.Int,
      as: Schema.Literals(["applied", "not-applied"]),
      request: Schema.String,
    },
    success: Schema.Struct({ proposal: Schema.String }),
    error: Schema.Union([HostRefused, ProposalRefused, RequestConflict]),
  }),
  /** A message nobody knows reached its agent, settled by the person who knows. */
  Rpc.make("verify", {
    payload: {
      runId: Schema.String,
      name: Schema.String,
      executable: Schema.String,
      argv: Schema.Array(Schema.String),
      cwd: Schema.optionalKey(Schema.String),
      expect: Schema.Literals(["pass", "fail"]),
    },
    success: VerifyEvent,
    error: HostRefused,
    stream: true,
  }),
  /** A Measurement of the Run's checkout against a base, or the one already recorded for them. */
  Rpc.make("measure", {
    payload: {
      runId: Schema.String,
      base: Schema.String,
      cwd: Schema.optionalKey(Schema.String),
      plan: Schema.Json,
      pass: Schema.String,
      reason: Schema.optionalKey(Schema.String),
    },
    success: MeasureEvent,
    error: HostRefused,
    stream: true,
  }),
  Rpc.make("changeIntent", {
    payload: {
      runId: Schema.String,
      change: IntentChangeSchema,
      propagate: Schema.Boolean,
      request: Schema.String,
      expected: Schema.optionalKey(Schema.Finite),
    },
    success: ChangedIntent,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("rememberVerification", {
    payload: { runId: Schema.String, replace: Schema.Boolean, request: Schema.String },
    success: Schema.Json,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("clearOverride", {
    payload: { runId: Schema.String, agent: Schema.String, request: Schema.String },
    success: Schema.Json,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("settleDelivery", {
    payload: {
      runId: Schema.String,
      delivery: Schema.String,
      as: Schema.Literals(["sent", "not-sent"]),
      request: Schema.String,
    },
    success: Schema.Json,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("decline", {
    payload: { proposal: Schema.String, hash: Schema.String, request: Schema.String },
    success: Schema.Struct({ proposal: Schema.String }),
    error: Schema.Union([HostRefused, ProposalRefused, RequestConflict]),
  }),
  /** What became of a Run's work, recorded beside its status and never over it. */
  Rpc.make("dispose", {
    payload: {
      runId: Schema.String,
      kind: Disposition.fields.kind,
      ref: Schema.String,
      note: Schema.NullOr(Schema.String),
      request: Schema.String,
    },
    success: Disposition,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** A finished Run opened or acknowledged; the first such line, however often it is asked. */
  Rpc.make("seen", {
    payload: { runId: Schema.String, request: Schema.String },
    success: Seen,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** Free words about one Run, which the evaluator turns into actions carried out now. */
  Rpc.make("steerAbout", {
    payload: {
      runId: Schema.String,
      text: Schema.String,
      /** The card this is about, so the proposal is bound to its revision. */
      from: Schema.NullOr(Schema.String),
      dryRun: Schema.Boolean,
      request: Schema.String,
    },
    success: SteerOutcome,
    error: RequestConflict,
  }),
  /** A child Run on a finished one, through the follow-up its Workflow declares. */
  Rpc.make("followUp", {
    payload: {
      runId: Schema.String,
      text: Schema.String,
      request: Schema.String,
      attachments: Schema.optional(Attachments),
    },
    success: Started,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /**
   * What a Run offers to do next. Through the host because only it holds the module that
   * declared them: an offer is decided by the author's own code against the facts as they
   * are now, never by a card's memory of it.
   */
  Rpc.make("offers", {
    payload: { runId: Schema.String },
    success: Schema.Array(OfferView),
    error: HostRefused,
  }),
  /** What may be started in a project, which is what `start` takes. */
  Rpc.make("workflows", {
    payload: { project: Schema.String },
    success: Schema.Array(Startable),
  }),
  /** Every Workflow and Persona in this host's shipped and user Layers, read in full. */
  Rpc.make("definitions", { success: HostDefinitions, error: HostRefused }),
  Rpc.make("slackChoices", { success: SlackChoices, error: HostRefused }),
  /** A conversation's pending News, settled as `as` for that conversation alone. */
  Rpc.make("news", {
    payload: {
      /** The Herd whose journal it is; the asker's own where null. */
      herd: Schema.NullOr(Schema.String),
      conversation: Schema.String,
      as: NewsReceipt,
      request: Schema.String,
      /** Hand over every pending item and settle only these, which is what the conversation was given. */
      keys: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: NewsBatch,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /**
   * Focuses a Run's newest live agent, or only `agent` where it is named, else the Run's
   * workspace, on this Machine's own herdr. An open herdr window does not follow; a new
   * client attached to `session` lands there.
   */
  Rpc.make("focus", {
    payload: {
      runId: Schema.String,
      agent: Schema.optionalKey(Schema.String),
      request: Schema.String,
    },
    success: PaneAt,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** This Machine's settings that a Flock shares: those ever set, each with when. */
  Rpc.make("settings", { success: SharedSettings, error: HostRefused }),
  Rpc.make("machineOwn", { success: MachineOwn, error: HostRefused }),
  /**
   * The Flock's settings, each written with its own edit's time, where it is newer than
   * this Machine's last edit of that key.
   */
  Rpc.make("setSettings", {
    payload: { settings: Schema.Array(SharedSetting), request: Schema.String },
    success: SharedSettings,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** This Machine's shared definitions: the user Layer's files, each with its latest edit. */
  Rpc.make("sharedDefinitions", { success: Schema.Array(SharedDefinition), error: HostRefused }),
  /**
   * The Flock's shared definitions, each written with its own edit's time where it is later
   * than this Machine's, keeping the text it replaces under `replaced/`.
   */
  Rpc.make("setSharedDefinitions", {
    payload: { definitions: Schema.Array(SharedDefinition), request: Schema.String },
    success: Schema.Array(SharedDefinition),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** This Machine's Usage readings, one per Subscription (ADR-0049). */
  Rpc.make("usage", { success: Schema.Array(UsageReading), error: HostRefused }),
  /** This Machine's Harness catalogue, one per installed harness. */
  Rpc.make("models", { success: Schema.Array(HarnessCatalogue), error: HostRefused }),
  Rpc.make("connections", { success: Schema.Array(Connection), error: HostRefused }),
  Rpc.make("connectionLogin", {
    payload: { id: Schema.Literals(["gitlab", "github"]) },
    success: ConnectionLogin,
    error: HostRefused,
  }),
  /** What a sweep would remove now, and what Collie keeps and why (ADR-0045). */
  Rpc.make("cleanup", { success: CleanupReport, error: HostRefused }),
  /** This Machine's Schedules (ADR-0052). */
  Rpc.make("schedules", { success: ScheduleListing, error: HostRefused }),
  /** Adds a Schedule, paused or not, or pauses, resumes or removes one. */
  Rpc.make("changeSchedule", {
    payload: { change: ScheduleChange, request: Schema.String },
    success: ScheduleChanged,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** Sweeps now: what was removed, and what was kept and why. */
  Rpc.make("sweep", {
    payload: { request: Schema.String },
    success: CleanupReport,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /**
   * A person claimed `slug` in Helle under the identity every Run here shares, so no Run
   * may give it back: it leaves every Run's claim record. Answers the Runs it left.
   */
  Rpc.make("claimedInHelle", {
    payload: { slug: Schema.String, request: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /**
   * A read-only Collie tool answered for the asking channel as this Machine's Native chat
   * answers it, with no board selection standing in for a Run. Records nothing.
   */
  Rpc.make("read", {
    payload: {
      tool: Schema.Literals(FLOCK_READS),
      input: Schema.Record(Schema.String, Schema.Json),
    },
    success: Schema.String,
  }),
  /** Carries out what a finished Run offers, as a Run of its own. */
  Rpc.make("invoke", {
    payload: {
      runId: Schema.String,
      offer: Schema.String,
      input: Schema.Record(Schema.String, Schema.Json),
      request: Schema.String,
      attachments: Schema.optional(Attachments),
    },
    success: Started,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /**
   * One part of a file sent to this Machine, kept once by its sha256. Answers the file's
   * path once it is whole, at once where it already is, and null before then.
   */
  Rpc.make("upload", {
    payload: {
      name: Schema.String,
      size: Schema.Int,
      sha256: Schema.String,
      offset: Schema.Int,
      content: Schema.String,
    },
    success: Schema.Struct({ path: Schema.NullOr(Schema.String) }),
    error: HostRefused,
  }),
  /** Part of a file on this host's Machine, by absolute path, as base64. */
  Rpc.make("readFile", {
    payload: {
      path: Schema.String,
      offset: Schema.optional(Schema.Int),
      length: Schema.optional(Schema.Int),
    },
    success: HostFile,
    error: HostRefused,
  }),
  /** The files a pattern matches under a directory, newest first, bounded. */
  Rpc.make("glob", {
    payload: { pattern: Schema.String, path: Schema.optional(Schema.String) },
    success: Schema.Struct({ paths: Schema.Array(Schema.String), omitted: Schema.Int }),
    error: HostRefused,
  }),
  /** What a search of files finds, as ripgrep or `grep -r` says it, bounded by lines. */
  Rpc.make("grep", {
    payload: {
      pattern: Schema.String,
      path: Schema.optional(Schema.String),
      glob: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      outputMode: Schema.optional(Schema.Literals(["content", "files_with_matches", "count"])),
      ignoreCase: Schema.optional(Schema.Boolean),
      lineNumbers: Schema.optional(Schema.Boolean),
      before: Schema.optional(Schema.Int),
      after: Schema.optional(Schema.Int),
      context: Schema.optional(Schema.Int),
      headLimit: Schema.optional(Schema.Int),
      multiline: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({ text: Schema.String, omitted: Schema.Int }),
    error: HostRefused,
  }),
  /** A file written whole, never inside the host's state directory. */
  Rpc.make("writeFile", {
    payload: { path: Schema.String, content: Schema.String, request: Schema.String },
    success: Schema.Struct({ path: Schema.String, bytes: Schema.Int }),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** One string of a file replaced, as Claude Code's Edit replaces it. */
  Rpc.make("editFile", {
    payload: {
      path: Schema.String,
      oldString: Schema.String,
      newString: Schema.String,
      replaceAll: Schema.optional(Schema.Boolean),
      request: Schema.String,
    },
    success: Schema.Struct({ path: Schema.String, replaced: Schema.Int }),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
);

/**
 * An MR target names its project, not just its iid: reviewing or commenting on
 * someone else's merge request has to work from a directory that is not a
 * checkout of it, and every glab call then needs `--repo`.
 */
export interface MrRef {
  /** `host/group/project`, or null for an old target that only carried an iid. */
  project: string | null;
  iid: string;
}

/** Which forge a merge request is on: GitHub on `github.com`, GitLab on any other host. */
export type MrForge = "gitlab" | "github";

export function forgeOfRef(ref: MrRef): MrForge {
  return Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(ref.project), (present__) =>
      Option.map(Option.fromNullishOr(Str.split(present__, "/")[0]), (present___) =>
        Str.toLowerCase(present___),
      ),
    ),
  ) === "github.com"
    ? "github"
    : "gitlab";
}

const MR_TARGET = /^mr:(?:(.*)([!#]))?(\d+)$/;
const MR_URL =
  /^(?:https?:\/\/)?(?:(github\.com\/[^/\s]+\/[^/\s]+)\/pull|([^/\s]+\/.+?)\/-\/merge_requests)\/(\d+)(?:[/?#]|$)/i;

/**
 * The one reading of a merge request reference: an `mr:` target, a merge request or pull
 * request URL, GitHub's `owner/repo#30`, and, where `typedIn` says which checkout it was typed in, `!42`, `#42` or
 * `42`. Null for anything else.
 */
export function readMrRef(
  text: string,
  typedIn?: { readonly project: string | null },
): MrRef | null {
  const said = Str.trim(text);
  const target = MR_TARGET.exec(said);
  if (target) {
    const [, project = "", sign, iid] = target;
    if (project === "") return { project: null, iid: iid! };
    const ref = { project, iid: iid! };
    return (sign === "#") === (forgeOfRef(ref) === "github") ? ref : null;
  }
  const url = MR_URL.exec(said);
  if (url) return { project: (url[1] ?? url[2])!, iid: url[3]! };
  // `owner/repo#30` is how GitHub names a pull request, wherever it is typed.
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(said);
  if (short) return { project: `github.com/${short[1]}`, iid: short[2]! };
  const typed = typedIn === undefined ? null : /^[!#]?(\d+)$/.exec(said);
  return typed ? { project: typedIn!.project, iid: typed[1]! } : null;
}

/** `mr:gitlab.example.com/group/project!42`, `mr:github.com/owner/repo#30` or the bare `mr:42`. */
export function parseMrTarget(target: string): MrRef | null {
  return pipe(target, Str.startsWith("mr:")) ? readMrRef(target) : null;
}

/** A merge request or pull request URL, the way a forge reports what it opened. */
export function parseMrUrl(url: string): MrRef | null {
  return pipe(Str.trim(url), Str.startsWith("mr:")) ? null : readMrRef(url);
}

/** `group/project` of `host/group/project`: the host is where, not what. */
export function mrPath(ref: MrRef): string {
  const project = ref.project ?? "";
  return /^[^/]+\.[^/]+\/(.+)$/.exec(project)?.[1] ?? project;
}

/** The one writing of a merge request reference: each way Collie names one. */
export function mrWords(ref: MrRef) {
  const github = forgeOfRef(ref) === "github";
  const sign = github ? "#" : "!";
  const project = ref.project ?? "";
  const path = mrPath(ref);
  return {
    target: ref.project === null ? `mr:${ref.iid}` : `mr:${project}${sign}${ref.iid}`,
    label: ref.project === null ? ref.iid : `${path}${sign}${ref.iid}`,
    short: `${Str.split(project, "/").pop()}${sign}${ref.iid}`,
    url:
      ref.project === null
        ? null
        : `https://${project}/${github ? "pull" : "-/merge_requests"}/${ref.iid}`,
    noun: github ? "pull request" : "merge request",
    checks: github ? "checks" : "pipeline",
    sign,
  };
}

export function mrTarget(project: string | null, iid: string): string {
  return mrWords({ project: project || null, iid }).target;
}

/**
 * What an offer's arguments take, from what a human typed into each: text as typed for a
 * text field, anything else as the JSON it spells where it parses. Blank optional fields
 * are left out.
 */
export const offerInput = (drawn: Schema.Json | null, typed: Readonly<Record<string, string>>) => {
  const takes = decodeArguments(drawn);
  const input: { [name: string]: Schema.Json } = {};
  if (takes._tag === "None") return input;
  for (const [name, field] of Rec.toEntries(takes.value.properties ?? {})) {
    const text = typed[name] ?? "";
    if (text === "" && !(takes.value.required ?? []).includes(name)) continue;
    const parsed = isTextField(field) ? Option.none() : parseJson(text);
    input[name] = Option.isSome(parsed) ? parsed.value : text;
  }
  return input;
};

/** What was given an offer as text, each value read as `offerInput` reads it; nothing added. */
export const givenOfferInput = (
  drawn: Schema.Json | null,
  given: Readonly<Record<string, string>>,
): { [name: string]: Schema.Json } => {
  const typed = offerInput(drawn, given);
  return Rec.fromEntries(
    Arr.map(
      Rec.toEntries(given),
      ([name, text]) => [name, Rec.has(typed, name) ? typed[name]! : text] as const,
    ),
  );
};

/** The fields an offer's arguments name, and whether each must be given. */
export const offerFields = (drawn: Schema.Json | null) => {
  const takes = decodeArguments(drawn);
  if (takes._tag === "None") return [];
  return Arr.map(Struct.keys(takes.value.properties ?? {}), (name) => ({
    name,
    required: (takes.value.required ?? []).includes(name),
  }));
};

const decodeArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const isTextField = Schema.is(Schema.Struct({ type: Schema.Literal("string") }));
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** Nothing is driving it any more, so there is nothing to stop, steer or answer. */
export function isSettled(state: TaskState): boolean {
  return state === "done" || state === "failed" || state === "stopped" || state === "abandoned";
}

/** It ended without finishing, so it can be taken up again where it stopped. */
export function canResume(state: TaskState): boolean {
  return state === "failed" || state === "stopped" || state === "abandoned";
}

export interface FlowActionFacts {
  readonly canResume: boolean;
  readonly held: boolean;
  readonly proposal: Proposal | null;
}
export function flowActions(
  flow: Flow,
  view: TaskView,
  runs: ReadonlyMap<string, FlowActionFacts> = new Map(),
): Flow {
  const factsOf = (lane: FlowLane): FlowActionFacts =>
    runs.get(lane.run) ?? {
      canResume:
        lane.execution !== "failed" &&
        lane.execution !== "completed" &&
        (lane.run === view.run
          ? canResume(view.state)
          : ["stopped", "died"].includes(lane.execution)),
      held: lane.run === view.run && view.held !== null,
      proposal: lane.run === view.run && view.decision?.kind === "proposal" ? view.decision : null,
    };
  const offered = (node: FlowRun, lane: FlowLane, facts: FlowActionFacts): FlowRun => {
    let primary: FlowAction | null = null;
    const actions: FlowAction[] = [];
    const live = node.agent != null && Arr.some(view.agents, (one) => one.name === node.agent);
    const proposal = node.proposal ?? facts.proposal ?? undefined;
    if (node.link !== undefined) {
      if (node.link.run !== null) primary = "open";
      if (node.link.canResume === true && node.link.machine === lane.machine) actions.push("retry");
    } else if (node.kind === "offer") {
      if (node.id === `offer:${view.offer?.id}` && lane.run === view.run) primary = "start";
    } else if (
      Arr.some(node.questions, (one) => one.id !== undefined && (one.open ?? one.answered === null))
    ) {
      primary = "answer";
      if (live) actions.push("terminal");
    } else if (node.wait === "proposal" && proposal !== undefined) primary = "proposal";
    else if (node.wait === "hold" && facts.held) primary = "continue";
    else if (
      node.kind !== "release" &&
      (node.state === "failed" || node.state === "stopped") &&
      facts.canResume
    )
      primary = "retry";
    else if (
      node.url !== undefined &&
      (node.kind === "release" || node.produces === "merge-request")
    )
      primary = "open";
    else if (live && node.state === "done") actions.push("tell");
    else if (
      live &&
      (node.wait === "stalled" ||
        node.wait === "parked" ||
        (node.state === "running" && node.kind === "agent" && node.wait === null))
    ) {
      primary = "terminal";
      actions.push("tell");
    }
    if (node.log != null) actions.push("log");
    const running = ["running", "suspended"].includes(lane.execution) || facts.canResume;
    const step = node.declared && ["agent", "check", "question", "workflow"].includes(node.kind);
    const target =
      node.state === "expected"
        ? node
        : flow.current?.run === lane.run && flow.current.node === node.id
          ? Option.getOrUndefined(
              Arr.findFirst(
                lane.nodes.slice(
                  Option.getOrElse(
                    Arr.findFirstIndex(lane.nodes, (one) => one.id === node.id),
                    () => -1,
                  ) + 1,
                ),
                (one) => one.declared && !one.offPath && one.state === "expected",
              ),
            )
          : undefined;
    if (running && step && target?.declared && !target.offPath) actions.push("pause");
    if (
      running &&
      step &&
      node.state !== "not-run" &&
      node.kind !== "question" &&
      (node.state !== "done" ||
        Option.getOrUndefined(
          Option.map(
            Option.fromNullishOr(
              Option.getOrUndefined(Arr.findFirst(lane.nodes, (one) => one.id === node.id)),
            ),
            (present) => Arr.some(present.runs, (one) => one.state === "expected"),
          ),
        ))
    )
      actions.push("note");
    if (primary === "retry" && step) actions.push("retry-noted");
    if (node.kind === "check" || node.produces === "evidence" || (node.evidence ?? 0) > 0)
      actions.push("evidence");
    return {
      ...node,
      primary,
      actions,
      pauseTarget: target?.id,
      proposal: node.wait === "proposal" ? proposal : undefined,
    };
  };
  const lanes = Arr.map(flow.lanes, (lane): FlowLane => {
    const facts = factsOf(lane);
    const settled =
      lane.run === view.run
        ? isSettled(view.state)
        : !["running", "suspended"].includes(lane.execution);
    const actions: FlowLaneAction[] = [];
    if (!settled) actions.push(facts.held ? "release" : "hold", "stop");
    if (facts.canResume) actions.push("resume");
    if (lane.run === view.run && view.state === "done") actions.push("follow-up");
    return {
      ...lane,
      actions,
      nodes: Arr.map(lane.nodes, (node): FlowNode => ({
        ...offered(node, lane, facts),
        runs: Arr.map(node.runs, (one) => offered(one, lane, facts)),
        links: Option.getOrUndefined(
          Option.map(Option.fromNullishOr(node.links), (present_) =>
            Arr.map(present_, (one) => offered(one, lane, facts)),
          ),
        ),
      })),
    };
  });
  const leading = Option.getOrUndefined(Arr.findFirst(lanes, (lane) => lane.run === view.run));
  const release =
    flow.release === null || leading === undefined
      ? flow.release
      : Arr.map(flow.release, (node): FlowNode => ({
          ...offered(node, leading, factsOf(leading)),
          runs: node.runs,
        }));
  return { ...flow, lanes, release };
}

/** However the Task names its merge request: the URL one opened, or the target one was pointed at. */
export function mrRefOf(mr: string | null): MrRef | null {
  return mr === null ? null : readMrRef(mr);
}

/** Where a merge request is read in a browser, where its target says which project. */
export function mrUrlOf(ref: MrRef): string | null {
  return mrWords(ref).url;
}

type DispositionKind = "merged" | "abandoned" | "superseded";

/** One thing a card can be asked for. Each front door draws it its own way. */
export type CardAction =
  | { readonly kind: "go-to-tab" }
  | { readonly kind: "steer" }
  | { readonly kind: "attach" }
  | { readonly kind: "open-mr"; readonly mr: MrRef }
  | { readonly kind: "offer"; readonly offer: BoardOffer }
  | { readonly kind: "check-output" }
  | { readonly kind: "offers" }
  | { readonly kind: "resume" }
  | { readonly kind: "follow-up" }
  | { readonly kind: "hold"; readonly set: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "dispose"; readonly disposition: DispositionKind; readonly ref: string }
  | { readonly kind: "acknowledge" };

/** `collie!151` or `collie#30` rather than the whole URL: a disposition's ref ends up in the card's sentence. */
const dispose = (view: TaskView, disposition: DispositionKind): CardAction => {
  const mr = mrRefOf(view.mr);
  const ref = disposition === "abandoned" || mr === null ? "" : mrWords(mr).short;
  return { kind: "dispose", disposition, ref };
};

/** "merge request", or "pull request" for one on GitHub, however it is named. */
export function mrNounOf(mr: string): string {
  const ref = readMrRef(mr);
  return ref === null ? "merge request" : mrWords(ref).noun;
}

/** The Open action's label, in the merge request's own forge's words. */
export function openMrLabel(mr: MrRef, primary: boolean): string {
  const github = forgeOfRef(mr) === "github";
  if (primary) return github ? "Open PR" : "Open MR";
  return github ? "Open pull request" : "Open merge request";
}

/**
 * What this Task can be asked for, in the order a menu shows it. Only what would work: an
 * item the human has to try to find out is refused is worse than no item.
 */
export function cardActions(view: TaskView): CardAction[] {
  const actions: CardAction[] = [{ kind: "go-to-tab" }];
  if (!isSettled(view.state)) actions.push({ kind: "steer" }, { kind: "attach" });
  const mr = mrRefOf(view.mr);
  if (mr !== null) actions.push({ kind: "open-mr", mr });
  if (view.offer !== null) actions.push({ kind: "offer", offer: view.offer });
  if (view.check !== null) actions.push({ kind: "check-output" });
  actions.push({ kind: "offers" });
  if (canResume(view.state)) actions.push({ kind: "resume" });
  if (view.state === "done") actions.push({ kind: "follow-up" });
  if (!isSettled(view.state)) {
    actions.push({ kind: "hold", set: view.held === null });
    actions.push({ kind: "stop" });
  }
  return actions;
}

/**
 * The one action that ends a card's wait, drawn first on it. Working cards go to their
 * tab; waiting cards get the action that lands or retires the work; an unseen report gets
 * Acknowledge; any other finished or decision card has none — its buttons are the
 * decision's own, or the menu's.
 */
export function primaryAction(view: TaskView): CardAction | null {
  if (view.decision !== null) return null;
  if (view.state === "active" || view.state === "quiet") return { kind: "go-to-tab" };
  if (view.unseen === true) return { kind: "acknowledge" };
  if (view.landed) return null;
  // Whatever the plan's module offers first, under its own title; none, no button.
  if (view.planReady) return view.offer === null ? null : { kind: "offer", offer: view.offer };
  if (canResume(view.state)) return { kind: "resume" };
  if (view.mrState === "closed") return dispose(view, "superseded");
  const mr = mrRefOf(view.mr);
  return mr === null ? null : { kind: "open-mr", mr };
}

/**
 * What became of the work, for any settled Task: a Run that failed and was finished by
 * hand is what a disposition is for. Superseded where its merge request was closed.
 */
export function dispositionActions(view: TaskView): CardAction[] {
  if (!isSettled(view.state)) return [];
  const kinds: DispositionKind[] = ["merged", "abandoned"];
  if (view.mrState === "closed") kinds.push("superseded");
  return Arr.map(kinds, (kind) => dispose(view, kind));
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

/** The order every board draws its sections in, and what each is called. */
export const SECTIONS: ReadonlyArray<readonly [Section, string]> = [
  ["needs-you", "Needs you"],
  ["waiting", "Waiting on you"],
  ["working", "Working"],
  ["finished", "Finished"],
];
const SECTION_ORDER = new Map(Arr.map(SECTIONS, ([section], at) => [section, at]));
const STATE_RANK = new Map<TaskState, number>(Arr.map(STATE_ORDER, (state, at) => [state, at]));

/**
 * The board's order: the sections, then the state order inside Needs you and what is
 * ready to release inside Waiting on you, then whatever changed last. Nothing else is
 * ranked — a board that reordered itself on every tick is one a human cannot point at.
 */
export function sortBoard(views: ReadonlyArray<TaskView>): TaskView[] {
  return [...views].sort(
    (a, b) =>
      SECTION_ORDER.get(sectionOf(a))! - SECTION_ORDER.get(sectionOf(b))! ||
      (sectionOf(a) === "needs-you" ? STATE_RANK.get(a.state)! - STATE_RANK.get(b.state)! : 0) ||
      Number(b.ready ?? false) - Number(a.ready ?? false) ||
      // What moved last is at the top: in Working what is doing something, in Waiting on
      // you what you were just doing.
      (b.ended ?? b.at) - (a.ended ?? a.at),
  );
}

/** Waiting on you shows a week open; what is older folds into one counted line. */
export const WAIT_FOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface Sections {
  needs: TaskView[];
  working: TaskView[];
  waiting: TaskView[];
  finished: TaskView[];
}

/**
 * Waiting on you, split at a week: what is older folds into one counted line. Work ready
 * to release is never folded, however long it has waited.
 */
export function foldWaiting(waiting: ReadonlyArray<TaskView>, now: number) {
  const old = (view: TaskView) => !view.ready && (view.ended ?? view.at) < now - WAIT_FOLD_MS;
  return { recent: Arr.filter(waiting, (view) => !old(view)), older: Arr.filter(waiting, old) };
}

/** Finished, split by whether a report in it is still unseen: those are drawn outside the collapsed list. */
export function foldFinished(finished: ReadonlyArray<TaskView>) {
  return {
    unseen: Arr.filter(finished, (view) => view.unseen === true),
    seen: Arr.filter(finished, (view) => view.unseen !== true),
  };
}

/** What a search is matched against: what a human remembers about a Task, and no ids. */
function haystack(view: TaskView): string {
  return Str.toLowerCase(
    Arr.join(
      [
        view.name,
        view.project,
        view.branch ?? "",
        ...Arr.flatMap(view.agents, (agent) => [agent.name, agent.now ?? ""]),
      ],
      " ",
    ),
  );
}

export function matchesTask(view: TaskView, query: string): boolean {
  const wanted = Str.toLowerCase(Str.trim(query));
  return wanted === "" || pipe(haystack(view), Str.includes(wanted));
}

/**
 * The four sections, in the order the board draws them, from a list already in the
 * board's own order. The search narrows them all the same way: a Task hidden from one
 * section must not be visible in another.
 */
export function sectionsOf(views: ReadonlyArray<TaskView>, query: string): Sections {
  const found = Arr.filter(views, (view) => matchesTask(view, query));
  return {
    needs: Arr.filter(found, (view) => sectionOf(view) === "needs-you"),
    working: Arr.filter(found, (view) => sectionOf(view) === "working"),
    waiting: Arr.filter(found, (view) => sectionOf(view) === "waiting"),
    finished: Arr.filter(found, (view) => sectionOf(view) === "finished"),
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
  const needs = Arr.filter(views, (view) => sectionOf(view) === "needs-you").length;
  const working = Arr.filter(views, (view) => sectionOf(view) === "working");
  const quiet = Arr.filter(working, (view) => view.state === "quiet").length;
  const opening =
    needs === 0
      ? "Nothing needs you."
      : // Not "decisions": an agent at its harness's own dialog is counted here too, and
        // it is a pane to go to rather than anything this board can answer.
        `${needs === 1 ? "One task is" : `${needs} tasks are`} waiting on you.`;
  const gone = quiet === 0 ? "" : `, ${quiet} gone quiet`;
  const waitingAll = Arr.filter(views, (view) => sectionOf(view) === "waiting");
  const waiting = now === undefined ? waitingAll : foldWaiting(waitingAll, now).recent;
  const ready = Arr.filter(waiting, (view) => Boolean(view.ready)).length;
  const held = [
    ...(ready === 0 ? [] : [`${ready} ready to release`]),
    ...(waiting.length === ready ? [] : [`${waiting.length - ready} waiting on you`]),
  ];
  const inHand = held.length === 0 ? "" : ` ${Arr.join(held, ", ")}.`;
  return { text: `${opening}${inHand} ${working.length} working${gone}.`, urgent: needs > 0 };
}

/**
 * `group/project!42` or `owner/repo#30` for a merge request, however it is named; anything
 * else as it is.
 */
export function mrLabel(mr: string): string {
  const ref = readMrRef(mr);
  if (ref) return mrWords(ref).label;
  const bare = pipe(mr, Str.startsWith("mr:")) ? pipe(mr, Str.slice(3)) : mr;
  const host = /^[^/!]+\.[^/!]+\/(.+)$/.exec(bare);
  return host ? host[1]! : bare;
}
