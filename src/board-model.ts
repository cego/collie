// What a board is made of, as every front door decodes it, and the pure rules that place
// and count its cards, decide what each one offers and read what it names. No I/O and no
// Bun-only import: a browser bundle imports this too.

import { Effect, Option, Schema, SchemaGetter } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { IntentSeedSchema } from "./intent-model";
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

/** The decision id a gate is answered by: `approve`, or `approve:<name>,<name>` for part of the list. */
export const EVIDENCE_GATE = "evidence-gate";

/** An evidence gate a Run is holding at until the verification list is approved. */
export const Gate = Schema.Struct({
  kind: Schema.Literal("gate"),
  run: Schema.String,
  id: Schema.String,
  step: Schema.String,
  verifications: Schema.Array(Schema.String),
});
export type Gate = typeof Gate.Type;

export const Decision = Schema.Union([Question, Proposal, Gate]);
export type Decision = typeof Decision.Type;

/** One live agent of the Task, as a card counts them and a search matches them. */
export const BoardAgent = Schema.Struct({
  /** herdr's own name for it, which carries the role it was started as. */
  name: Schema.String,
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
 * Why a check was run (ADR-0042): the gate on the branch, a recheck of the same tree for a
 * flake, a fix after gate fix N, the default branch's base, the finish's own, or a plain
 * check where nobody said.
 */
export const PASSES = ["gate", "recheck", "fix", "baseline", "finish", "check"] as const;
export const Pass = Schema.Literals(PASSES);
export type Pass = typeof Pass.Type;

/** A check running now, and what it is measured against. */
export const RunningCheck = Schema.Struct({
  name: Schema.String,
  pass: Pass,
  round: Schema.NullOr(Schema.Number),
  revision: Schema.String,
  base: Schema.NullOr(Schema.String),
  /** How long it has run, or null where the marker does not say when it started. */
  elapsedMs: Schema.NullOr(Schema.Number),
  /** The median of its last five completed runs in this repository, or null for none. */
  usualMs: Schema.NullOr(Schema.Number),
  /** Other checks this host is running now. */
  others: Schema.Number,
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
  /** When the leading Run ended, or null while it has not. Orders Waiting on you. */
  ended: Schema.NullOr(Schema.Number),
  /** What the forge last said about the merge request, where Collie has asked. */
  mrState: Schema.NullOr(MrState),
  /** What checked the open merge request's branch, or null where no merge request waits. */
  checks: Schema.optionalKey(Schema.NullOr(Checks)),
  /** Ready to release: the leading Run succeeded, its merge request is open and its checks passed. */
  ready: Schema.optionalKey(Schema.Boolean),
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
  at: Schema.Number,
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
  /** Whether every checkbox in it is checked. No boxes at all is not done. */
  done: Schema.Boolean,
});
export type PlanTicket = typeof PlanTicket.Type;

/** The plan a run is building from: its spec, and the tickets under it. */
export const PlanPanel = Schema.Struct({ spec: Panel, tickets: Schema.Array(PlanTicket) });
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
  timeToFirstEvidence: Schema.NullOr(Schema.Number),
  verifications: Schema.Struct({
    pass: Schema.Number,
    fail: Schema.Number,
    unstable: Schema.Number,
    byCollie: Schema.Number,
  }),
  slices: Schema.Struct({ done: Schema.Number, total: Schema.Number }),
  /** Fix rounds plus halts: how much of this Run was doing work again. */
  rework: Schema.Number,
  /** The largest context sample any agent reported, and which agent. */
  peakContext: Schema.NullOr(Schema.Struct({ agent: Schema.String, tokens: Schema.Number })),
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
  targetBranch: Schema.String,
  /** The head pipeline's status, or `""` when there is no pipeline to report. */
  pipeline: Schema.String,
  /** Phrased, because "2" alone does not say whether that is good. */
  approvals: Schema.String,
  /** Whether a discussion is still blocking, which is the one a reviewer chases. */
  unresolved: Schema.Boolean,
  notes: Schema.Number,
  /** Seven characters: enough to tell two heads apart, short enough to read. */
  headSha: Schema.String,
  /** The head revision in full, which evidence is matched against, or "" where unsaid. */
  head: Schema.optionalKey(Schema.String),
  /** The commit the merge put on the target branch, in full, or "" while it is not merged. */
  mergedSha: Schema.String,
  /** When GitLab last saw it change, in epoch milliseconds, or 0 when it did not say. */
  updatedAt: Schema.Number,
  url: Schema.String,
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
  line: Schema.NullOr(Schema.Number),
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

/** A file the Run kept as evidence, fetched as `evidence:<name>`. */
export const EvidenceFile = Schema.Struct({ name: Schema.String, bytes: Schema.Int });
export type EvidenceFile = typeof EvidenceFile.Type;

/** What a reference fetches: text as it is, anything else as base64. */
export const RunFile = Schema.Struct({
  ref: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  /** The whole item's size in bytes, of which `content` is the part asked for. */
  size: Schema.Int,
});

/** How much of an item one `runFile` hands over when no length is asked for. */
export const RUN_FILE_BYTES = 4 * 1024 * 1024;

export type RunFile = typeof RunFile.Type;

/** Everything the detail panel shows for the selected Run. */
export const RunDetail = Schema.Struct({
  id: Schema.String,
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
    metrics: Metrics,
  }),
  /** When this Run finished, so the merge-request panel can say what moved since. */
  finishedAt: Schema.Number,
  /** What the host's merge watch last read, for a Run that has a merge request. */
  mr: Schema.NullOr(MrPanel),
  findings: Schema.Array(ReviewFinding),
  verifications: Schema.Array(VerificationView),
  steering: Schema.Array(SteeringCard),
  evidence: Schema.Array(EvidenceFile),
  /** Null for a Run with no branch or no checkout left to compare. */
  diff: Schema.NullOr(RunDiff),
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

/**
 * The board protocol's version. An optional field, a new operation or a new kind of
 * message keeps it; a removal or a change of meaning bumps it.
 */
export const PROTOCOL = 2;

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
  protocol: Schema.Int,
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
export class HostRefused extends Schema.TaggedError<HostRefused>()("HostRefused", {
  reason: Schema.String,
}) {}

/**
 * A request id that was accepted for other arguments. Schema-backed, so a host can fail a
 * client with this value rather than a sentence about it: the caller is retrying something
 * it has changed its mind about, and changing an accepted request silently is the one
 * thing an idempotency key must never do.
 */
export class RequestConflict extends Schema.TaggedError<RequestConflict>()("RequestConflict", {
  request: Schema.String,
  reason: Schema.String,
}) {}

/** What an accepted answer became. `fresh` is false for the same claim arriving twice. */
export const Answered = Schema.Struct({
  runId: Schema.String,
  decision: Schema.String,
  value: Schema.String,
  fresh: Schema.Boolean,
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

/** What a start became: the run it is, and whether this call is what made it. */
export const Started = Schema.Struct({
  runId: Schema.String,
  registration: Schema.String,
  execution: Schema.String,
  fresh: Schema.Boolean,
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
export class ProposalRefused extends Schema.TaggedError<ProposalRefused>()("ProposalRefused", {
  refused: Schema.String,
  detail: Schema.String,
}) {}

/** What a steer came to, as the front doors print it: a failure carries its code. */
export const SteerOutcome = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.NullOr(Schema.String),
  human: Schema.String,
  data: Schema.Json,
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
  "start",
] as const;

/** What one action the human asked for came to. */
export const ActionResult = Schema.Struct({
  kind: Schema.String,
  state: Schema.String,
  note: Schema.String,
});
export type ActionResult = typeof ActionResult.Type;

/** Which front door is acting: what a channel declares, and what its operations are stamped with. */
export const FrontDoor = Schema.Literals([
  "cli",
  "cli-tty",
  "board",
  "desktop",
  "driver",
  "evaluator",
  "chat",
]);
export type FrontDoor = typeof FrontDoor.Type;

/** Where a bridged channel came from: the computer its front door named, and the SSH client the bridge saw. */
export const Where = Schema.Struct({
  client: Schema.optionalKey(Schema.String),
  ssh: Schema.optionalKey(Schema.String),
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
 * What any front door, on this computer or another, may ask a host. Every operation takes
 * a request id: the same one twice is one operation, and with other arguments is refused.
 */
export const FrontDoorRpcs = RpcGroup.make(
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
    },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** Picks a Run up again: what current files allow is registered, then its stop cleared. */
  Rpc.make("resume", {
    payload: { runId: Schema.String, request: Schema.String },
    success: Controlled,
    error: Schema.Union([HostRefused, RequestConflict]),
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
      /** How many bytes from there: `RUN_FILE_BYTES` when not given, and at most. */
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
    payload: { runId: Schema.String, text: Schema.String, request: Schema.String },
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
  /** Carries out what a finished Run offers, as a Run of its own. */
  Rpc.make("invoke", {
    payload: {
      runId: Schema.String,
      offer: Schema.String,
      input: Schema.Record(Schema.String, Schema.Json),
      request: Schema.String,
    },
    success: Started,
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

/** `mr:gitlab.example.com/group/project!42`, or the bare `mr:42` that came before. */
export function parseMrTarget(target: string): MrRef | null {
  if (!target.startsWith("mr:")) return null;
  const rest = target.slice(3);
  const at = rest.lastIndexOf("!");
  if (at < 0) return /^\d+$/.test(rest) ? { project: null, iid: rest } : null;
  const iid = rest.slice(at + 1);
  if (!/^\d+$/.test(iid)) return null;
  const project = rest.slice(0, at);
  return { project: project === "" ? null : project, iid };
}

/** `https://host/group/project/-/merge_requests/7`, the way glab reports what it opened. */
export function parseMrUrl(url: string): MrRef | null {
  const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.trim());
  return m ? { project: `${m[1]}/${m[2]}`, iid: m[3]! } : null;
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
  for (const [name, field] of Object.entries(takes.value.properties ?? {})) {
    const text = typed[name] ?? "";
    if (text === "" && !(takes.value.required ?? []).includes(name)) continue;
    const parsed = isTextField(field) ? Option.none() : parseJson(text);
    input[name] = Option.isSome(parsed) ? parsed.value : text;
  }
  return input;
};

/** The fields an offer's arguments name, and whether each must be given. */
export const offerFields = (drawn: Schema.Json | null) => {
  const takes = decodeArguments(drawn);
  if (takes._tag === "None") return [];
  return Object.keys(takes.value.properties ?? {}).map((name) => ({
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

/** However the Task names its merge request: the URL one opened, or the target one was pointed at. */
export function mrRefOf(mr: string | null): MrRef | null {
  return mr === null ? null : (parseMrUrl(mr) ?? parseMrTarget(mr));
}

/** Where a merge request is read in a browser, where its target says which project. */
export function mrUrlOf(ref: MrRef): string | null {
  return ref.project === null ? null : `https://${ref.project}/-/merge_requests/${ref.iid}`;
}

type DispositionKind = "merged" | "abandoned" | "superseded";

/** One thing a card can be asked for. Each front door draws it its own way. */
export type CardAction =
  | { readonly kind: "go-to-tab" }
  | { readonly kind: "steer" }
  | { readonly kind: "open-mr"; readonly mr: MrRef }
  | { readonly kind: "offer"; readonly offer: BoardOffer }
  | { readonly kind: "check-output" }
  | { readonly kind: "offers" }
  | { readonly kind: "resume" }
  | { readonly kind: "follow-up" }
  | { readonly kind: "hold"; readonly set: boolean }
  | { readonly kind: "stop" }
  | { readonly kind: "dispose"; readonly disposition: DispositionKind; readonly ref: string };

/** `collie!151` rather than the whole URL: a disposition's ref ends up in the card's sentence. */
const dispose = (view: TaskView, disposition: DispositionKind): CardAction => {
  const mr = mrRefOf(view.mr);
  const ref =
    disposition === "abandoned" || mr === null
      ? ""
      : `${(mr.project ?? "").split("/").at(-1)}!${mr.iid}`;
  return { kind: "dispose", disposition, ref };
};

/**
 * What this Task can be asked for, in the order a menu shows it. Only what would work: an
 * item the human has to try to find out is refused is worse than no item.
 */
export function cardActions(view: TaskView): CardAction[] {
  const actions: CardAction[] = [{ kind: "go-to-tab" }];
  if (!isSettled(view.state)) actions.push({ kind: "steer" });
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
 * tab; waiting cards get the action that lands or retires the work; a finished or
 * decision card has none — its buttons are the decision's own, or the menu's.
 */
export function primaryAction(view: TaskView): CardAction | null {
  if (view.decision !== null) return null;
  if (view.state === "active" || view.state === "quiet") return { kind: "go-to-tab" };
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
  return kinds.map((kind) => dispose(view, kind));
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
const SECTION_ORDER = new Map(SECTIONS.map(([section], at) => [section, at]));
const STATE_RANK = new Map<TaskState, number>(STATE_ORDER.map((state, at) => [state, at]));

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
  return { recent: waiting.filter((view) => !old(view)), older: waiting.filter(old) };
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
 * The four sections, in the order the board draws them, from a list already in the
 * board's own order. The search narrows them all the same way: a Task hidden from one
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
  const waiting = now === undefined ? waitingAll : foldWaiting(waitingAll, now).recent;
  const ready = waiting.filter((view) => view.ready).length;
  const held = [
    ...(ready === 0 ? [] : [`${ready} ready to release`]),
    ...(waiting.length === ready ? [] : [`${waiting.length - ready} waiting on you`]),
  ];
  const inHand = held.length === 0 ? "" : ` ${held.join(", ")}.`;
  return { text: `${opening}${inHand} ${working.length} working${gone}.`, urgent: needs > 0 };
}

/** `https://github.com/owner/repo/pull/30` as its repository and number. */
export function pullOf(mr: string): { readonly repo: string; readonly number: string } | null {
  const pull = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(mr);
  return pull ? { repo: pull[1]!, number: pull[2]! } : null;
}

/**
 * `group/project!42` from a GitLab URL or an `mr:` target, `owner/repo#30` from a GitHub
 * pull request URL; anything else as it is.
 */
export function mrLabel(mr: string): string {
  const url = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/.exec(mr);
  if (url) return `${url[1]}!${url[2]}`;
  const pull = pullOf(mr);
  if (pull) return `${pull.repo}#${pull.number}`;
  const bare = mr.startsWith("mr:") ? mr.slice(3) : mr;
  // `host/group/project!42` reads as `group/project!42`: the host is where, not what.
  const host = /^[^/!]+\.[^/!]+\/(.+)$/.exec(bare);
  return host ? host[1]! : bare;
}
