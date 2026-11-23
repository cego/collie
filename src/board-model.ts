// WARNING: no I/O and no Bun-only import: a browser bundle imports this too.
import { NarrativeReport } from "./narrative-model";
import {
  Artefact,
  ArtefactCollection,
  ArtefactMatches,
  ArtefactRegistered,
  ArtefactSearch,
  RegisterArtefact,
} from "./artefact-model";
import * as Str from "effect/String";
import { flow, pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { IntentSeedSchema } from "./intent-model";
import { ScheduleChange, ScheduleChanged, ScheduleListing } from "./schedule-model";
import { Park } from "./park-cause";
import { VerifyEvent, Pass, VerificationSchema } from "./verify-model";
import { MeasureEvent } from "./measurement-model";

export { PASSES, Pass } from "./verify-model";
import { IntentChangeSchema, ChangedIntent } from "./intent-model";
import { UsageReading } from "./usage-model";
import { HarnessCatalogue } from "./catalogue-model";
import { ConnectionLogin, HostConnections } from "./connection-model";
import { HostDefinitions, SharedDefinition } from "./definitions-model";
import { VerifySpecSchema } from "./verify-spec";
import { OwnInventory, OwnWords } from "./own-words-model";
import { MERGE_POLL_MS, ShippingAction, ShippingGo } from "./shipping";

const STATE_ORDER = [
  "blocked",
  "active",
  "quiet",
  "failed",
  "stopped",
  "abandoned",
  "done",
] as const;

export const TaskState = Schema.Literals(STATE_ORDER);
export type TaskState = typeof TaskState.Type;

export const StepState = Schema.Literals(["done", "active", "blocked", "failed", "todo"]);
export type StepState = typeof StepState.Type;

export const BoardStep = Schema.Struct({ name: Schema.String, state: StepState });
export type BoardStep = typeof BoardStep.Type;

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

export const FlowClock = Schema.Struct({
  from: Schema.Finite,
  before: Schema.String,
  after: Schema.String,
});
export type FlowClock = typeof FlowClock.Type;

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

export const FlowStrip = Schema.Struct({
  glyphs: Schema.Array(Schema.Struct({ title: Schema.String, state: FlowState })),
  release: Schema.Finite,
  current: Schema.NullOr(
    Schema.Struct({ title: Schema.String, said: Schema.NullOr(Schema.String) }),
  ),
});
export type FlowStrip = typeof FlowStrip.Type;

export const Solution = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  recommended: Schema.optionalKey(Schema.Boolean),
});
export type Solution = typeof Solution.Type;

export const RecordedSolution = Schema.Union([
  Solution,
  Schema.String.pipe(
    Schema.decodeTo(Solution, {
      decode: SchemaGetter.transform((title) => ({ id: title, title })),
      encode: SchemaGetter.forbidden(() => "a solution is recorded in its current shape"),
    }),
  ),
]);

export const AuthoredSolution = Schema.Union([
  Schema.String.pipe(
    Schema.decodeTo(Solution, {
      decode: SchemaGetter.transform((id) => ({ id, title: id })),
      encode: SchemaGetter.forbidden(() => "an authored solution is only read"),
    }),
  ),
  Schema.Struct({ ...Solution.fields, title: Schema.optionalKey(Schema.String) }).pipe(
    Schema.decodeTo(Solution, {
      decode: SchemaGetter.transform((one) => ({ ...one, title: one.title ?? one.id })),
      encode: SchemaGetter.forbidden(() => "an authored solution is only read"),
    }),
  ),
]);

export const recommendedFirst = (solutions: ReadonlyArray<Solution>) => [
  ...Arr.filter(solutions, (one) => one.recommended === true),
  ...Arr.filter(solutions, (one) => one.recommended !== true),
];

export const boardOption = (solution: Solution) => ({
  ...solution,
  subtitle: solution.detail ?? null,
});

export const solutionTitle = (solution: Solution) =>
  solution.recommended === true ? `${solution.title} (Recommended)` : solution.title;

export const holdReason = (decision: string) => `held at question ${decision}`;

export const holdPath = (
  question: { readonly options: ReadonlyArray<unknown>; readonly asker?: string | null },
  held: boolean,
) => {
  if (question.asker != null || question.options.length === 0 || question.options.length >= 3)
    return undefined;
  return held ? { offered: false, why: "Run already held" } : { offered: true, why: null };
};

export const Question = Schema.Struct({
  shipping: Schema.optionalKey(ShippingGo),
  kind: Schema.Literal("question"),
  run: Schema.String,
  id: Schema.String,
  step: Schema.String,
  topic: Schema.String,
  text: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      subtitle: Schema.NullOr(Schema.String),
      detail: Schema.optionalKey(Schema.String),
      recommended: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  hold: Schema.optionalKey(
    Schema.Struct({ offered: Schema.Boolean, why: Schema.NullOr(Schema.String) }),
  ),
  steer: Schema.optionalKey(
    Schema.Struct({ agent: Schema.NullOr(Schema.String), why: Schema.NullOr(Schema.String) }),
  ),
  shortfall: Schema.optionalKey(Schema.String),
});
export type Question = typeof Question.Type;

export const Proposal = Schema.Struct({
  kind: Schema.Literal("proposal"),
  id: Schema.String,
  hash: Schema.String,
  text: Schema.String,
  actions: Schema.Array(Schema.Struct({ text: Schema.String, allowed: Schema.Boolean })),
});
export type Proposal = typeof Proposal.Type;

export const Decision = Schema.Union([Question, Proposal]);
export type Decision = typeof Decision.Type;

export const BoardAgent = Schema.Struct({
  name: Schema.String,
  role: Schema.optionalKey(Schema.String),
  status: Schema.String,
  now: Schema.NullOr(Schema.String),
  run: Schema.String,
  fallback: Schema.optionalKey(Schema.String),
});
export type BoardAgent = typeof BoardAgent.Type;

export const BoardChild = Schema.Struct({
  repo: Schema.String,
  run: Schema.NullOr(Schema.String),
  state: StepState,
  mr: Schema.NullOr(Schema.String),
});
export type BoardChild = typeof BoardChild.Type;

export const BoardOffer = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  run: Schema.optionalKey(Schema.String),
  unavailable: Schema.optionalKey(Schema.String),
});
export type BoardOffer = typeof BoardOffer.Type;

export const MrState = Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]);
export type MrState = typeof MrState.Type;

export const Checks = Schema.Union([
  Schema.Struct({ state: Schema.Literal("passed"), at: Schema.String }),
  Schema.Struct({ state: Schema.Literal("failed"), name: Schema.String, at: Schema.String }),
  Schema.Struct({ state: Schema.Literal("running") }),
  Schema.Struct({ state: Schema.Literal("unchecked") }),
]);
export type Checks = typeof Checks.Type;

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

export const Mergeability = Schema.Struct({
  state: Schema.Literals(["mergeable", "blocked", "unknown"]),
  said: Schema.String,
});
export type Mergeability = typeof Mergeability.Type;

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

export const ReadyToRelease = Schema.Struct({
  ready: Schema.Boolean,
  missing: Schema.Array(MissingFact),
});
export type ReadyToRelease = typeof ReadyToRelease.Type;

export interface ReleaseFacts {
  readonly now: number;
  readonly read: number | null;
  readonly head: string | null;
  readonly readHead: string | null;
  readonly unreadable?: boolean;
  readonly succeeded: boolean;
  readonly mr: string | null;
  readonly mrState: MrState | null;
  readonly draft: boolean;
  readonly checks: Checks | null;
  readonly ci: ForgeChecks | null;
  readonly blocking: number;
  readonly mergeable: Mergeability | null;
}

export function readyToRelease(facts: ReleaseFacts) {
  const missing: Array<MissingFact> = [];
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
    if (
      facts.unreadable ||
      facts.read === null ||
      !Number.isFinite(facts.read) ||
      facts.read > facts.now ||
      facts.now - facts.read > 2 * MERGE_POLL_MS ||
      facts.head === null ||
      facts.head !== facts.readHead
    )
      lack("mergeable", "the forge answer is stale, unreadable or not at the current head", true);
    else if (facts.mergeable === null)
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

export const RunningCheck = Schema.Struct({
  name: Schema.String,
  pass: Pass,
  round: Schema.NullOr(Schema.Finite),
  revision: Schema.String,
  base: Schema.NullOr(Schema.String),
  job: Schema.optionalKey(Schema.String),
  elapsedMs: Schema.NullOr(Schema.Finite),
  usualMs: Schema.NullOr(Schema.Finite),
  others: Schema.Finite,
  sentence: Schema.String,
  log: Schema.NullOr(Schema.String),
  lastLines: Schema.Array(Schema.String),
});
export type RunningCheck = typeof RunningCheck.Type;

export const Reopened = Schema.Struct({
  delivery: Schema.String,
  agent: Schema.String,
  told: Schema.NullOr(Schema.String),
  status: Schema.String,
});
export type Reopened = typeof Reopened.Type;

export const RunRevision = Schema.Struct({ epoch: Schema.String, seq: Schema.Finite });
export type RunRevision = typeof RunRevision.Type;

export const TaskMr = Schema.Struct({
  id: Schema.String,
  mr: Schema.String,
  label: Schema.String,
  short: Schema.String,
  url: Schema.NullOr(Schema.String),
  run: Schema.String,
  state: Schema.NullOr(MrState),
  checks: Schema.NullOr(Checks),
  head: Schema.NullOr(Schema.String),
  ready: Schema.Boolean,
  disposition: Schema.NullOr(Schema.String),
  settled: Schema.optionalKey(
    Schema.NullOr(Schema.Literals(["merged", "abandoned", "superseded"])),
  ),
  waitsOn: Schema.Array(Schema.String),
});
export type TaskMr = typeof TaskMr.Type;

export const mrReadiness = (one: TaskMr, mrs: ReadonlyArray<TaskMr>) => {
  const shortOf = new Map(Arr.map(mrs, (other) => [other.id, other.short]));
  const waits = Arr.map(one.waitsOn, (id) => shortOf.get(id) ?? id);
  const head = one.head === null ? "" : ` at ${pipe(one.head, Str.slice(0, 8))}`;
  return Arr.join(
    [
      one.state ?? "not watched",
      one.ready ? `ready to release${head}` : "not ready to release",
      ...(waits.length === 0 ? [] : [`waits on ${Arr.join(waits, ", ")}`]),
    ],
    ", ",
  );
};

export const TaskView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.String,
  herd: Schema.optionalKey(Schema.String),
  state: TaskState,
  narratives: Schema.optionalKey(Schema.Array(NarrativeReport)),
  steps: Schema.Array(BoardStep),
  sentence: Schema.String,
  age: Schema.String,
  drift: Schema.NullOr(Schema.String),
  held: Schema.NullOr(Schema.String),
  park: Schema.optionalKey(Schema.NullOr(Park)),
  recovery: Schema.optionalKey(Schema.Array(Schema.String)),
  heldBy: Schema.NullOr(Schema.Struct({ by: Schema.String, reason: Schema.String })),
  decision: Schema.NullOr(Decision),
  questions: Schema.optionalKey(Schema.Array(Question)),
  agents: Schema.Array(BoardAgent),
  children: Schema.Array(BoardChild),
  mr: Schema.NullOr(Schema.String),
  mrs: Schema.optionalKey(Schema.Array(TaskMr)),
  branch: Schema.NullOr(Schema.String),
  disposition: Schema.NullOr(Schema.String),
  landed: Schema.Boolean,
  unseen: Schema.optionalKey(Schema.Boolean),
  ended: Schema.NullOr(Schema.Finite),
  mrState: Schema.NullOr(MrState),
  checks: Schema.optionalKey(Schema.NullOr(Checks)),
  ready: Schema.optionalKey(Schema.Boolean),
  shipping: Schema.optionalKey(Schema.NullOr(ShippingAction)),
  shippingMr: Schema.optionalKey(Schema.NullOr(Schema.String)),
  readiness: Schema.optionalKey(ReadyToRelease),
  check: Schema.optionalKey(Schema.NullOr(RunningCheck)),
  reopened: Schema.optionalKey(Schema.NullOr(Reopened)),
  planReady: Schema.Boolean,
  offer: Schema.NullOr(BoardOffer),
  offers: Schema.optionalKey(Schema.Array(BoardOffer)),
  run: Schema.String,
  runs: Schema.Array(Schema.String),
  at: Schema.Finite,
  flow: Schema.optionalKey(FlowStrip),
  revision: Schema.optionalKey(RunRevision),
});
export type TaskView = typeof TaskView.Type;

export const Panel = Schema.Union([
  Schema.TaggedStruct("None", { reason: Schema.String }),
  Schema.TaggedStruct("Text", { text: Schema.String, truncated: Schema.Boolean }),
]);
export type Panel = typeof Panel.Type;

export const PlanTicket = Schema.Struct({
  file: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
  stamp: Schema.optional(Schema.String),
});
export type PlanTicket = typeof PlanTicket.Type;

export const PlanPanel = Schema.Struct({
  spec: Panel,
  specStamp: Schema.optional(Schema.String),
  tickets: Schema.Array(PlanTicket),
});
export type PlanPanel = typeof PlanPanel.Type;

export const OutputPanel = Schema.Struct({
  step: Schema.String,
  where: Schema.String,
  state: Schema.Literals(["recorded", "missing", "unreadable"]),
  text: Schema.String,
});
export type OutputPanel = typeof OutputPanel.Type;

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
  reason: Schema.String,
  explanation: Schema.String,
  actions: Schema.Array(Schema.String),
});
export type Attention = typeof Attention.Type;

export const Metrics = Schema.Struct({
  timeToFirstEvidence: Schema.NullOr(Schema.Finite),
  verifications: Schema.Struct({
    pass: Schema.Finite,
    fail: Schema.Finite,
    unstable: Schema.Finite,
    byCollie: Schema.Finite,
  }),
  slices: Schema.Struct({ done: Schema.Finite, total: Schema.Finite }),
  rework: Schema.Finite,
  peakContext: Schema.NullOr(Schema.Struct({ agent: Schema.String, tokens: Schema.Finite })),
  halts: Schema.Array(Schema.String),
  obstacles: Schema.Array(Schema.String),
});
export type Metrics = typeof Metrics.Type;

// WARNING: every field but the iid is optional on the wire, since GitLab's shape varies by version and token.
export const MrDetails = Schema.TaggedStruct("Details", {
  iid: Schema.String,
  project: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: Schema.String,
  author: Schema.String,
  assignees: Schema.Array(Schema.String),
  sourceBranch: Schema.String,
  fork: Schema.optionalKey(Schema.Boolean),
  targetBranch: Schema.String,
  pipeline: Schema.String,
  checks: Schema.optionalKey(ForgeChecks),
  approvals: Schema.String,
  unresolved: Schema.Boolean,
  notes: Schema.Finite,
  comments: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.String })),
  ),
  headSha: Schema.String,
  head: Schema.optionalKey(Schema.String),
  mergedSha: Schema.String,
  mergedAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.Finite,
  url: Schema.String,
  autoMerge: Schema.optionalKey(Schema.Boolean),
  mergeable: Schema.optionalKey(Mergeability),
});
export type MrDetails = typeof MrDetails.Type;

export const MrUnavailable = Schema.TaggedStruct("Unavailable", {
  reason: Schema.String,
  transient: Schema.optionalKey(Schema.Boolean),
});
export type MrUnavailable = typeof MrUnavailable.Type;

export const MrPanel = Schema.Union([MrDetails, MrUnavailable]);
export type MrPanel = typeof MrPanel.Type;

export const DiffFile = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["added", "modified", "deleted"]),
  added: Schema.NullOr(Schema.Int),
  removed: Schema.NullOr(Schema.Int),
});

export type DiffFile = typeof DiffFile.Type;

export const RunDiff = Schema.Struct({
  base: Schema.String,
  live: Schema.Boolean,
  files: Schema.Array(DiffFile),
});

export type RunDiff = typeof RunDiff.Type;

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

export const ReviewFinding = Schema.Struct({
  severity: Schema.String,
  title: Schema.String,
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Finite),
  detail: Schema.NullOr(Schema.String),
});
export type ReviewFinding = typeof ReviewFinding.Type;

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

export const EvidenceFile = Schema.Struct({ name: Schema.String, bytes: Schema.Int });
export type EvidenceFile = typeof EvidenceFile.Type;

export const AttachmentFile = Schema.Struct({
  name: Schema.String,
  size: Schema.Int,
  mediaType: Schema.String,
});
export type AttachmentFile = typeof AttachmentFile.Type;

export const RunFile = Schema.Struct({
  ref: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  size: Schema.Int,
});

export const HostFile = Schema.Struct({
  path: Schema.String,
  size: Schema.Int,
  mediaType: Schema.String,
  content: Schema.String,
});
export type HostFile = typeof HostFile.Type;

export const PART_BYTES = 4 * 1024 * 1024;

export type RunFile = typeof RunFile.Type;

export const RanOn = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});

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

const ReportTry = Schema.Struct({
  state: Schema.Literals(["delivered", "undelivered"]),
  at: Schema.String,
  note: Schema.String,
});
export const RunReport = Schema.Struct({
  ...ReportTry.fields,
  unreached: Schema.optionalKey(Schema.Boolean),
  tries: Schema.optionalKey(Schema.Array(ReportTry)),
  closed: Schema.Boolean,
  closure: Schema.optionalKey(Schema.String),
});
export type RunReport = typeof RunReport.Type;

export const RunAgent = Schema.Struct({
  operation: Schema.String,
  agent: Schema.String,
  harness: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  from: Schema.NullOr(RanOn),
  why: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
});
export type RunAgent = typeof RunAgent.Type;

export const AgentFallback = Schema.Struct({
  run: Schema.String,
  agent: Schema.String,
  on: Schema.String,
  next: Schema.String,
});
export type AgentFallback = typeof AgentFallback.Type;

export const choiceSaid = (on: {
  readonly harness: string;
  readonly model: string | null;
  readonly effort: string | null;
}) => `${on.harness}/${on.model ?? "default"}${on.effort === null ? "" : ` ${on.effort}`}`;

export const ranOn = (agent: RunAgent) => {
  const on = choiceSaid(agent);
  if (agent.from !== null) return `${on} (fell back from ${choiceSaid(agent.from)}: ${agent.why})`;
  return agent.why === null ? on : `${on} (${agent.why})`;
};

export const FlowAttempt = Schema.Struct({
  at: Schema.String,
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

export const FlowLink = Schema.Struct({
  run: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  state: FlowState,
  said: Schema.NullOr(Schema.String),
  asOf: Schema.optionalKey(Schema.NullOr(Schema.String)),
  canResume: Schema.optional(Schema.Boolean),
  clock: Schema.optionalKey(FlowClock),
});
export type FlowLink = typeof FlowLink.Type;

const FlowNodeFields = {
  id: Schema.String,
  title: Schema.String,
  kind: Schema.Literals(["agent", "question", "workflow", "check", "release", "offer", "link"]),
  description: Schema.String,
  role: Schema.NullOr(Schema.String),
  declared: Schema.Boolean,
  state: FlowState,
  said: Schema.NullOr(Schema.String),
  clock: Schema.optionalKey(FlowClock),
  wait: Schema.NullOr(FlowWait),
  produces: Schema.NullOr(Schema.Literals(["plan", "review", "evidence", "merge-request"])),
  offPath: Schema.Boolean,
  place: Schema.NullOr(Schema.String),
  started: Schema.NullOr(Schema.String),
  ended: Schema.NullOr(Schema.String),
  attempts: Schema.Array(FlowAttempt),
  ranOn: Schema.NullOr(Schema.String),
  questions: Schema.Array(FlowQuestion),
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

export const FlowRun = Schema.Struct(FlowNodeFields);
export type FlowRun = typeof FlowRun.Type;

export const FlowNode = Schema.Struct({
  ...FlowNodeFields,
  runs: Schema.Array(FlowRun),
  links: Schema.optional(Schema.Array(FlowRun)),
});
export type FlowNode = typeof FlowNode.Type;

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
  startedBy: Schema.optionalKey(
    Schema.Struct({ run: Schema.String, step: Schema.NullOr(Schema.String) }),
  ),
});
export type FlowLane = typeof FlowLane.Type;

export const Flow = Schema.Struct({
  notice: Schema.optional(Schema.NullOr(Schema.String)),
  lanes: Schema.Array(FlowLane),
  current: Schema.NullOr(Schema.Struct({ run: Schema.String, node: Schema.String })),
  release: Schema.NullOr(Schema.Array(FlowNode)),
  releases: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ mr: Schema.String, short: Schema.String, nodes: Schema.Array(FlowNode) }),
    ),
  ),
});
export type Flow = typeof Flow.Type;

export const RunReply = Schema.Struct({
  at: Schema.String,
  mr: Schema.String,
  comment: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["fixed", "disputed"])),
  body: Schema.String,
});
export type RunReply = typeof RunReply.Type;

export const RecordPart = Schema.Literals(["diff", "tail", "mr", "texts"]);
export type RecordPart = typeof RecordPart.Type;

export const RunDetail = Schema.Struct({
  narratives: Schema.optionalKey(Schema.Array(NarrativeReport)),
  branchProgress: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.String,
  park: Schema.optionalKey(Schema.NullOr(Park)),
  recovery: Schema.optionalKey(Schema.Array(Schema.String)),
  revision: Schema.optionalKey(RunRevision),
  pending: Schema.optionalKey(Schema.Array(RecordPart)),
  requestedBy: Schema.optional(RequestedBy),
  startedBy: Schema.optional(Schema.String),
  report: Schema.optional(RunReport),
  dir: Schema.String,
  title: Schema.String,
  status: Schema.String,
  inputs: Schema.Array(
    Schema.Struct({ name: Schema.String, value: Schema.String, source: Schema.String }),
  ),
  steps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      note: Schema.String,
      took: Schema.NullOr(Schema.String),
      agents: Schema.Array(Schema.String),
    }),
  ),
  handoffs: Schema.Array(Schema.String),
  intent: Schema.NullOr(
    Schema.Struct({ goal: Schema.NullOr(Schema.String), constraints: Schema.Array(Schema.String) }),
  ),
  review: Panel,
  plan: Schema.NullOr(PlanPanel),
  outputs: Schema.Array(OutputPanel),
  tail: Schema.NullOr(Panel),
  logStart: Schema.optional(Schema.Int),
  attention: Attention,
  outcome: Schema.Struct({
    kind: Schema.NullOr(Schema.String),
    gaps: Schema.Array(Schema.String),
    obstacle: Schema.NullOr(Schema.String),
    next: Schema.NullOr(Schema.String),
    delivered: Schema.NullOr(Schema.String),
    measurement: Schema.optional(Schema.NullOr(Schema.String)),
    metrics: Metrics,
  }),
  finishedAt: Schema.Finite,
  mr: Schema.NullOr(MrPanel),
  mrs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Schema.String, mr: Schema.String, panel: Schema.NullOr(MrPanel) }),
    ),
  ),
  findings: Schema.Array(ReviewFinding),
  verifications: Schema.Array(VerificationView),
  steering: Schema.Array(SteeringCard),
  evidence: Schema.Array(EvidenceFile),
  handoffFiles: Schema.optional(Schema.Array(EvidenceFile)),
  attachments: Schema.optional(Schema.Array(AttachmentFile)),
  replies: Schema.optional(Schema.Array(RunReply)),
  diff: Schema.NullOr(RunDiff),
  agents: Schema.optional(Schema.Array(RunAgent)),
  flow: Schema.optional(Flow),
});
export type RunDetail = typeof RunDetail.Type;

export const RecordUnchanged = Schema.TaggedStruct("Unchanged", { revision: RunRevision });
export type RecordUnchanged = typeof RecordUnchanged.Type;

export const recordIn = (value: RunDetail | RecordUnchanged | null) =>
  value === null || "_tag" in value ? null : value;

export const OfferView = Schema.Struct({
  textField: Schema.optionalKey(Schema.String),
  id: Schema.String,
  title: Schema.String,
  workflow: Schema.String,
  arguments: Schema.NullOr(Schema.Json),
  kind: Schema.Literals(["action", "follow-up"]),
  ships: Schema.optionalKey(Schema.Literals(["merge", "release"])),
  confirm: Schema.optionalKey(Schema.String),
  primary: Schema.Boolean,
  unavailable: Schema.NullOr(Schema.String),
  run: Schema.optionalKey(Schema.String),
});
export type OfferView = typeof OfferView.Type;

export const Startable = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  inputs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      required: Schema.Boolean,
      schema: Schema.NullOr(Schema.Json),
    }),
  ),
});
export type Startable = typeof Startable.Type;

export const RunStep = Schema.Struct({
  operation: Schema.String,
  agent: Schema.String,
  done: Schema.Boolean,
});
export type RunStep = typeof RunStep.Type;

export const RunProgress = Schema.Struct({
  ready: ReadyToRelease,
  ci: Schema.NullOr(ForgeChecks),
  steps: Schema.Array(RunStep),
  mrs: Schema.optional(Schema.Array(TaskMr)),
});
export type RunProgress = typeof RunProgress.Type;

export function readinessOfRun(runId: string, card: TaskView | undefined, ended: boolean) {
  if (card === undefined) {
    const returned: ReadyToRelease = {
      ready: false,
      missing: [
        ended
          ? { fact: "leads", said: "it ended on no card", settling: false }
          : { fact: "leads", said: "it is on no card yet", settling: true },
      ],
    };
    return returned;
  }
  if (card.run !== runId) {
    const returned: ReadyToRelease = {
      ready: false,
      missing: [{ fact: "leads", said: `${card.run} leads its Task now`, settling: false }],
    };
    return returned;
  }
  const returned: ReadyToRelease = card.readiness ?? { ready: card.ready ?? false, missing: [] };
  return returned;
}

// WARNING: an optional field or new message keeps it; a removal or a change of meaning bumps it.
export const PROTOCOL = 5;

export const Herd = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
});
export type Herd = typeof Herd.Type;

export const BoardSnapshot = Schema.TaggedStruct("Snapshot", {
  installation: Schema.String,
  build: Schema.String,
  development: Schema.optionalKey(Schema.String),
  protocol: Schema.Int,
  files: Schema.optionalKey(Schema.Boolean),
  artefacts: Schema.optionalKey(Schema.Boolean),
  herds: Schema.Array(Herd),
  tasks: Schema.Array(TaskView),
  seq: Schema.Int,
});
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const TaskUpserted = Schema.TaggedStruct("Upsert", { seq: Schema.Int, task: TaskView });
export type TaskUpserted = typeof TaskUpserted.Type;

export const TaskRemoved = Schema.TaggedStruct("Remove", { seq: Schema.Int, id: Schema.String });
export type TaskRemoved = typeof TaskRemoved.Type;

const KNOWN_MESSAGES: ReadonlySet<string> = new Set(["Snapshot", "Upsert", "Remove", "Unknown"]);

export const UnknownMessage = Schema.Struct({
  _tag: Schema.String.pipe(Schema.check(Schema.makeFilter((tag) => !KNOWN_MESSAGES.has(tag)))),
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

export const Toasted = Schema.Struct({
  runId: Schema.String,
  title: Schema.String,
  body: Schema.String,
  sound: Schema.Literals(["none", "done", "request"]),
});
export type Toasted = typeof Toasted.Type;

export class HostRefused extends Schema.TaggedError<
  HostRefused,
  { readonly brand: unique symbol }
>()("HostRefused", {
  reason: Schema.String,
}) {}

export class StaleAct extends Schema.TaggedError<StaleAct, { readonly brand: unique symbol }>()(
  "StaleAct",
  { run: Schema.String, step: Schema.String, reason: Schema.String },
) {}

// WARNING: an accepted request is never silently changed: an idempotency key must never do that.
export class RequestConflict extends Schema.TaggedError<
  RequestConflict,
  { readonly brand: unique symbol }
>()("RequestConflict", {
  request: Schema.String,
  reason: Schema.String,
}) {}

export const Answered = Schema.Struct({
  runId: Schema.String,
  decision: Schema.String,
  value: Schema.String,
  fresh: Schema.Boolean,
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

// WARNING: applied is whether the run was told: a control over work no host runs is an intent, not a confirmation.
export const Controlled = Schema.Struct({
  runId: Schema.String,
  control: Schema.String,
  set: Schema.Boolean,
  applied: Schema.Boolean,
  detail: Schema.String,
  left: Schema.Array(Schema.String),
  closed: Schema.optionalKey(Schema.Array(Schema.String)),
});

// WARNING: a stop that could not make an agent Quiet is a failed operation, never 'Stopped'.
export const leftSaid = (done: typeof Controlled.Type) => {
  if (done.left.length === 0) return null;
  if (done.closed !== undefined)
    return `${done.runId} has finished, but ${Arr.join(done.left, "; ")}.`;
  const what = `${done.set ? done.control : `un${done.control}`} ${done.runId}`;
  return `Recorded ${what}, but ${Arr.join(done.left, "; ")}.`;
};

export const Started = Schema.Struct({
  runId: Schema.String,
  registration: Schema.String,
  execution: Schema.String,
  fresh: Schema.Boolean,
  followed: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const CarriedWork = Schema.Struct({
  mr: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});

export const Disposition = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  kind: Schema.Literals(["merged", "abandoned", "superseded"]),
  ref: Schema.String,
  note: Schema.NullOr(Schema.String),
  successor: Schema.optionalKey(
    Schema.Struct({
      machine: MachineRef,
      run: Schema.String,
      task: Schema.NullOr(Schema.String),
      work: CarriedWork,
    }),
  ),
});
export type Disposition = typeof Disposition.Type;

export const Seen = Schema.Struct({ at: Schema.String, by: Schema.String });
export type Seen = typeof Seen.Type;

export const StepResult = Schema.Struct({
  index: Schema.Int,
  kind: Schema.String,
  state: Schema.String,
  note: Schema.String,
  run: Schema.NullOr(Schema.String),
});
export type StepResult = typeof StepResult.Type;

export const ProposalCarried = Schema.Struct({
  proposal: Schema.String,
  results: Schema.Array(StepResult),
});
export type ProposalCarried = typeof ProposalCarried.Type;

export class ProposalRefused extends Schema.TaggedError<
  ProposalRefused,
  { readonly brand: unique symbol }
>()("ProposalRefused", {
  refused: Schema.String,
  detail: Schema.String,
}) {}

export const SteerOutcome = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.NullOr(Schema.String),
  human: Schema.String,
  data: Schema.Json,
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SteerOutcome = typeof SteerOutcome.Type;

// WARNING: amending an Intent, forking a definition and changing a workspace's defaults are collie_propose's, not the board's.
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

export const ActionResult = Schema.Struct({
  kind: Schema.String,
  state: Schema.String,
  note: Schema.String,
  revision: Schema.optionalKey(RunRevision),
});
export type ActionResult = typeof ActionResult.Type;

export const CleanupItem = Schema.Struct({
  kind: Schema.String,
  target: Schema.String,
  bytes: Schema.Finite,
  reason: Schema.String,
});
export type CleanupItem = typeof CleanupItem.Type;

export const CleanupKept = Schema.Struct({
  kind: Schema.String,
  target: Schema.String,
  reason: Schema.String,
});
export type CleanupKept = typeof CleanupKept.Type;

export const CleanupReport = Schema.Struct({
  remove: Schema.Array(CleanupItem),
  keep: Schema.Array(CleanupKept),
  bytes: Schema.Finite,
});
export type CleanupReport = typeof CleanupReport.Type;

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
  "host",
]);
export type FrontDoor = typeof FrontDoor.Type;

export const Where = Schema.Struct({
  client: Schema.optionalKey(Schema.String),
  ssh: Schema.optionalKey(Schema.String),
  machine: Schema.optionalKey(MachineRef),
  run: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
});
export type Where = typeof Where.Type;

// WARNING: output before this line is a login shell's; after it, the host's.
export const BRIDGE_READY = "collie-bridge-ready";

export const Declaration = Schema.Struct({
  frontDoor: FrontDoor,
  session: Schema.optionalKey(Schema.NullOr(Schema.String)),
  from: Schema.optionalKey(Where),
  conversation: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  stamp: Schema.optionalKey(Schema.String),
});
export type Declaration = typeof Declaration.Type;

export const Significance = Schema.Literals(["routine", "try-it", "decision", "consequential"]);
export type Significance = typeof Significance.Type;

export const NEWS_BATCH = 10;

export const NewsReceipt = Schema.Literals(["read", "sent", "uncertain"]);

export const NewsBatch = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      run: Schema.String,
      text: Schema.String,
      at: Schema.String,
      significance: Significance.pipe(Schema.withDecodingDefaultKey(Effect.succeed("routine"))),
    }),
  ),
  omitted: Schema.Int,
});

export const PaneAt = Schema.Struct({
  session: Schema.NullOr(Schema.String),
  workspace: Schema.String,
  tab: Schema.NullOr(Schema.String),
  pane: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  core: Schema.optionalKey(Schema.String),
});
export type PaneAt = typeof PaneAt.Type;

export const SharedSetting = Schema.Struct({
  key: Schema.String,
  value: Schema.NullOr(Schema.Json),
  at: Schema.String,
});
export type SharedSetting = typeof SharedSetting.Type;

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

export const Attachments = Schema.Array(Schema.String);

export const FLOCK_READS = [
  "collie_run",
  "collie_receipts",
  "collie_workspaces",
  "collie_artefacts",
] as const;

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

export const IdentityRpc = Rpc.make("identity", {
  success: Schema.Struct({
    build: Schema.String,
    pid: Schema.Int,
    dir: Schema.String,
    root: Schema.optionalKey(Schema.String),
    development: Schema.optionalKey(Schema.String),
    protocol: Schema.optionalKey(Schema.Int),
    installation: Schema.optionalKey(Schema.String),
  }),
});

export const RunDetailRpc = Rpc.make("runDetail", {
  payload: {
    runId: Schema.String,
    tail: Schema.Boolean,
    pages: Schema.Int,
    refreshMr: Schema.Boolean,
    refreshMrId: Schema.optionalKey(Schema.String),
    parts: Schema.optionalKey(Schema.Boolean),
    held: Schema.optionalKey(RunRevision),
  },
  success: Schema.Union([RunDetail, RecordUnchanged, Schema.Null]),
  stream: true,
});

// WARNING: every operation takes a request id: the same one twice is one operation, and with other arguments it is refused.
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
  Rpc.make("toasts", { success: Toasted, stream: true }),
  // WARNING: a channel that never declares is stamped cli, never a human.
  Rpc.make("declare", {
    payload: Declaration,
    error: HostRefused,
  }),
  Rpc.make("start", {
    payload: {
      project: Schema.String,
      id: Schema.String,
      request: Schema.String,
      input: Schema.Record(Schema.String, Schema.Json),
      text: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      inferred: Schema.optional(Schema.Array(Schema.String)),
      root: Schema.optional(Schema.String),
      options: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      task: Schema.optional(Schema.String),
      taskLabel: Schema.optional(Schema.String),
      parent: Schema.optional(Schema.String),
      intent: Schema.optional(IntentSeedSchema),
      verify: Schema.optional(Schema.Array(VerifySpecSchema)),
      attachments: Schema.optional(Attachments),
    },
    success: Started,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
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
  Rpc.make("control", {
    payload: {
      runId: Schema.String,
      control: Schema.Literals(["hold", "stop"]),
      set: Schema.Boolean,
      request: Schema.String,
      reason: Schema.optional(Schema.String),
      before: Schema.optional(Schema.String),
      shown: Schema.optional(RunRevision),
    },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict, StaleAct]),
  }),
  Rpc.make("withdrawNote", {
    payload: { runId: Schema.String, note: Schema.String, request: Schema.String },
    success: Schema.Boolean,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("publish", {
    payload: {
      runId: Schema.String,
      title: Schema.String,
      file: Schema.String,
      onto: Schema.optional(Schema.String),
      pushOnly: Schema.optional(Schema.Boolean),
      skipCi: Schema.optional(Schema.Boolean),
      request: Schema.String,
    },
    success: Schema.Struct({ url: Schema.String }),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("resume", {
    payload: { runId: Schema.String, request: Schema.String },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("progress", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunProgress),
  }),
  RunDetailRpc,
  Rpc.make("artefacts", {
    payload: { runId: Schema.String, refresh: Schema.optional(Schema.Boolean) },
    success: ArtefactCollection,
    error: HostRefused,
  }),
  Rpc.make("artefactSearch", {
    payload: ArtefactSearch.fields,
    success: ArtefactMatches,
    error: HostRefused,
  }),
  Rpc.make("artefactRead", {
    payload: { runId: Schema.String, id: Schema.String, revision: Schema.Int, offset: Schema.Int },
    success: RunFile,
    error: HostRefused,
  }),
  Rpc.make("submitOutput", {
    payload: { runId: Schema.String, output: Schema.Json },
    success: Schema.String,
    error: HostRefused,
  }),
  Rpc.make("artefactRegister", {
    payload: { runId: Schema.String, request: Schema.String, ...RegisterArtefact.fields },
    success: ArtefactRegistered,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("artefactSeen", {
    payload: {
      runId: Schema.String,
      id: Schema.String,
      revision: Schema.NullOr(Schema.Int),
      request: Schema.String,
    },
    success: Artefact,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("runFile", {
    payload: {
      runId: Schema.String,
      ref: Schema.String,
      offset: Schema.optional(Schema.Int),
      length: Schema.optional(Schema.Int),
    },
    success: RunFile,
    error: HostRefused,
  }),
  Rpc.make("confirm", {
    payload: { proposal: Schema.String, hash: Schema.String, request: Schema.String },
    success: ProposalCarried,
    error: Schema.Union([HostRefused, ProposalRefused, RequestConflict]),
  }),
  Rpc.make("propose", {
    payload: {
      herd: Schema.NullOr(Schema.String),
      interpretation: Schema.String,
      actions: Schema.Array(Schema.Json),
      request: Schema.String,
    },
    success: SteerOutcome,
  }),
  Rpc.make("act", {
    payload: {
      actions: Schema.Array(Schema.Json),
      request: Schema.String,
      shown: Schema.optional(RunRevision),
    },
    success: Schema.Array(ActionResult),
    error: Schema.Union([HostRefused, StaleAct]),
  }),
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
  Rpc.make("verify", {
    payload: {
      runId: Schema.String,
      name: Schema.String,
      executable: Schema.String,
      argv: Schema.Array(Schema.String),
      cwd: Schema.optionalKey(Schema.String),
      expect: Schema.Literals(["pass", "fail"]),
      again: Schema.optionalKey(Schema.Boolean),
    },
    success: VerifyEvent,
    error: HostRefused,
    stream: true,
  }),
  Rpc.make("verifyFollow", {
    payload: { check: Schema.String },
    success: VerifyEvent,
    error: HostRefused,
    stream: true,
  }),
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
  Rpc.make("seen", {
    payload: { runId: Schema.String, request: Schema.String },
    success: Seen,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("steerAbout", {
    payload: {
      runId: Schema.String,
      text: Schema.String,
      from: Schema.NullOr(Schema.String),
      dryRun: Schema.Boolean,
      request: Schema.String,
    },
    success: SteerOutcome,
    error: RequestConflict,
  }),
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
  Rpc.make("offers", {
    payload: { runId: Schema.String },
    success: Schema.Array(OfferView),
    error: HostRefused,
  }),
  Rpc.make("workflows", {
    payload: { project: Schema.String },
    success: Schema.Array(Startable),
  }),
  Rpc.make("definitions", { success: HostDefinitions, error: HostRefused }),
  Rpc.make("news", {
    payload: {
      herd: Schema.NullOr(Schema.String),
      conversation: Schema.String,
      as: NewsReceipt,
      request: Schema.String,
      keys: Schema.optionalKey(Schema.Array(Schema.String)),
    },
    success: NewsBatch,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("focus", {
    payload: {
      runId: Schema.String,
      agent: Schema.optionalKey(Schema.String),
      request: Schema.String,
    },
    success: PaneAt,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("settings", { success: SharedSettings, error: HostRefused }),
  Rpc.make("machineOwn", { success: MachineOwn, error: HostRefused }),
  Rpc.make("ownInventory", { success: OwnInventory, error: HostRefused }),
  Rpc.make("ownWords", { success: OwnWords, error: HostRefused }),
  Rpc.make("setSettings", {
    payload: { settings: Schema.Array(SharedSetting), request: Schema.String },
    success: SharedSettings,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("sharedDefinitions", { success: Schema.Array(SharedDefinition), error: HostRefused }),
  Rpc.make("setSharedDefinitions", {
    payload: { definitions: Schema.Array(SharedDefinition), request: Schema.String },
    success: Schema.Array(SharedDefinition),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("usage", { success: Schema.Array(UsageReading), error: HostRefused }),
  Rpc.make("fallbacks", { success: Schema.Array(AgentFallback), error: HostRefused }),
  Rpc.make("models", { success: Schema.Array(HarnessCatalogue), error: HostRefused }),
  Rpc.make("connections", { success: HostConnections, error: HostRefused }),
  Rpc.make("slackChoices", { success: Schema.Never, error: HostRefused }),
  Rpc.make("connectionLogin", {
    payload: { id: Schema.Literals(["gitlab", "github"]) },
    success: ConnectionLogin,
    error: HostRefused,
  }),
  Rpc.make("cleanup", { success: CleanupReport, error: HostRefused }),
  Rpc.make("schedules", { success: ScheduleListing, error: HostRefused }),
  Rpc.make("changeSchedule", {
    payload: { change: ScheduleChange, request: Schema.String },
    success: ScheduleChanged,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("sweep", {
    payload: { request: Schema.String },
    success: CleanupReport,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("claimedInHelle", {
    payload: { slug: Schema.String, request: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("read", {
    payload: {
      tool: Schema.Literals(FLOCK_READS),
      input: Schema.Record(Schema.String, Schema.Json),
    },
    success: Schema.String,
  }),
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
  Rpc.make("readFile", {
    payload: {
      path: Schema.String,
      offset: Schema.optional(Schema.Int),
      length: Schema.optional(Schema.Int),
    },
    success: HostFile,
    error: HostRefused,
  }),
  Rpc.make("glob", {
    payload: { pattern: Schema.String, path: Schema.optional(Schema.String) },
    success: Schema.Struct({ paths: Schema.Array(Schema.String), omitted: Schema.Int }),
    error: HostRefused,
  }),
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
  // WARNING: a file written whole, never inside the host's state directory.
  Rpc.make("writeFile", {
    payload: { path: Schema.String, content: Schema.String, request: Schema.String },
    success: Schema.Struct({ path: Schema.String, bytes: Schema.Int }),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
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

export interface MrRef {
  project: string | null;
  iid: string;
}

export type MrForge = "gitlab" | "github";

export function forgeOfRef(ref: MrRef) {
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

const MR_TARGET = /^mr:(?:([^\s,]*)([!#]))?(\d+)$/;
const MR_URL =
  /^(?:https?:\/\/)?(?:(github\.com\/[^/\s]+\/[^/\s]+)\/pull|([^/\s]+\/.+?)\/-\/merge_requests)\/(\d+)(?:[/?#]|$)/i;

export function readMrRef(text: string, typedIn?: { readonly project: string | null }) {
  const said = Str.trim(text);
  const target = MR_TARGET.exec(said);
  if (target) {
    const [, project = "", sign, iid] = target;
    if (project === "") return { project: null, iid: iid! };
    const ref = { project, iid: iid! };
    return (sign === "#") === (forgeOfRef(ref) === "github") ? ref : null;
  }
  const url = readMrUrl(said);
  if (url) return url;
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(said);
  if (short) return { project: `github.com/${short[1]}`, iid: short[2]! };
  const typed = typedIn === undefined ? null : /^[!#]?(\d+)$/.exec(said);
  return typed ? { project: typedIn!.project, iid: typed[1]! } : null;
}

export function readMrUrl(text: string) {
  const url = MR_URL.exec(Str.trim(text));
  return url ? { project: (url[1] ?? url[2])!, iid: url[3]! } : null;
}

export function parseMrTarget(target: string) {
  return pipe(target, Str.startsWith("mr:")) ? readMrRef(target) : null;
}

export function parseMrUrl(url: string) {
  return pipe(Str.trim(url), Str.startsWith("mr:")) ? null : readMrRef(url);
}

export function mrPath(ref: MrRef) {
  const project = ref.project ?? "";
  return /^[^/]+\.[^/]+\/(.+)$/.exec(project)?.[1] ?? project;
}

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

// WARNING: a bare or hostless reference is resolved only against the project it was typed in.
export function mrId(text: string, typedIn?: { readonly project: string | null }) {
  const said = Str.trim(text);
  const ref =
    readMrRef(said, typedIn) ??
    (pipe(said, Str.startsWith("mr:")) ? null : readMrRef(`mr:${said}`));
  if (ref === null) {
    const returned: string | null = null;
    return returned;
  }
  const here = typedIn?.project ?? null;
  const named = ref.project;
  const project = named === null || (!hosted(named) && endsIn(here, named)) ? here : named;
  if (project === null || !hosted(project)) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = Str.toLowerCase(
    `${project}${mrWords({ project, iid: ref.iid }).sign}${ref.iid}`,
  );
  return returned;
}

export const mrIdProject = (id: string) => pipe(id, Str.replace(/[!#]\d+$/, ""));

export const mrRefsIn = (text: string) =>
  Arr.filter(Str.split(Str.trim(text), /[\s,]+/), Str.isNonEmpty);

export function mrSet(text: string) {
  const said = mrRefsIn(text);
  if (said.length < 2) {
    const returned:
      | {
          readonly mrs: ReadonlyArray<{
            readonly id: string;
            readonly target: string;
            readonly url: string;
          }>;
        }
      | { readonly unresolved: string }
      | null = null;
    return returned;
  }
  const named = new Map<
    string,
    { readonly id: string; readonly target: string; readonly url: string }
  >();
  for (const one of said) {
    const id = mrId(one);
    const ref = readMrRef(one);
    const words = ref === null ? null : mrWords(ref);
    if (id === null || words === null || words.url === null) {
      const returned:
        | {
            readonly mrs: ReadonlyArray<{
              readonly id: string;
              readonly target: string;
              readonly url: string;
            }>;
          }
        | { readonly unresolved: string }
        | null = { unresolved: one };
      return returned;
    }
    if (!named.has(id)) named.set(id, { id, target: words.target, url: words.url });
  }
  const returned:
    | {
        readonly mrs: ReadonlyArray<{
          readonly id: string;
          readonly target: string;
          readonly url: string;
        }>;
      }
    | { readonly unresolved: string }
    | null = { mrs: [...named.values()] };
  return returned;
}

export function waitsOnOf(
  id: string,
  ids: ReadonlyArray<string>,
  branches: ReadonlyMap<string, { readonly source?: string; readonly target?: string }>,
) {
  const target = branches.get(id)?.target ?? "";
  if (target === "") return [];
  const sources = Arr.filter(
    ids,
    (other) => other !== id && branches.get(other)?.source === target,
  );
  const here = Arr.filter(sources, (other) => mrIdProject(other) === mrIdProject(id));
  return here.length > 0 ? here : sources;
}

const hosted = (project: string) => mrPath({ project, iid: "" }) !== project;

const endsIn = (project: string | null, path: string) =>
  project !== null && pipe(Str.toLowerCase(project), Str.endsWith(`/${Str.toLowerCase(path)}`));

export function mrTarget(project: string | null, iid: string) {
  return mrWords({ project: project || null, iid }).target;
}

export type OfferControl =
  | { readonly kind: "text" | "boolean" | "number" | "integer" | "list" }
  | { readonly kind: "enum"; readonly options: ReadonlyArray<Schema.Json> }
  | { readonly kind: "json"; readonly holds: "object" | "array" | null };

export interface OfferField {
  readonly name: string;
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  readonly control: OfferControl;
  readonly initial: string | undefined;
}

export type OfferInput =
  | { readonly _tag: "Valid"; readonly input: { [name: string]: Schema.Json } }
  | { readonly _tag: "Invalid"; readonly errors: { [name: string]: string } };

export const offerFields = (drawn: Schema.Json | null) => {
  const takes = decodeArguments(drawn);
  if (takes._tag === "None") return [];
  const required = takes.value.required ?? [];
  return Arr.map(Rec.toEntries(takes.value.properties ?? {}), ([name, schema]) => {
    const field = Option.getOrElse(decodeField(schema), () => NO_FIELD);
    const control = controlOf(field);
    const needed = required.includes(name);
    return {
      name,
      label: labelOf(name),
      help: field.description ?? null,
      required: needed,
      control,
      initial:
        field.default !== undefined
          ? entryOf(control, field.default)
          : needed && control.kind === "boolean"
            ? "false"
            : undefined,
    };
  });
};

export const offerInput: (
  drawn: Schema.Json | null,
  typed: Readonly<Record<string, string>>,
) => OfferInput = (drawn, typed) => {
  const input: { [name: string]: Schema.Json } = {};
  const errors: { [name: string]: string } = {};
  for (const field of offerFields(drawn)) {
    const read = readEntry(field, typed[field.name]);
    if (read._tag === "Unset") {
      if (field.required) errors[field.name] = `${field.label} needs a value`;
    } else if (read._tag === "Refused") errors[field.name] = `${field.label} ${read.why}`;
    else input[field.name] = read.value;
  }
  return Rec.isEmptyRecord(errors) ? { _tag: "Valid", input } : { _tag: "Invalid", errors };
};

export const givenOfferInput = (
  drawn: Schema.Json | null,
  given: Readonly<Record<string, string>>,
) => {
  const fields = new Map(Arr.map(offerFields(drawn), (field) => [field.name, field] as const));
  return Rec.fromEntries(
    Arr.map(Rec.toEntries(given), ([name, text]) => {
      const field = fields.get(name);
      if (field?.control.kind === "list")
        return [name, Option.getOrElse(parseJson(text), () => text)] as const;
      const read = field === undefined ? null : readEntry(field, text);
      return [name, read?._tag === "Read" ? read.value : text] as const;
    }),
  );
};

export interface OfferChoice {
  readonly key: string;
  readonly label: string;
  readonly entry: string | undefined;
}

export const offerChoices = (field: OfferField) => {
  const unset: ReadonlyArray<OfferChoice> = field.required
    ? []
    : [{ key: "unset", label: "Not set", entry: undefined }];
  const { control } = field;
  if (control.kind === "boolean")
    return [
      ...unset,
      { key: "true", label: "Yes", entry: "true" },
      { key: "false", label: "No", entry: "false" },
    ];
  if (control.kind !== "enum") return [];
  return [
    ...unset,
    ...Arr.map(optionEntries(control.options), (entry, at) => ({
      key: `option-${at}`,
      label: optionLabel(entry),
      entry,
    })),
  ];
};

export const asksBeforeTaking = (offer: {
  readonly arguments: Schema.Json | null;
  readonly confirm?: string;
}) => offer.confirm !== undefined || offerFields(offer.arguments).length > 0;

const DrawnField = Schema.Struct({
  type: Schema.optional(Schema.String),
  enum: Schema.optional(Schema.Array(Schema.Json)),
  items: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
  anyOf: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        enum: Schema.optional(Schema.Array(Schema.Json)),
      }),
    ),
  ),
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Json),
});
type DrawnField = typeof DrawnField.Type;
const NO_FIELD: DrawnField = {};
const EMPTY_OPTION = "(empty)";
const decodeField = Schema.decodeUnknownOption(DrawnField);
const isText = Schema.is(Schema.String);

const controlOf: (field: DrawnField) => OfferControl = (field) => {
  if (field.enum !== undefined) return { kind: "enum", options: field.enum };
  const anyOf = field.anyOf ?? [];
  if (Arr.isReadonlyArrayNonEmpty(anyOf) && Arr.every(anyOf, (one) => one.enum !== undefined))
    return { kind: "enum", options: Arr.flatMap(anyOf, (one) => one.enum ?? []) };
  const number = Arr.some(anyOf, (one) => one.type === "number");
  switch (number ? "number" : field.type) {
    case "string":
      return { kind: "text" };
    case "boolean":
      return { kind: "boolean" };
    case "integer":
      return { kind: "integer" };
    case "number":
      return { kind: "number" };
    case "array":
      return field.items?.type === "string" ? { kind: "list" } : { kind: "json", holds: "array" };
    case "object":
      return { kind: "json", holds: "object" };
    default:
      return JSON_ANY;
  }
};
const JSON_ANY: OfferControl = { kind: "json", holds: null };

const optionEntries = (options: ReadonlyArray<Schema.Json>) => {
  const plain = Arr.map(options, (option) => (isText(option) ? option : encodeJson(option)));
  return new Set(plain).size === plain.length
    ? plain
    : Arr.map(options, (option) => encodeJson(option));
};
const optionLabel = (entry: string) => (entry === "" ? EMPTY_OPTION : entry);

const labelOf = (name: string) =>
  pipe(name, Str.replaceAll("_", " "), Str.replaceAll("-", " "), Str.capitalize);

const entryOf = (control: OfferControl, value: Schema.Json) => {
  if (control.kind === "list" && Arr.isArray(value) && Arr.every(value, isText))
    return Arr.join(value, "\n");
  if (control.kind === "enum") {
    const at = Arr.findFirstIndex(control.options, (one) => encodeJson(one) === encodeJson(value));
    if (Option.isSome(at)) return optionEntries(control.options)[at.value]!;
  }
  if (isText(value) && control.kind === "text") return value;
  return encodeJson(value);
};

type Entry =
  | { readonly _tag: "Unset" }
  | { readonly _tag: "Read"; readonly value: Schema.Json }
  | { readonly _tag: "Refused"; readonly why: string };

const readEntry: (field: OfferField, entry: string | undefined) => Entry = (field, entry) => {
  if (entry === undefined) return { _tag: "Unset" };
  const { control } = field;
  if (control.kind === "enum") {
    const entries = optionEntries(control.options);
    return Option.match(
      Arr.findFirstIndex(entries, (one) => one === entry),
      {
        onSome: (at) => ({ _tag: "Read", value: control.options[at]! }),
        onNone: () => ({
          _tag: "Refused",
          why: `must be one of: ${Arr.join(Arr.map(entries, optionLabel), ", ")}`,
        }),
      },
    );
  }
  const text = Str.trim(entry);
  if (text === "") return { _tag: "Unset" };
  switch (control.kind) {
    case "text":
      return { _tag: "Read", value: entry };
    case "boolean":
      return text === "true" || text === "false"
        ? { _tag: "Read", value: text === "true" }
        : { _tag: "Refused", why: "must be yes or no" };
    case "number":
    case "integer": {
      const value = Number(text);
      if (!Number.isFinite(value)) return { _tag: "Refused", why: "must be a number" };
      return control.kind === "integer" && !Number.isInteger(value)
        ? { _tag: "Refused", why: "must be a whole number" }
        : { _tag: "Read", value };
    }
    case "list":
      return {
        _tag: "Read",
        value: Arr.filter(Arr.map(Str.split(entry, "\n"), Str.trim), (one) => one !== ""),
      };
    case "json": {
      const parsed = parseJson(text);
      if (Option.isNone(parsed)) return { _tag: "Refused", why: "is not valid JSON" };
      return holdsRefusal(control.holds, parsed.value) ?? { _tag: "Read", value: parsed.value };
    }
  }
};

const holdsRefusal: (holds: "object" | "array" | null, value: Schema.Json) => Entry | null = (
  holds,
  value,
) => {
  if (holds === "object" && !isJsonObject(value))
    return { _tag: "Refused", why: "must be a JSON object" };
  if (holds === "array" && !Arr.isArray(value))
    return { _tag: "Refused", why: "must be a JSON list" };
  return null;
};
const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const decodeArguments = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const encodeJson = flow(
  Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Json)),
  Option.getOrElse(() => ""),
);

export function isSettled(state: TaskState) {
  return state === "done" || state === "failed" || state === "stopped" || state === "abandoned";
}

export function canResume(state: TaskState) {
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
) {
  const factsOf = (lane: FlowLane) =>
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
  const offered = (node: FlowRun, lane: FlowLane, facts: FlowActionFacts) => {
    let primary: FlowAction | null = null;
    const actions: Array<FlowAction> = [];
    const live = node.agent != null && Arr.some(view.agents, (one) => one.name === node.agent);
    const proposal = node.proposal ?? facts.proposal ?? undefined;
    if (node.link !== undefined) {
      if (node.link.run !== null) primary = "open";
      if (node.link.canResume === true && node.link.machine === lane.machine) actions.push("retry");
    } else if (node.kind === "offer") {
      if (node.id === `offer:${view.offer?.id}` && lane.run === (view.offer?.run ?? view.run))
        primary = "start";
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
  const lanes = Arr.map(flow.lanes, (lane) => {
    const facts = factsOf(lane);
    const settled =
      lane.run === view.run
        ? isSettled(view.state)
        : !["running", "suspended"].includes(lane.execution);
    const actions: Array<FlowLaneAction> = [];
    if (!settled) actions.push(facts.held ? "release" : "hold", "stop");
    if (facts.canResume) actions.push("resume");
    if (lane.run === view.run && view.state === "done") actions.push("follow-up");
    return {
      ...lane,
      actions,
      nodes: Arr.map(lane.nodes, (node) => ({
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
  const releaseOf = (nodes: ReadonlyArray<FlowNode>) =>
    leading === undefined
      ? nodes
      : Arr.map(nodes, (node) => ({
          ...offered(node, leading, factsOf(leading)),
          runs: node.runs,
        }));
  const release = flow.release === null ? null : releaseOf(flow.release);
  if (flow.releases === undefined) return { ...flow, lanes, release };
  const releases = Arr.map(flow.releases, (row) => ({ ...row, nodes: releaseOf(row.nodes) }));
  return { ...flow, lanes, release, releases };
}

export function mrRefOf(mr: string | null) {
  return mr === null ? null : readMrRef(mr);
}

export function mrUrlOf(ref: MrRef) {
  return mrWords(ref).url;
}

type DispositionKind = "merged" | "abandoned" | "superseded";

export type CardAction =
  | { readonly kind: "go-to-tab" }
  | { readonly kind: "steer" }
  | { readonly kind: "attach" }
  | { readonly kind: "open-mr"; readonly mr: MrRef; readonly named?: string }
  | { readonly kind: "offer"; readonly offer: BoardOffer }
  | { readonly kind: "check-output" }
  | { readonly kind: "offers" }
  | { readonly kind: "resume" }
  | { readonly kind: "follow-up" }
  | { readonly kind: "hold"; readonly set: boolean }
  | { readonly kind: "stop" }
  | {
      readonly kind: "dispose";
      readonly disposition: DispositionKind;
      readonly ref: string;
      readonly named?: string;
    }
  | { readonly kind: "acknowledge" };

type DisposeAction = Extract<CardAction, { kind: "dispose" }>;

const dispose: (view: TaskView, disposition: DispositionKind) => DisposeAction = (
  view,
  disposition,
) => {
  const mr = mrRefOf(view.mr);
  const ref = disposition === "abandoned" || mr === null ? "" : mrWords(mr).short;
  return { kind: "dispose", disposition, ref };
};

const severalOf = (view: TaskView) =>
  view.mrs !== undefined && view.mrs.length > 1 ? view.mrs : [];

const openEach: (one: TaskMr) => CardAction = (one) => {
  const recorded = readMrRef(one.mr);
  const mr = recorded?.project ? recorded : readMrRef(`mr:${one.id}`)!;
  return { kind: "open-mr", mr, named: one.short };
};

const disposeEach: (one: TaskMr, disposition: DispositionKind) => DisposeAction = (
  one,
  disposition,
) => ({
  kind: "dispose",
  disposition,
  ref: one.id,
  named: one.short,
});

export function mrNounOf(mr: string) {
  const ref = readMrRef(mr);
  return ref === null ? "merge request" : mrWords(ref).noun;
}

export function openMrLabel(mr: MrRef, primary: boolean, named?: string) {
  const github = forgeOfRef(mr) === "github";
  if (named !== undefined) return `${github ? "Open PR" : "Open MR"} ${named}`;
  if (primary) return github ? "Open PR" : "Open MR";
  return github ? "Open pull request" : "Open merge request";
}

export function disposeLabel(action: DisposeAction) {
  return action.named === undefined
    ? `Mark ${action.disposition}`
    : `Mark ${action.disposition} ${action.named}`;
}

export function cardActions(view: TaskView) {
  const actions: Array<CardAction> = [{ kind: "go-to-tab" }];
  if (!isSettled(view.state)) actions.push({ kind: "steer" }, { kind: "attach" });
  const several = severalOf(view);
  const mr = mrRefOf(view.mr);
  if (several.length > 0) actions.push(...Arr.map(several, openEach));
  else if (mr !== null) actions.push({ kind: "open-mr", mr });
  for (const offer of view.offers ?? (view.offer === null ? [] : [view.offer]))
    actions.push({ kind: "offer", offer });
  if (view.check !== null) actions.push({ kind: "check-output" });
  actions.push({ kind: "offers" });
  if (canResume(view.state)) actions.push({ kind: "resume" });
  if (view.state === "done") actions.push({ kind: "follow-up" });
  if (!isSettled(view.state)) {
    actions.push({ kind: "hold", set: view.held === null }, { kind: "stop" });
  }
  return actions;
}

export function primaryAction(view: TaskView) {
  if (view.decision !== null) {
    const returned: CardAction | null = null;
    return returned;
  }
  if (view.state === "active" || view.state === "quiet") {
    const returned: CardAction | null = { kind: "go-to-tab" };
    return returned;
  }
  if (view.unseen === true) {
    const returned: CardAction | null = { kind: "acknowledge" };
    return returned;
  }
  if (view.landed) {
    const returned: CardAction | null = null;
    return returned;
  }
  if (view.shipping === "merge" && view.offer !== null) {
    const returned: CardAction | null = { kind: "offer", offer: view.offer };
    return returned;
  }
  if (view.planReady) {
    const returned: CardAction | null =
      view.offer === null ? null : { kind: "offer", offer: view.offer };
    return returned;
  }
  if (canResume(view.state)) {
    const returned: CardAction | null = { kind: "resume" };
    return returned;
  }
  const several = severalOf(view);
  if (several.length > 0) {
    const closed = Arr.findFirst(
      several,
      (one) => one.state === "closed" && one.disposition === null,
    );
    if (Option.isSome(closed)) {
      const returned: CardAction | null = disposeEach(closed.value, "superseded");
      return returned;
    }
    const returned: CardAction | null = openEach(
      Option.getOrElse(
        Arr.findFirst(several, (one) => one.ready),
        () => several[0]!,
      ),
    );
    return returned;
  }
  if (view.mrState === "closed") {
    const returned: CardAction | null = dispose(view, "superseded");
    return returned;
  }
  const mr = mrRefOf(view.mr);
  const returned: CardAction | null = mr === null ? null : { kind: "open-mr", mr };
  return returned;
}

export function dispositionActions(view: TaskView) {
  if (!isSettled(view.state)) return [];
  const several = severalOf(view);
  if (several.length > 0)
    return Arr.flatMap(several, (one) =>
      Arr.map(
        one.state === "closed"
          ? (["merged", "abandoned", "superseded"] as const)
          : (["merged", "abandoned"] as const),
        (kind) => disposeEach(one, kind),
      ),
    );
  const kinds: Array<DispositionKind> = ["merged", "abandoned"];
  if (view.mrState === "closed") kinds.push("superseded");
  return Arr.map(kinds, (kind) => dispose(view, kind));
}

export type Section = "needs-you" | "ready-to-ship" | "working" | "waiting" | "finished";

export function shippingLabel(view: Pick<TaskView, "shipping" | "offer">) {
  if (view.shipping == null) return "";
  if (view.shipping === "merge") return `${view.offer?.title ?? "Merge"}: `;
  return view.shipping === "stage" ? "Stage: " : "Deploy: ";
}

export function sectionOf(view: Pick<TaskView, "state" | "landed" | "shipping">) {
  if (view.state === "blocked") return view.shipping == null ? "needs-you" : "ready-to-ship";
  if (view.state === "active" || view.state === "quiet") return "working";
  return view.landed ? "finished" : view.shipping == null ? "waiting" : "ready-to-ship";
}

export const SECTIONS: ReadonlyArray<readonly [Section, string]> = [
  ["needs-you", "Needs you"],
  ["ready-to-ship", "Ready to ship"],
  ["waiting", "Waiting on you"],
  ["working", "Working"],
  ["finished", "Finished"],
];
const SECTION_ORDER = new Map(Arr.map(SECTIONS, ([section], at) => [section, at]));
const STATE_RANK = new Map<TaskState, number>(Arr.map(STATE_ORDER, (state, at) => [state, at]));

// WARNING: nothing else is ranked: a board that reorders itself on every tick cannot be pointed at.
export function sortBoard(views: ReadonlyArray<TaskView>) {
  return [...views].sort(
    (a, b) =>
      SECTION_ORDER.get(sectionOf(a))! - SECTION_ORDER.get(sectionOf(b))! ||
      (sectionOf(a) === "needs-you" ? STATE_RANK.get(a.state)! - STATE_RANK.get(b.state)! : 0) ||
      (sectionOf(a) === "ready-to-ship" ? b.at - a.at : 0) ||
      (b.ended ?? b.at) - (a.ended ?? a.at),
  );
}

export const WAIT_FOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface Sections {
  needs: Array<TaskView>;
  ready: Array<TaskView>;
  working: Array<TaskView>;
  waiting: Array<TaskView>;
  finished: Array<TaskView>;
}

// WARNING: work ready to release is never folded, however long it has waited.
export function foldWaiting(waiting: ReadonlyArray<TaskView>, now: number) {
  const old = (view: TaskView) => !view.ready && (view.ended ?? view.at) < now - WAIT_FOLD_MS;
  return { recent: Arr.filter(waiting, (view) => !old(view)), older: Arr.filter(waiting, old) };
}

export function foldFinished(finished: ReadonlyArray<TaskView>) {
  return {
    unseen: Arr.filter(finished, (view) => view.unseen === true),
    seen: Arr.filter(finished, (view) => view.unseen !== true),
  };
}

function haystack(view: TaskView) {
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

export function matchesTask(view: TaskView, query: string) {
  const wanted = Str.toLowerCase(Str.trim(query));
  return wanted === "" || pipe(haystack(view), Str.includes(wanted));
}

export function sectionsOf(views: ReadonlyArray<TaskView>, query: string) {
  const found = Arr.filter(views, (view) => matchesTask(view, query));
  return {
    needs: Arr.filter(found, (view) => sectionOf(view) === "needs-you"),
    ready: Arr.filter(found, (view) => sectionOf(view) === "ready-to-ship"),
    working: Arr.filter(found, (view) => sectionOf(view) === "working"),
    waiting: Arr.filter(found, (view) => sectionOf(view) === "waiting"),
    finished: Arr.filter(found, (view) => sectionOf(view) === "finished"),
  };
}

export interface HeaderSentence {
  text: string;
  urgent: boolean;
}

// WARNING: counted over every Task, so a decision the search hides is still counted.
export function headerSentence(views: ReadonlyArray<TaskView>, now?: number) {
  const needs = Arr.filter(views, (view) => sectionOf(view) === "needs-you").length;
  const working = Arr.filter(views, (view) => sectionOf(view) === "working");
  const quiet = Arr.filter(working, (view) => view.state === "quiet").length;
  const opening =
    needs === 0
      ? "Nothing needs you."
      : `${needs === 1 ? "One task is" : `${needs} tasks are`} waiting on you.`;
  const gone = quiet === 0 ? "" : `, ${quiet} gone quiet`;
  const waitingAll = Arr.filter(views, (view) => sectionOf(view) === "waiting");
  const waiting = now === undefined ? waitingAll : foldWaiting(waitingAll, now).recent;
  const ready = Arr.filter(views, (view) => sectionOf(view) === "ready-to-ship").length;
  const held = [
    ...(ready === 0 ? [] : [`${ready} ready to ship`]),
    ...(waiting.length === 0 ? [] : [`${waiting.length} waiting on you`]),
  ];
  const inHand = held.length === 0 ? "" : ` ${Arr.join(held, ", ")}.`;
  return { text: `${opening}${inHand} ${working.length} working${gone}.`, urgent: needs > 0 };
}

export function mrLabel(mr: string) {
  const ref = readMrRef(mr);
  if (ref) return mrWords(ref).label;
  const bare = pipe(mr, Str.startsWith("mr:")) ? pipe(mr, Str.slice(3)) : mr;
  const host = /^[^/!]+\.[^/!]+\/(.+)$/.exec(bare);
  return host ? host[1]! : bare;
}
