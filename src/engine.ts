import type { ForgeHere } from "./mr";
import { ShippingGo, writeStageProof } from "./shipping";
import { Artefacts } from "./artefacts";
import { NarrativeReport } from "./narrative-model";
import * as Struct from "effect/Struct";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { speaksForHuman } from "./proposals";
import type { Asker } from "./proposals";
import { actorOf, readAudit, recordAudit, whoActed } from "./audit";
import type { AuditLine, ScheduledBy } from "./audit";
import { LinkDelivery, readLinkDeliveries } from "./run-links";
import { appendLogLine } from "./run-log";
import { readReplies, recordReply } from "./replies";
import type { Scope } from "effect";
import {
  Cache,
  Cause,
  Clock,
  Context,
  Data,
  Deferred,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Formatter,
  Layer,
  Option,
  Path,
  Predicate,
  Random,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  flow,
  Result,
} from "effect";
import type { Types } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ConfigError } from "effect/Config";
import type { PlatformError } from "effect/PlatformError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as Activity from "effect/workflow/Activity";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as WorkflowModules from "effect/workflow";
import * as ProcessModules from "effect/process";
import * as CryptoModules from "effect/crypto";
import * as EffectRoot from "effect";
import { waitForAgents } from "./agent-wait";
import * as AgentsSdk from "./agents";
import { HOLD, STOP, controlOf, controlSet } from "./controls";
import manifest from "../package.json";
import { Agents } from "./agents";
import * as Sdk from "./sdk";
import {
  ConsumedCard,
  consumedCard,
  Recovery,
  recoveryFrom,
  reviewScope,
  recordReview,
  sourceEvidence,
  takePushed,
} from "./recovery";
import {
  Children,
  Host,
  RESERVED_INPUTS,
  AgentScopes,
  Run,
  WorkflowAgents,
  WorkflowError,
  checkEntry,
  definitionOf,
  describeMetadata,
  jsonSchemaFor,
} from "./sdk";
import type {
  WrittenDefinition,
  ChildAsk,
  ChildRun,
  ChildrenApi,
  ActionFacts,
  InputField,
  InputFields,
  WorkflowMetadata,
  WorkflowAgentPreferences,
  HostCodec,
  HostPayload,
  HostWorkflow,
  Registration,
  WorkflowDefinition,
  WorkflowEntry,
} from "./sdk";
import {
  FALLBACK_DEFAULTS,
  configValue,
  gitlabHostOf,
  loadDefaults,
  readConfig,
  worktreesDirectory,
} from "./config";
import { controlDir, unlistedServers } from "./compaction";
import { externalSubmits } from "./compactors";
import { foldPreferences, preferencesFromOptions, resolveChoice } from "./harness";
import type { MachineCatalogue } from "./harness-choice";
import { handoffsDir } from "./handoffs";
import { encodeSubagents, readSubagents } from "./subagents";
import type { UsageReading } from "./usage-model";
import { currentEnv } from "./env";
import { waitForMemory } from "./memory-wait";
import { measure, readMeasurements } from "./measurement";
import { baseTreesDir } from "./base-tree";
import { finalMeasurementLine } from "./measurement-model";
import type { Measurement } from "./measurement-model";
import { PROJECTS_ROOT_OPTION, projectsRoot, repositoryCheckout } from "./projects";
import { gitDirOf, publicationCheckouts, throughAliases, remoteOf } from "./issue-privacy";
import {
  HelleClaimSchema,
  HelleError,
  credentials,
  helleHolders,
  releaseClaim,
  waitForHelle,
} from "./helle";
import type { HelleClaim } from "./helle";
import { helleUrlOf } from "./helle-url";
import { currentPid, signalProcess } from "./lock";
import { skillDirs, skillFile } from "./definitions";
import type { CheckoutKind, InputStrategy } from "./definitions";
import { EXCLUSIVE_STRATEGIES } from "./strategies";
import {
  appendMetric,
  noteRound,
  noteSlice,
  noteVerification,
  metricsOf,
  readMetrics,
  recoveriesIn,
} from "./metrics";
import type { Metric } from "./metrics";
import { ForgeHttp, forgeHttpLayer } from "./forge/http";
import { followRequest } from "./follow-through";
import { EngineTouches, engineTouchesLayer, touching } from "./engine-touches";
import { ciJob, sharedFailure, takeTarget } from "./ci-job";
import { parkEvidence, rememberFailedCi } from "./park-recheck";
import { land, LandingSchema, readLanding, takeOver } from "./landing";
import {
  carried,
  fastForward,
  readMergeRequest,
  readProduction,
  readRollback,
  readStage,
  readTag,
} from "./releasing";
import type { MergeRequestRead, ProductionRead, RollbackRead, StageRead } from "./releasing";
import { everyRegistered } from "./registry";
import type { AgentEntry } from "./registry";
import type { AgentInfo } from "./herdr";
import { blockedLine, conflictsWithTarget, reviewWaitOf, standingOf } from "./review-wait";
import type { ReviewStanding } from "./review-wait";
import { NOTHING_TO_LAND } from "./standing";
import { AwaitingJson, AwaitingSchema, THE_AUTHOR, overdueLine } from "./awaiting";
import { Woke, collieRunOf } from "./mr-watch-model";
import { readingOf } from "./mr-watch";
import {
  autoMergingHere,
  branchTargetHead,
  whatItSaid,
  forgeHere,
  forgeOfProject,
  mrIdIn,
  prepareMergeRequest,
  postNote,
  productionCarries,
  projectHere,
  shell as runShell,
} from "./mr";
import { redact } from "./redact";
import { leaksIn, marker, ownRepository, refusal } from "./public-text";
import { releasesOf } from "./releases";
import { reportOf } from "./report";
import type { Recorded } from "./report";
import { outcomeRecordsOf } from "./outcomes";
import type { OutcomeRecords } from "./outcomes";
import {
  Park,
  ParkCause,
  healInFlight,
  parkOf,
  parkWithRecovery,
  healNth,
  healOwed,
  parkIdentity,
  recoveryLine,
} from "./park-cause";
import { healOn, healRequest, healerFor, passedOver } from "./heal";
import type { Metrics, Solution, Answered, Controlled } from "./board-model";
import {
  forgeOfRef,
  mrId,
  mrLabel,
  mrRefOf,
  mrRefsIn,
  mrWords,
  parseMrTarget,
  readMrRef,
  RecordedSolution,
  recommendedFirst,
} from "./board-model";
import { readMrStates } from "./merges";
import { MergeRequests } from "./merge-requests";
import { COLLIE_REPOSITORY, FORGES, forgeOf } from "./forge/forge";
import { links } from "./forge/review";
import { integrateDefault, integratedLine } from "./integrate";
import { planRunOf, strategyNamed, workSourceOf } from "./strategies";
import { Notifier, SOUND, notificationTitle, openedSubject, wanted } from "./notify";
import type { Sound } from "./notify";
import {
  Oversight,
  cardCheckpoints,
  checkDrift,
  familyOf,
  grantedToRun,
  MERGE_REQUEST,
  appendLog,
  said,
  settleAtFinish,
  standForElection,
  writeCard,
} from "./oversight";
import type { Correcting, Watched } from "./oversight";
import { evaluationDeps } from "./evaluator";
import { budgetPath, herdOf, humanSubmits, machineHerd } from "./steering";
import { hostDatabase, recordsLayer } from "./records";
import type { Records } from "./records";
import { ModuleRevisions, RevisionRows, onSyncedRevisions } from "./module-revisions";
import { addressOf, RunRecords } from "./run-records";
import { featuresOf, recordFeatures } from "./run-features";
import { Steered } from "./delivery-queue";
import type { JudgementDeps } from "./drift";
import { finishedOnRecord, writeCheckpoint } from "./cards";
import type { Card } from "./cards";
import { reason, taskTitleOf, unsafePathComponent } from "./naming";
import { freshTaskLabel } from "./tasknames";
import { attachmentRefusal, attachmentsDir, copyInto, listAttachments } from "./attachments";
import {
  fromWorkSource,
  propagate,
  readIntent,
  seedIntent,
  withOutcome,
  writeIntent,
} from "./intent";
import type { IntentSeed } from "./intent";
import { latest, readDispositions } from "./disposition";
import {
  findingText,
  findingsWithStatus,
  idsIn,
  isOpenFinding,
  markTaken,
  openFindingsRead,
  readFindingStatuses,
  reportIn,
  storeOpenCount,
} from "./finding-status";
import {
  changeKey,
  changeOfKey,
  isSingleRepo,
  planIssuesIn,
  planReposOf,
  prerequisitesOf,
} from "./plan";
import { judgePrerequisites, mergeRequestFor } from "./prerequisites";
import type { MrLanding, PrerequisiteStanding, RunDetail } from "./prerequisites";
import { SELF, argumentsWithout, inputsFor, offersFrom } from "./offers";
import type { Declared, Offer } from "./offers";
import { isOutcome, REQUESTABLE } from "./outcome";
import { Foreground } from "./foreground";
import {
  Store,
  isSetAside,
  isSuperseded,
  isUnanswered,
  sameRow,
  storeLayer,
  supersededReason,
} from "./store";
import type { Superseded, Admission, DecisionRow, RunRow, StoreApi } from "./store";
import { HostRefused, RequestConflict, RequestedBy, RunReport } from "./board-model";
import type { Disposition } from "./board-model";
import {
  TASK_INPUT,
  branchFor,
  checkoutFor,
  checkoutRefusal,
  defaultStart,
  isTheOneMade,
  pinnedCheckout,
  repositoryName,
  workOf,
} from "./worktree";
import type { BranchAsk, RecordedBy } from "./worktree";
import { Herdr } from "./herdr";

import type { PluginEnv } from "./env";
import { connectionOnMachine } from "./connections";
import { ConnectionRows } from "./connection-rows";
import { Branches } from "./branches";
import { isDirectMessage, slackApi, slackText } from "./slack";
import { slackUserToken } from "./slack-credentials";
import {
  REVIEW_SLACK,
  reconcileReviewSlack,
  reviewSlackTrouble,
  targetFromSlack,
} from "./review-slack";
import { slackMessageRef } from "./slack";
import { ConnectionId } from "./connection-model";
import type { ConnectionReading } from "./connection-model";
import { StartedSchema } from "./automode";
import type { RunAuthority, Started } from "./automode";
import { WorktreeRecordSchema } from "./run";
import type { WorktreeRecord } from "./run";
import { isOpen, listTasks, newTask, readTask, taskOfWorkspace, writeTask } from "./task";
import { nowIso, epochMs, isoAt } from "./time";
import {
  pauseBefore,
  reachPause,
  clearReachedPause,
  stepTarget,
  leaveStepNote,
  readStepNote,
  readStepSteering,
  StepNote as SteeringNote,
} from "./step-steering";
import { launchesOf, readLaunches } from "./launches";
import type { Launched } from "./launches";
import { steerTarget } from "./steer-target";
import { CurrentStep, appendStepLine, readStepLines } from "./steps";
import type { StepNote } from "./steps";
import { classifyGivenSet, classifyGivenTarget, classifyWorkSource, defaultBase } from "./inputs";
import type { PlatformServices } from "./platform";
import { markRefused, updateApproved, approvedFrom, approvedIn, PROJECT_FILE } from "./verify-spec";
import type { VerifySpec } from "./verify-spec";
import { rerunArgv } from "./bun-tests";
import { branchChange, ownTests } from "./own-tests";
import {
  checkCwd,
  commandOf,
  encodeVerifying,
  fingerprint,
  insideRun,
  contentOf,
  ranCommand,
  readVerifications,
  missSaid,
  recordFor,
  recordedFor,
  reliedFor,
  rerunTest,
  resolveExecutable,
  runApproved,
  VERIFYING,
} from "./verify";
import type { Isolation, Reuse } from "./verify";
import type { CheckPass, CheckRun, FailedTest, Verification } from "./verify";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import { canonicalJson, stringifyJson } from "./json";

export class EntryError extends Schema.TaggedError<EntryError, { readonly brand: unique symbol }>()(
  "EntryError",
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

export const REFUSED_INPUT = "invalid_input";
export const NEEDS_INPUT = "needs_input";

// WARNING: a placement may have changed things outside Collie, which nothing here can prove either way.
class PlacementUncertain extends Schema.TaggedError<
  PlacementUncertain,
  { readonly brand: unique symbol }
>()("PlacementUncertain", {
  reason: Schema.String,
}) {}

export class ToolchainError extends Data.TaggedError("ToolchainError")<{
  readonly code: "toolchain_unavailable";
  readonly message: string;
}> {}

// WARNING: an external module's `effect` must resolve here, or it is a second copy whose service keys differ.
const NAMESPACES = [
  ["effect", EffectRoot],
  ["effect/workflow", WorkflowModules],
  ["effect/process", ProcessModules],
  ["effect/crypto", CryptoModules],
  // WARNING: the rc.117 path, kept so a module saved before 4.0.0 still loads; remove in Collie 0.42.0.
  ["effect/unstable/workflow", WorkflowModules],
] as const;

const REMOVED = [
  [
    "effect/Crypto",
    "Effect 4.1 removed effect/Crypto: ids come from effect/crypto's SecureRandom and hashes from its Digest",
  ],
] as const;

export const sdkModules: () => ReadonlyArray<readonly [string, object]> = () => {
  // WARNING: sdk.ts must not import herdr; agents.ts does.
  const served: Array<readonly [string, object]> = [["collie", { ...Sdk, ...AgentsSdk }]];
  for (const [prefix, namespace] of NAMESPACES) {
    served.push([prefix, namespace]);
    for (const name of Struct.keys(namespace)) {
      served.push([Arr.join([prefix, name], "/"), namespace[name]]);
    }
  }
  return served;
};

// WARNING: must match package.json; engine.test.ts checks it, or author types are about another Effect.
export const TOOLCHAIN = {
  effect: "4.1.5",
  typescript: "^7.0.2",
} as const;

// WARNING: kept in step with src/sdk.ts; engine.test.ts typechecks a module against it.
export const SDK_DECLARATIONS = `declare module "collie" {
  export type ConnectionId = ${Arr.join(
    Arr.map(ConnectionId.literals, (id) => stringifyJson(id)),
    " | ",
  )};
  export const ConnectionId: Schema.Codec<ConnectionId, unknown, never, never>;
  export type ConnectionReading =
    | { readonly state: "ok"; readonly account: string; readonly detail: string }
    | { readonly state: "absent" | "broken"; readonly detail: string; readonly fix: string; readonly reusable?: { readonly from: string } };
  export const ConnectionReading: Schema.Codec<ConnectionReading, unknown, never, never>;
  export type ParkCause = ${Arr.join(
    Arr.map(ParkCause.literals, (id) => stringifyJson(id)),
    " | ",
  )};
  export const ParkCause: Schema.Codec<ParkCause, unknown, never, never>;
  export type FindingWord = "open" | "fixed" | "disputed" | "obsolete" | "dismissed" | "taken";
  export interface ReviewScope { readonly source: string; readonly requirements: string; readonly target: string; readonly head: string; readonly fingerprint: string; readonly outcome: string; readonly risks: string }
  export const ReviewScope: Schema.Codec<ReviewScope, unknown, never, never>;
  export interface Recovery { readonly implementation: boolean; readonly reason: string; readonly previous: string; readonly commits: string; readonly review: SynthesisReport | null; readonly lineage?: ReadonlyArray<string> }
  export const Recovery: Schema.Codec<Recovery, unknown, never, never>;
  import type { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
  import type { PlatformError } from "effect/PlatformError";
  import type { ChildProcessSpawner } from "effect/process";
  import type { Workflow } from "effect/workflow/Workflow";
  import type {
    WorkflowEngine,
    WorkflowInstance,
  } from "effect/workflow/WorkflowEngine";

  /** What this working tree was when a command ran on it. */
  export interface Snapshot {
    readonly head_sha: string;
    readonly fingerprint: string;
  }

  /** One test of a check, as its runner named it: the file, and the name with \` > \` between describes. */
  export interface FailedTest {
    readonly file: string;
    readonly name: string;
  }

  /** A command Collie watched, bound to the tree it ran on. Never an Output's claim. */
  export interface Verification {
    /** What a log line or a merge request names it by. */
    readonly id: string;
    readonly name: string;
    /** As PATH resolved it when it ran, so the record says what ran. */
    readonly executable: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    readonly start: Snapshot;
    readonly end: Snapshot;
    readonly exit: number;
    readonly expect: "pass" | "fail";
    readonly result: "pass" | "fail" | "unstable";
    readonly at: string;
    readonly by: "agent" | "collie";
    /** What it ran with outside the tree; absent on a record from before environments were. */
    readonly environment?: string;
    /** Why Collie ran it; absent on an agent's. A \`rerun\` is never its check's own run. */
    readonly pass?: "gate" | "rerun" | "recheck" | "fix" | "baseline" | "finish" | "ci" | "check";
    /** The tests a failing check's output names, where it could be read whole. */
    readonly failed?: ReadonlyArray<FailedTest>;
    /** The one test a \`rerun\` ran. */
    readonly test?: FailedTest;
    /** Whether a \`rerun\`'s test is the branch's own since the default branch, so never a Flake. */
    readonly own?: boolean;
    /** The pipeline job a \`ci\` pass read, and the merge commit it ran on where not the head itself. */
    readonly job?: {
      readonly name: string;
      readonly url: string | null;
      readonly merge?: string;
      /** After a failed attempt: each test the job's failed attempts named, and how many named it. */
      readonly flaked?: ReadonlyArray<{ readonly name: string; readonly file: string | null; readonly attempts: number }>;
    };
  }

  /** What the journal holds and the tree in front of you, for checks to be read against. */
  export interface CheckEvidence {
    readonly verifications: ReadonlyArray<Verification>;
    readonly final: Snapshot;
    /** The Run's checks' commands as they resolve here, so a record is read as the check it ran. */
    readonly commands?: ReadonlyArray<{
      readonly name: string;
      readonly executable: string | null;
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly ci?: string;
    }>;
    /** The Run's Measurements, oldest first. */
    readonly measurements?: ReadonlyArray<Measurement>;
    /** Where this checkout leaves the default branch a merge request targets; null where it has none. */
    readonly mergeBase?: string | null;
    /** The Git tree HEAD names, to compare with a Measurement's base tree. */
    readonly content?: string;
  }

  /** A Run as the host admitted it: where it works, where its work belongs, what it was given. */
  export interface Place {
    readonly cwd: string;
    /** The branch its checkout is on, where it was given one. */
    readonly branch: string | null;
    readonly dir: string;
    /** The host's own launch options — the RESERVED_INPUTS names — as a caller gave them. */
    readonly options: Readonly<Record<string, string>>;
    /** The Task this Run belongs to, whose workspace its agents open in; null for none. */
    readonly task: string | null;
    /** A workspace of the Run's own, where it asked for one; null lives in its Task's. */
    readonly workspace: string | null;
    /** This Run, then the Runs it was started from or builds a plan of, and so on: whose agents it may ask. */
    readonly lineage: ReadonlyArray<string>;
    /** What its workflow does, fixed when it started; absent from an older host. */
    readonly features?: {
      readonly review_delta?: boolean;
      readonly findings_ledger?: boolean;
      readonly inline_plan?: boolean;
      readonly agent_sessions?: "run" | "ticket" | "round";
      readonly before_review?: boolean;
    };
    /** What a Claude agent's auto mode is told this Run authorises: the branch it made, and who started it. */
    readonly authority: {
      readonly created: {
        readonly branch: string;
        readonly checkout: string;
        readonly origin: string;
      } | null;
      readonly roaming: boolean;
      readonly started: { readonly door: "board" | "desktop" | "cli-tty" | "chat"; readonly words: string } | null;
    };
  }

  /**
   * What merging the default branch did. \`ref\` and \`sha\` are what the branch is now
   * measured against; \`conflicted\` leaves the merge for the builder, naming \`files\`.
   */
  export interface Integration {
    readonly status: "unchanged" | "merged" | "conflicted" | "waiting" | "unavailable";
    readonly branch: string;
    readonly ref: string;
    readonly sha: string;
    readonly files: ReadonlyArray<string>;
    readonly reason: string;
  }
  export const IntegrationSchema: Schema.Codec<Integration, unknown, never, never>;

  /** What a Run measures with, frozen: a changed plan is a new comparison. */
  export const BenchmarkPlan: Schema.Struct<{
    /** Commits applied on the base commit, each touching only \`paths\`. */
    readonly harness: Schema.Struct<{ readonly commits: Schema.$Array<Schema.String>; readonly paths: Schema.$Array<Schema.String> }>;
    /** Run once per tree before its samples. */
    readonly prepare: Schema.withDecodingDefaultKey<Schema.NullOr<Schema.Struct<{ readonly executable: Schema.String; readonly argv: Schema.$Array<Schema.String> }>>>;
    /** Each sample runs every one, in order, in the tree's root, with no shell between. */
    readonly commands: Schema.NonEmptyArray<Schema.Struct<{ readonly name: Schema.String; readonly executable: Schema.String; readonly argv: Schema.$Array<Schema.String> }>>;
    /** \`<command>.wall_ms\`, \`<command>.cpu_ms\`, \`<command>.peak_kb\`, which the host reads, or \`<command>.<key>\` of its last stdout line's JSON. */
    readonly metrics: Schema.NonEmptyArray<Schema.Struct<{
      readonly name: Schema.String;
      readonly direction: Schema.Literals<readonly ["lower", "higher"]>;
      readonly role: Schema.Literals<readonly ["primary", "guardrail"]>;
      /** The plan's own, for this metric alone. */
      readonly threshold: Schema.optionalKey<Schema.Finite>;
      readonly tolerance: Schema.optionalKey<Schema.Finite>;
      /** In the metric's units: a difference this small is neither a gain nor a regression. */
      readonly absolute: Schema.optionalKey<Schema.Finite>;
      /** A deterministic count, such as a correctness check's mismatches: judged by value. */
      readonly exact: Schema.optionalKey<Schema.Boolean>;
      /** Why its limits are these, written before anything is measured by them. */
      readonly why: Schema.optionalKey<Schema.String>;
    }>>;
    readonly warmup: Schema.withDecodingDefaultKey<Schema.Int>;
    readonly samples: Schema.withDecodingDefaultKey<Schema.Int>;
    /** Seconds one sample, all its commands, or one tree's prepare may take. */
    readonly limit: Schema.withDecodingDefaultKey<Schema.Finite>;
    /** Percent. */
    readonly threshold: Schema.withDecodingDefaultKey<Schema.Finite>;
    readonly tolerance: Schema.withDecodingDefaultKey<Schema.Finite>;
  }>;
  /** A Run's frozen benchmark plan; a key left out takes its default. */
  export type BenchmarkPlan = typeof BenchmarkPlan.Encoded;
  export type BenchmarkCommand = BenchmarkPlan["commands"][number];
  export type BenchmarkMetric = BenchmarkPlan["metrics"][number];
  /** The plan input declares, or the reason it is not one, in \`collie measure\`'s words. */
  export const decodeBenchmarkPlan: (input: unknown) => Effect.Effect<typeof BenchmarkPlan.Type, string>;
  /** One tree a Measurement sampled. */
  export interface MeasuredTree {
    readonly cwd: string;
    readonly head_sha: string;
    readonly fingerprint: string;
    /** The Git tree HEAD names: equal on two checkouts of the same files at different commits. */
    readonly content: string;
    readonly lockfiles: Readonly<Record<string, string>>;
  }
  /** A Measurement as the host recorded it: every sample, and a verdict per metric where it was judged. */
  export interface Measurement {
    readonly id: string;
    readonly run: string;
    readonly pass: string;
    readonly machine: string;
    readonly plan: typeof BenchmarkPlan.Type;
    readonly plan_digest: string;
    readonly plan_reason: string | null;
    readonly base: MeasuredTree & { readonly commit: string };
    /** \`harness_applied\`: the harness commits a scratch tree put on a candidate that had none; it was sampled there. */
    readonly candidate: MeasuredTree & { readonly harness_applied?: ReadonlyArray<string> };
    readonly environment: Readonly<Record<string, string | null>>;
    readonly waited: { readonly memory: boolean; readonly machine: ReadonlyArray<string> };
    readonly prepare: ReadonlyArray<{ readonly tree: "base" | "candidate"; readonly exit: number; readonly seconds: number; readonly output: string }>;
    readonly samples: ReadonlyArray<{
      readonly tree: "base" | "candidate";
      readonly warmup: boolean;
      readonly readings: Readonly<Record<string, number>>;
      readonly load: ReadonlyArray<number>;
      readonly memory: { readonly available: number; readonly total: number; readonly pressure: number | null } | null;
      readonly at: string;
    }>;
    readonly result:
      | {
          readonly _tag: "Judged";
          readonly verdicts: ReadonlyArray<{
            readonly metric: string;
            readonly ratio: number;
            readonly interval: readonly [number, number];
            readonly verdict: "gain" | "no-change" | "regression" | "inconclusive";
            readonly held: boolean;
          }>;
        }
      | { readonly _tag: "TimedOut"; readonly tree: "base" | "candidate"; readonly stage: "prepare" | "sample"; readonly command: string }
      | { readonly _tag: "Failed"; readonly tree: "base" | "candidate"; readonly stage: "prepare" | "sample"; readonly command: string; readonly exit: number; readonly output: string }
      | { readonly _tag: "Unjudged"; readonly reason: string };
    readonly started: string;
    readonly at: string;
  }
  /** Keeps an infinite ratio, which plain JSON writes as null: journal a Measurement with it. */
  export const MeasurementSchema: Schema.Codec<Measurement, unknown, never, never>;
  /** A metric's own limits, and the plan's where it declares none. */
  export function limitsOf(
    plan: Pick<typeof BenchmarkPlan.Type, "threshold" | "tolerance">,
    metric: (typeof BenchmarkPlan.Type)["metrics"][number],
  ): { readonly threshold: number; readonly tolerance: number; readonly absolute: number; readonly exact: boolean };
  /**
   * What a Measurement of the base against itself says of its plan. A harness that ran nothing
   * to judge, or whose exact count differs on identical trees, is broken; a metric too noisy for
   * its limits leaves proof unavailable.
   */
  export type Calibration =
    | { readonly _tag: "Calibrated" }
    | { readonly _tag: "HarnessBroken"; readonly why: ReadonlyArray<string> }
    | { readonly _tag: "ProofUnavailable"; readonly lost: ReadonlyArray<{ readonly metric: string; readonly why: string }> };
  export function calibrationOf(measured: Pick<Measurement, "plan" | "result">): Calibration;
  /**
   * The harness \`commits\` that \`at\` lacks, in order: those after the longest prefix whose touched
   * files \`at\` holds exactly as that prefix left them, whatever their SHAs.
   */
  export function harnessLacking(cwd: string, at: string, commits: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, never, ChildProcessSpawner.ChildProcessSpawner>;

  /** What a merge at a head came to: \`MergedOutside\` is a merge this Run did not make. */
  export type MergeOutcome =
    | { readonly _tag: "Merged"; readonly sha: string }
    | { readonly _tag: "HeadMoved"; readonly head: string }
    | { readonly _tag: "MergedOutside"; readonly sha: string; readonly by: string; readonly at: string }
    | { readonly _tag: "Refused"; readonly reason: string }
    | { readonly _tag: "Transient"; readonly reason: string };
  export const MergeOutcomeSchema: Schema.Codec<MergeOutcome, unknown, never, never>;

  /** What claim holds, with what a free-only claim left to whom, why there is nothing to claim, or why the claims a Run needs could not be settled. */
  export type Claimed =
    | {
        readonly slugs: ReadonlyArray<string>;
        readonly left?: ReadonlyArray<{ readonly slug: string; readonly holder: string }>;
      }
    | { readonly none: string }
    | { readonly unresolved: string };
  export const ClaimedSchema: Schema.Codec<Claimed, unknown, never, never>;
  /** Who else holds each project a claim needs (null: free), what each application needs, and the applications each deploy job names. */
  export type Holders =
    | {
        readonly _tag: "Read";
        readonly projects: ReadonlyArray<{ readonly slug: string; readonly holder: string | null }>;
        readonly applications: ReadonlyArray<{ readonly name: string; readonly needs: ReadonlyArray<string> }>;
        readonly jobs: ReadonlyArray<{ readonly name: string; readonly applications: ReadonlyArray<string> }>;
      }
    | { readonly _tag: "Unresolved"; readonly why: string };
  export const HoldersSchema: Schema.Codec<Holders, unknown, never, never>;

  /** An external comment nobody has answered yet. */
  export interface OpenComment {
    readonly id: string;
    readonly url: string;
    readonly author: string;
    readonly at: string;
    readonly body: string;
    readonly thread: string | null;
    readonly file: string | null;
    readonly line: number | null;
  }
  /** Where a merge request's review stands, judged against the head the Run's Checks were proved on. */
  export type ReviewStanding =
    | { readonly _tag: "Ready"; readonly head: string; readonly approvers: ReadonlyArray<string> }
    | { readonly _tag: "Unanswered"; readonly head: string; readonly comments: ReadonlyArray<OpenComment>; readonly approvers?: ReadonlyArray<string> }
    | { readonly _tag: "Moved"; readonly head: string }
    | { readonly _tag: "Conflicting"; readonly head: string }
    | { readonly _tag: "FailedCi"; readonly head: string; readonly name: string; readonly url?: string }
    | { readonly _tag: "Merged"; readonly sha: string; readonly by: string; readonly at: string }
    | { readonly _tag: "Closed" }
    | { readonly _tag: "Held" }
    | { readonly _tag: "Waiting"; readonly why: ReadonlyArray<string>; readonly approvers?: ReadonlyArray<string> }
    | { readonly _tag: "Unreadable"; readonly reason: string };
  export const ReviewStandingSchema: Schema.Codec<ReviewStanding, unknown, never, never>;
  export const CONFLICTS: string;
  /** Whether a standing is still waiting on a teammate's approval, among whatever else. */
  export function waitsOnApproval(standing: ReviewStanding): boolean;

  /** Whether the Changes a ticket needs merged have landed; a wait returns every one but Waiting. */
  export type PrerequisiteStanding =
    | { readonly _tag: "Landed" }
    | { readonly _tag: "Waiting"; readonly on: string; readonly who: string }
    | { readonly _tag: "Never"; readonly why: string }
    | { readonly _tag: "Held" };
  export const PrerequisiteStandingSchema: Schema.Codec<PrerequisiteStanding, unknown, never, never>;

  /** The merge request's head, which of a round's commits it carries, and its open external comments. */
  export interface ReviewHead {
    readonly head: string;
    readonly carries: ReadonlyArray<string>;
    readonly open: ReadonlyArray<string>;
  }
  export const ReviewHeadSchema: Schema.Codec<ReviewHead, unknown, never, never>;

  /** One comment a comment round answered: \`fixed\` in \`commit\`, or \`disputed\`. */
  export interface Answer {
    readonly id: string;
    readonly answer: "fixed" | "disputed";
    readonly commit?: string;
    readonly note: string;
  }
  export const AnswerSchema: Schema.Codec<Answer, unknown, never, never>;

  /** The replies a round's answers earn, and the comments handed to the next round. */
  export interface SettledAnswers {
    readonly replies: ReadonlyArray<{ readonly id: string; readonly kind?: "fixed" | "disputed"; readonly body: string }>;
    readonly carried: ReadonlyArray<OpenComment>;
  }
  export const SettledAnswersSchema: Schema.Codec<SettledAnswers, unknown, never, never>;
  /** A fixed answer counts only where the head carries its commit; a comment answered meanwhile is dropped. */
  export function settleAnswers(round: {
    readonly given: ReadonlyArray<OpenComment>;
    readonly answers: ReadonlyArray<Answer>;
    readonly onHead: ReadonlyArray<string>;
    readonly open: ReadonlyArray<string>;
  }): SettledAnswers;

  /** Where a fast-forward left the checkout, or why it left it alone and under which park cause. */
  export type FastForward =
    | { readonly _tag: "At"; readonly head: string; readonly from: string }
    | { readonly _tag: "Refused"; readonly why: string; readonly cause: ParkCause };
  export const FastForwardSchema: Schema.Codec<FastForward, unknown, never, never>;

  /** A checkout's alignment as a Release saved it, and the head it took. */
  export type SavedAlignment = FastForward | string;
  export const SavedAlignmentSchema: Schema.Codec<SavedAlignment, unknown, never, never>;
  export const savedHead: (saved: SavedAlignment) => string | null;
  export const savedRefusalWhy: (saved: SavedAlignment) => string | null;

  /** A job of a tag's pipeline, at the address the forge gives it. */
  export interface JobLink { readonly name: string; readonly url: string; }
  export const JobLinkSchema: Schema.Codec<JobLink, unknown, never, never>;
  /** A tag proved, with the production jobs waiting on it; in production; failed on stage; or what it lacks. */
  export type TagRead =
    | { readonly _tag: "Proved"; readonly production: ReadonlyArray<JobLink>; readonly at: string }
    | { readonly _tag: "InProduction" }
    | { readonly _tag: "StageFailed"; readonly why: string }
    | { readonly _tag: "Unproved"; readonly why: string };
  export const TagReadSchema: Schema.Codec<TagRead, unknown, never, never>;
  /** Production already carries the merge, the jobs still to play, or why none may be. */
  export type ProductionRead =
    | { readonly _tag: "Carried" }
    | { readonly _tag: "Play"; readonly jobs: ReadonlyArray<JobLink> }
    | { readonly _tag: "Unproved"; readonly why: string };
  export const ProductionReadSchema: Schema.Codec<ProductionRead, unknown, never, never>;
  /** Stage shown back on what production carries, or why not. */
  export type RollbackRead = { readonly _tag: "Shown" } | { readonly _tag: "Unshown"; readonly why: string };
  export const RollbackReadSchema: Schema.Codec<RollbackRead, unknown, never, never>;
  /** A merge request's head proved on stage, with its stage jobs and environments; its head moved; or why not, with the environments its pipeline reached where read. */
  export type StageRead =
    | { readonly _tag: "Staged"; readonly jobs: ReadonlyArray<JobLink>; readonly environments: ReadonlyArray<string> }
    | { readonly _tag: "Moved"; readonly head: string; readonly environments?: ReadonlyArray<string> }
    | { readonly _tag: "Failed"; readonly why: string; readonly environments?: ReadonlyArray<string> };
  export const StageReadSchema: Schema.Codec<StageRead, unknown, never, never>;
  /** A merge request as its forge reads it now: its state and the branches it merges, and its plan's wave where a fan-out's Change run opened it. */
  export type MergeRequestRead =
    | { readonly _tag: "Read"; readonly state: string; readonly source: string; readonly target: string; readonly merged?: string; readonly checkout?: string; readonly wave?: { readonly plan: string; readonly at: number } }
    | { readonly _tag: "Unreadable"; readonly why: string };
  export const MergeRequestReadSchema: Schema.Codec<MergeRequestRead, unknown, never, never>;
  /** A set's merge requests, blockers first, each with those of the set it waits on, by branch and by its plan's earlier waves; or those waiting on each other. */
  export function stackOrder(
    mrs: ReadonlyArray<{ readonly id: string; readonly source: string; readonly target: string; readonly wave?: { readonly plan: string; readonly at: number } }>,
  ):
    | { readonly _tag: "Ordered"; readonly order: ReadonlyArray<{ readonly id: string; readonly waitsOn: ReadonlyArray<string> }> }
    | { readonly _tag: "Cycle"; readonly ids: ReadonlyArray<string> };

  /** A landing taken over from the Run that made it, or why there was none to take. */
  export type Takeover =
    | {
        readonly _tag: "TakenOver";
        readonly from: string;
        readonly sha: string;
        readonly head: string;
        readonly failure: string;
      }
    | { readonly _tag: "Refused"; readonly why: string };
  export const TakeoverSchema: Schema.Codec<Takeover, unknown, never, never>;

  /** What became of a note: whether it landed, and the sentence a human reads either way. */
  export interface Posted {
    readonly ok: boolean;
    readonly message: string;
    readonly signature?: string;
  }

  /** A pipeline job's state; \`missing\` is a pipeline without it. */
  export type JobState =
    | "passed"
    | "pending"
    | "running"
    | "failed"
    | "skipped"
    | "cancelled"
    | "missing";
  /** What became of a check left to CI: its recorded pass, or why it is unproved. */
  export type CiJob =
    | {
        readonly proved: Verification;
        /** It failed, and passed when retried: a Flake. */
        readonly retried?: true;
      }
    | {
        readonly unproved: string;
        readonly state: JobState | null;
        readonly url: string | null;
        /** The command that prints its log, where there is such a job. */
        readonly log: string | null;
        /** It failed where the branch leaves its target too, or with \`branch\` on that branch's newest commit: not this Run's to fix. */
        readonly before?: {
          readonly at: string;
          readonly url: string | null;
          readonly branch?: string;
          /** The failed jobs compared, each failing there too. */
          readonly jobs: ReadonlyArray<string>;
        };
        /** Missing because the merge request conflicts with its target branch. */
        readonly conflicts?: true;
      };
  /** A failed job's same job failed on the target branch's newest commit, with the failed tests it shares. */
  export interface TargetFailure {
    readonly job: string;
    readonly branch: string;
    readonly at: string;
    readonly url: string | null;
    readonly tests: ReadonlyArray<FailedTest>;
    /** The failed jobs compared, each failing there too; null where the failure is the Run's own. */
    readonly jobs: ReadonlyArray<string> | null;
  }
  /** What a Release that saw a failure its target shared does once that target passes. */
  export type TakeTarget =
    | { readonly _tag: "Moved"; readonly head: string }
    | { readonly _tag: "Retried" }
    | { readonly _tag: "Take" };

  /** What asking for a pipeline on a merge request's head came to. */
  export type PipelineStart =
    | { readonly _tag: "Has"; readonly url: string }
    | { readonly _tag: "Started"; readonly url: string }
    | { readonly _tag: "Unneeded"; readonly why: string }
    | { readonly _tag: "NoneByRules"; readonly message: string }
    | { readonly _tag: "Failed"; readonly reason: string };

  /** One of this Run's checks, named by a human, chat or the Run's agent. */
  export interface VerifySpec {
    readonly name: string;
    readonly executable: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    /** The merge request pipeline job that proves it: nobody runs it locally. */
    readonly ci?: string;
    /** Run in a detached checkout of its start tree, so edits in the Worktree cannot move it. */
    readonly isolated?: boolean;
    /** Run first in that checkout, recorded with the check. */
    readonly prepare?: { readonly executable: string; readonly argv: ReadonlyArray<string> };
    /** Run on the builder's tree before a review round opens; never with \`ci\`. */
    readonly before_review?: boolean;
  }

  /** The reviewed branch's checkout, or why there is none. */
  export type ReviewedCheckout =
    | { readonly cwd: string; readonly branch: string }
    | { readonly refused: string };

  /** The reviewed branch, or why there is none. */
  export type ReviewedBranch = { readonly branch: string } | { readonly refused: string };
  /** A merge request as a round reads it before it starts: where its watch takes up from. */
  export interface MrRead {
    readonly state: "open" | "merged" | "closed";
    readonly head: string;
    readonly author: string;
    readonly pipeline: string;
    readonly comments: ReadonlyArray<string>;
    readonly replies?: ReadonlyArray<{
      readonly id: string;
      readonly author: string;
      readonly thread: string | null;
      readonly body: string;
      readonly run: string | null;
    }>;
  }
  export const MrRead: Schema.Codec<MrRead, unknown, never, never>;
  export type PinnedHead =
    | { readonly cwd: string }
    | { readonly moved: string }
    | { readonly refused: string };
  export const PinnedHead: Schema.Codec<PinnedHead, unknown, never, never>;

  /** What opening a merge request from here needs, and what it would be filled in with. */
  export interface MrReady {
    readonly ok: boolean;
    readonly cause?: ParkCause;
    readonly provider?: "gitlab" | "github";
    readonly repository?: string;
    /** Why it cannot be done here. Empty where it can. */
    readonly reason: string;
    /** The configured assignee, else whoever the forge's CLI is logged in as; empty for neither. */
    readonly assignee: string;
    /** The repository's merge request template, relative to the checkout; empty for none. */
    readonly template: string;
    readonly issues: ReadonlyArray<string>;
    /** "GitLab" or "GitHub". */
    readonly forge?: string;
    /** "merge request" or "pull request". */
    readonly noun?: string;
    /** The checkout's branch; empty on a detached checkout. */
    readonly branch?: string;
    /** The repository's web address, as its forge's adapter writes it. */
    readonly url?: string;
    /** The URL of this branch's open merge request, or empty for none. */
    readonly existing?: string;
    /** Whether \`existing\` merges itself once green, so a push to it is a merge. */
    readonly autoMerge?: boolean;
  }

  /** What the host lends a workflow. Hold and stop are read fresh on every replay. */
  export interface HostApi {
    readonly reviewFix: (runId: string, target: string) => Effect.Effect<{ readonly owned: boolean; readonly head: string; readonly reviewed: string; readonly lineage: ReadonlyArray<string>; readonly following: boolean }>;
    readonly reviewScope: (runId: string, source: string, outcome: string, risks: string) => Effect.Effect<ReviewScope | null>;
    readonly recordReview: (runId: string, scope: ReviewScope | null, base: string, review: SynthesisReport) => Effect.Effect<void>;
    readonly recovery: (runId: string, parent: string, source: string) => Effect.Effect<Recovery, WorkflowError>;
    readonly report: (since: string) => Effect.Effect<Report, WorkflowError>;
    readonly issues: (runId: string, which?: ReadonlyArray<number> | { readonly closedSince: string }, on?: "collie") => Effect.Effect<ReadonlyArray<Issue>, WorkflowError>;
    readonly requests: (runId: string) => Effect.Effect<ReadonlyArray<Issue>, WorkflowError>;
    readonly releases: (runId: string) => Effect.Effect<ReadonlyArray<{ readonly tag: string; readonly at: string }>, WorkflowError>;
    readonly fileIssue: (options: { readonly runId: string; readonly title: string; readonly body: string; readonly on?: "collie" }) => Effect.Effect<IssueRef, WorkflowError>;
    readonly commentIssue: (options: { readonly runId: string; readonly number: number; readonly body: string; readonly on?: "collie" }) => Effect.Effect<void, WorkflowError>;
    readonly dir: string;
    /** The Collie release this host runs, as its tag names it. */
    readonly build: string;
    /**
     * This Machine's Usage readings, one per Subscription. Read it inside an Activity of
     * the workflow's own where it branches on it, so a replay takes the same branch.
     */
    readonly usage: () => Effect.Effect<ReadonlyArray<UsageReading>>;
    /** The installed \`SKILL.md\` an agent's \`{{skill:name}}\` would name, or null. */
    readonly skill: (name: string) => Effect.Effect<string | null>;
    /** This Run as the host admitted it; its directory is made as this is answered. */
    readonly place: (runId: string) => Effect.Effect<Place>;
    /** Whether the branch this Run's diff target names can be established; cuts and records nothing. */
    readonly reviewedBranch: (runId: string) => Effect.Effect<ReviewedBranch>;
    /** The checkout of the branch this Run's diff target names, recorded as the Run's own; \`inStarter\` may take the waiting starter's. */
    readonly checkoutReviewed: (
      runId: string,
      opts?: { readonly inStarter?: boolean },
    ) => Effect.Effect<ReviewedCheckout>;
    /** Where \`failed\`'s reviewed checkout was refused, why another on \`target\` this Run waits on still would be, or null; cuts nothing. */
    readonly reviewedRefusal: (
      runId: string,
      failed: string,
      target: string,
    ) => Effect.Effect<string | null>;
    readonly held: (runId: string) => Effect.Effect<boolean>;
    readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
    readonly record: (runId: string, event: string) => Effect.Effect<void>;
    /** Records that its work waits on a Subscription to reset; null says it no longer does. */
    readonly usageWait: (runId: string, wait: { readonly account: string; readonly resetsAt: string | null } | null) => Effect.Effect<void>;
    /** Records where the Run's work is among its Steps; \`step\` and \`forecast\` call it. */
    readonly step: (runId: string, note: { readonly kind: string } & Record<string, unknown>) => Effect.Effect<void>;
    /** Records what an implementer says it has done with a ticket, carded while it works. */
    readonly checkpoint: (runId: string, checkpoint: { readonly ticket: string; readonly status: "started" | "done"; readonly claims: ReadonlyArray<string> }) => Effect.Effect<void>;
    /** Why this Run parked its own work, shown beside its status; null clears it. No cause is \`unknown\`. */
    readonly parked: (runId: string, why: string | null, cause?: ParkCause) => Effect.Effect<void>;
    readonly asking: (runId: string, question: DecisionSpec, asker?: string) => Effect.Effect<void>;
    /** Every question this run has been asked, oldest first, with its answer once it has one. */
    readonly asked: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<{
      readonly name: string;
      readonly answer: string | null;
      /** Who answered it, where the Run's audit says: a front door, and for chat the human's words that turn. */
      readonly by?: { readonly origin: string; readonly said?: string };
    }>>;
    /** Answers an open question with \`value\` as Collie, waking nothing that waits on it. */
    readonly close: (runId: string, decision: string, value: string) => Effect.Effect<void>;
    /** What has been verified for this run, and the tree in front of it now. */
    readonly evidence: (runId: string, cwd: string) => Effect.Effect<CheckEvidence>;
    /** Runs one of this Run's checks and records it. A name not among them is refused. */
    readonly verify: (options: {
      readonly runId: string;
      readonly name: string;
      readonly cwd: string;
      readonly expect?: "pass" | "fail";
      /** Run it where this checkout left the default branch, then put the checkout back. */
      readonly at?: "default-base";
      /** Why it is run: the gate on the branch, a rerun of one failed \`test\`, a recheck for a flake, or a fix after gate fix \`round\`. */
      readonly pass?: "gate" | "rerun" | "recheck" | "fix";
      readonly round?: number;
      readonly test?: FailedTest;
    }) => Effect.Effect<Verification, WorkflowError>;
    /**
     * Puts a file on the merge request a Run was pointed at, as one note Collie sends.
     * The refusal is the message: not a merge request, no glab for it, or one assigned
     * to whoever is running this — whose findings are theirs to fix rather than to post.
     */
    readonly post: (options: {
      readonly runId: string;
      readonly target: string;
      readonly cwd: string;
      readonly file: string;
      readonly head: string;
      readonly round: number;
    }) => Effect.Effect<Posted>;
    readonly slackTarget: (link: string, target?: string) => Effect.Effect<string, WorkflowError>;
    readonly reviewSlack: (options: { readonly runId: string; readonly target: string; readonly cwd: string; readonly permalink?: string; readonly wanted: ReadonlyArray<string> }) => Effect.Effect<string>;
    /** Reads the target's head before review, else the checkout's HEAD. Take it inside an Activity. */
    readonly reviewedHead: (options: {
      readonly target: string;
      readonly cwd: string;
    }) => Effect.Effect<string>;
    /**
     * What changed from \`previous\` to \`head\`: a merge request's interdiff, else the checkout's
     * commits and files since \`previous\`, with the command that shows their diff. A
     * local \`base\`, the default branch merged in since, is left out of them.
     */
    readonly reviewChanges: (options: {
      readonly target: string;
      readonly cwd: string;
      readonly previous: string;
      readonly head: string;
      readonly base?: string;
    }) => Effect.Effect<string, WorkflowError>;
    /** Approves once per Run and attempt; an interrupted attempt returns an uncertain outcome. */
    readonly approveReview: (options: {
      readonly runId: string;
      readonly attempt: string;
      readonly target: string;
      readonly cwd: string;
      readonly head: string;
    }) => Effect.Effect<Posted>;
    /** This Run's checks as they stand now, which anyone may add to. */
    readonly approved: (runId: string) => Effect.Effect<ReadonlyArray<VerifySpec>>;
    /** One value from the operator's own configuration, by dotted name, as text; empty for none. */
    readonly config: (dotted: string) => Effect.Effect<string>;
    /** This Machine's reading; take it inside an Activity when branching on it. */
    readonly connection: (id: ConnectionId) => Effect.Effect<ConnectionReading>;
    readonly shareForApproval: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly channel: string;
    }) => Effect.Effect<{ readonly posted: boolean; readonly link?: string; readonly why?: string }>;
    /** Whether a merge request can be opened from here, and what it would carry. */
    readonly mr: (options: {
      readonly cwd: string;
      readonly target?: string;
      readonly source?: { readonly value: string; readonly kind: string };
      /** The branch a new merge request targets, where it is not the default branch. */
      readonly onto?: string | undefined;
    }) => Effect.Effect<MrReady>;
    readonly publish: (options: { readonly runId: string; readonly title: string; readonly file: string; readonly onto?: string | undefined; readonly pushOnly?: boolean | undefined; readonly skipCi?: boolean | undefined }) => Effect.Effect<{ readonly url: string }, WorkflowError>;
    /**
     * The checkout's branch's open merge request where it merges itself once green, else null.
     * Fails, saying why, where the forge cannot be read: not knowing is not a no.
     */
    readonly autoMerging: (cwd: string) => Effect.Effect<string | null, WorkflowError>;
    /**
     * The job proving a check left to CI, on the head of the merge request this Run recorded,
     * which must be cwd's HEAD. A pass is recorded once per tree as the check's \`ci\`
     * Verification. With wait, a pending or running job is read again every 30 s for up to 2
     * hours. Anything else is why it is unproved, naming the check, the job and the commit.
     * With settle, a failed job is read on the target branch's newest commit, then where the
     * branch leaves its target, and is retried once and waited on where its failed jobs and
     * tests did not fail there too.
     */
    readonly ciJob: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly name: string;
      readonly wait?: boolean;
      readonly settle?: boolean;
    }) => Effect.Effect<CiJob>;
    /** This Run's CI failure on its merge request's head where its target branch's newest commit shares it, else null. */
    readonly targetFailure: (options: {
      readonly runId: string;
      readonly cwd: string;
    }) => Effect.Effect<TargetFailure | null>;
    /** What a Release that saw a failure its target shared at \`head\` does now: Moved, Retried or Take. */
    readonly takeTarget: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly head: string;
    }) => Effect.Effect<TakeTarget>;
    /**
     * A pipeline on cwd's HEAD, through the forge of the merge request the Run recorded,
     * unless that head has one that was not skipped. GitLab starts the merge request's, and
     * the source branch's where it refuses that with 400; refused both ways with 400 is
     * NoneByRules, in GitLab's words. GitHub starts nothing.
     */
    readonly startPipeline: (options: {
      readonly runId: string;
      readonly cwd: string;
    }) => Effect.Effect<PipelineStart>;
    /** Puts a note on the merge request this Run recorded, sent by Collie. */
    readonly note: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly body: string;
    }) => Effect.Effect<Posted>;
    /**
     * Blocks until this Run holds every shared claim it needs, and answers which; unresolved
     * says why they could not be settled, with nothing claimed. deploys adds each project an
     * application or deploy job names. Waiting here costs wall clock and no model tokens.
     * adopting is asked only where a claim was already the operator's.
     */
    readonly claim: <E, R>(options: {
      readonly runId: string;
      readonly cwd: string;
      readonly adopting: Effect.Effect<boolean, E, R>;
      readonly say: (line: string) => Effect.Effect<void, E, R>;
      readonly deploys?: {
        readonly applications: ReadonlyArray<string>;
        readonly jobs: ReadonlyArray<string>;
      };
      /** Takes only what nobody else holds or queues for, waits for none, and names what it left. */
      readonly free?: boolean;
    }) => Effect.Effect<Claimed, WorkflowError | E, R>;
    /** Who holds each claim for the same deploys, joining no queue. */
    readonly holders: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly deploys?: {
        readonly applications: ReadonlyArray<string>;
        readonly jobs: ReadonlyArray<string>;
      };
    }) => Effect.Effect<Holders, WorkflowError>;
    /** Gives every claim back, answering those Helle kept. Only a finished Run releases. */
    readonly release: (runId: string) => Effect.Effect<ReadonlyArray<string>>;
    /** Records the merge request this Run opened, as a fact its card reads. */
    readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
    /**
     * Fetches the default branch and, where it has moved, merges it into the checkout at cwd:
     * a merge commit, never a rebase or a push. Uncommitted changes are left alone (\`waiting\`);
     * a conflict is left in progress for the builder. Each merge is recorded in the Run log as
     * \`integrated <branch>@<sha>\`. Take it inside an Activity, so a replay does not merge again.
     */
    readonly integrate: (runId: string, cwd: string) => Effect.Effect<Integration>;
    /**
     * A Measurement of cwd, the Run's checkout, against a base tree Collie makes at base with the
     * plan's harness commits applied, sampled A B B A … while no other Measurement runs on this
     * Machine and it is not Short of memory. Where these trees were measured under this plan, that
     * record answers and ran is false. Take it inside an Activity, so a replay does not measure again.
     */
    readonly measure: (options: {
      readonly runId: string;
      readonly base: string;
      readonly cwd: string;
      readonly plan: BenchmarkPlan;
      /** \`calibration\`, \`cycle N\` or \`final\`. */
      readonly pass: string;
      /** Why the plan changed: refused without one where the Run was measured under another plan. */
      readonly reason?: string;
    }) => Effect.Effect<{ readonly measurement: Measurement; readonly ran: boolean }, WorkflowError>;
    /** The commit origin's default branch is at now. Take it inside an Activity. */
    readonly defaultHead: (cwd: string) => Effect.Effect<string, WorkflowError>;
    /**
     * Where the checkout at cwd has no commits over its merge-base with the default branch and
     * nothing uncommitted, records that this Run had nothing to land and answers why; else null.
     * Take it inside an Activity.
     */
    readonly nothingToLand: (runId: string, cwd: string) => Effect.Effect<string | null>;
    /** Each finding the Run at dir left, with the status its journal last set on it. */
    readonly findingStatuses: (dir: string) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly status: FindingWord;
        readonly run: string | null;
      }>
    >;
    /**
     * Merges the merge request this Run recorded at \`head\`, recording the landing first and
     * its outcome after; fails for a Run that recorded none. Take it inside an Activity.
     */
    readonly merge: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly head: string;
    }) => Effect.Effect<MergeOutcome, WorkflowError>;
    /** One read of the review of the merge request this Run recorded, judged against \`proved\`. Take it inside an Activity. */
    readonly review: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly proved: string;
      readonly seen: ReadonlyArray<string>;
    }) => Effect.Effect<ReviewStanding, WorkflowError>;
    /**
     * Reads the review every 5 minutes, with no agent turn, until it is ready at \`proved\`, has
     * unanswered comments not in \`seen\`, has moved, merged or closed, or is held. Take it
     * inside an Activity, and suspend on \`Held\` there.
     */
    readonly awaitReview: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly proved: string;
      readonly seen: ReadonlyArray<string>;
      /** Also return a \`Waiting\` review that needs a repair, rather than wait for it. */
      readonly untilBlocked?: boolean;
      /**
       * Wait only while the forge says the merge request conflicts with its target branch,
       * parked with the line that says its branch must take the target, and return the
       * standing at \`proved\` once it no longer does, or it is merged or closed, or a Hold or
       * Stop ends it.
       */
      readonly whileConflicting?: boolean;
      /** Return a confirmed target conflict at its current head for repair. */
      readonly returnConflicts?: boolean;
      /** Return terminal CI failure at the proved head, after fresh comments. */
      readonly returnFailedCi?: boolean;
    }) => Effect.Effect<ReviewStanding, WorkflowError>;
    /** Has the merge watch watch \`target\` for this Run's wake \`name\` from \`cursor\`; \`watch\` takes it. */
    readonly watching: (options: {
      readonly runId: string;
      readonly target: string;
      readonly name: string;
      readonly cursor: WatchCursor;
      readonly author?: string;
      readonly approved?: string;
      /** A question shares the wake, so the card waits on whoever answers that. */
      readonly asking?: boolean;
    }) => Effect.Effect<void, WorkflowError>;
    /** The merge request \`target\` as the forge reads it now: what a watch's cursor starts from. Take it inside an Activity. */
    readonly mrReading: (options: {
      readonly target: string;
      readonly cwd: string;
      readonly replies?: boolean;
    }) => Effect.Effect<MrRead, WorkflowError>;
    /** Whether this login's approval of \`target\` stands while its head is \`head\`. Take it inside an Activity. */
    readonly approvedAt: (options: {
      readonly target: string;
      readonly cwd: string;
      readonly head: string;
    }) => Effect.Effect<boolean, WorkflowError>;
    /** Makes this Run's checkout \`target\`'s head, detached and Collie's, from the forge's own ref; \`moved\` where that is no longer \`head\`. Take it inside an Activity. */
    readonly pinHead: (options: {
      readonly runId: string;
      readonly target: string;
      readonly head: string;
    }) => Effect.Effect<PinnedHead, WorkflowError>;
    /** Whether \`head\` descends from \`previous\` on \`target\`'s forge; a \`previous\` it no longer has does not. Take it inside an Activity. */
    readonly descends: (options: {
      readonly target: string;
      readonly cwd: string;
      readonly previous: string;
      readonly head: string;
    }) => Effect.Effect<boolean, WorkflowError>;
    /**
     * One read of whether the Changes the ticket at \`ticket\` names on its **Needs merged:** line
     * have landed on origin's default branch: Landed, Waiting or Never. Take it inside an Activity.
     */
    readonly prerequisites: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly ticket: string;
    }) => Effect.Effect<PrerequisiteStanding, WorkflowError>;
    /**
     * Reads the ticket's Prerequisites every 5 minutes, with no agent turn, until they are
     * Landed, one is Never, or a Hold or Stop ends the wait (Held). Take it inside an Activity,
     * and suspend on \`Held\` there.
     */
    readonly awaitPrerequisites: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly ticket: string;
    }) => Effect.Effect<PrerequisiteStanding, WorkflowError>;
    /** Replies to comment \`comment\` of the recorded merge request, signed and recorded on the Run, unless it is answered already; a \`disputed\` one is News. Take it inside an Activity. */
    readonly reply: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly comment: string;
      readonly body: string;
      readonly kind?: "fixed" | "disputed";
    }) => Effect.Effect<"posted" | "already", WorkflowError>;
    /** The recorded merge request's head, which of \`commits\` it carries, and its open external comments. Take it inside an Activity. */
    readonly reviewHead: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly commits: ReadonlyArray<string>;
    }) => Effect.Effect<ReviewHead, WorkflowError>;
    /** Brings the checkout to \`head\` after the Run's agents there stop, resetting it only where the checkout's own head was published. Take it inside an Activity. */
    readonly fastForward: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly head: string;
      /** Where supplied, require this source branch before moving the checkout. */
      readonly branch?: string;    }) => Effect.Effect<FastForward, WorkflowError>;
    /** Reads \`tag\` back from origin and the forge against what it must prove. Take it inside an Activity. */
    readonly readTag: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly tag: string;
      readonly merged: string;
      readonly pipeline: string | null;
      readonly proves: "finished" | "staged";
      readonly stage?: ReadonlyArray<string>;
      readonly production?: ReadonlyArray<string>;
    }) => Effect.Effect<TagRead>;
    /** What is left to play for production of \`tag\`, read again. Take it inside an Activity. */
    readonly readProduction: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly tag: string;
      readonly at: string;
      readonly merged: string;
      readonly pipeline: string;
      readonly jobs: ReadonlyArray<string>;
    }) => Effect.Effect<ProductionRead>;
    /** The merge request's head on stage: its \`jobs\` passed there, and every stage environment its pipeline deployed to carries it. Take it inside an Activity. */
    readonly readStage: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly head: string;
      readonly jobs: ReadonlyArray<string>;
    }) => Effect.Effect<StageRead>;
    /** A merge request as its forge reads it now, from \`cwd\`. Take it inside an Activity. */
    readonly readMergeRequest: (options: {
      readonly cwd: string;
      readonly mr: string;
      readonly checkout?: boolean;
    }) => Effect.Effect<MergeRequestRead>;
    /** Whether stage is shown back on what production carries, and off \`off\`, in \`environments\` where named. Take it inside an Activity. */
    readonly readRollback: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly off: ReadonlyArray<string>;
      readonly environments?: ReadonlyArray<string>;
    }) => Effect.Effect<RollbackRead>;
    /** Takes over the landing of a merged merge request from the failed Run that made it. Take it inside an Activity. */
    readonly takeOverLanding: (options: {
      readonly runId: string;
      readonly cwd: string;
    }) => Effect.Effect<Takeover, WorkflowError>;
    /**
     * Blocks, with no agent turn, until the forge shows production carries \`sha\`, saying
     * on the card what it waits for: true then, false where the Run was stopped or held first.
     */
    readonly awaitProduction: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly sha: string;
      readonly jobs: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
      readonly played?: boolean;
      readonly slug?: string;
      readonly url: string;
    }) => Effect.Effect<boolean>;
  }
  export const Host: Context.Service<HostApi, HostApi>;
  export interface IssueRef { readonly number: number; readonly url: string; }
  export interface Issue extends IssueRef { readonly title: string; readonly body: string; }
  export interface WorkflowTally {
    readonly workflow: string;
    readonly total: number;
    readonly complete: number;
    readonly failed: number;
    readonly suspended: number;
    readonly pending: number;
    /** Carries a stop control: a human stopped it. */
    readonly stopped: number;
    /** Recorded a merge request (RunView.mr). */
    readonly withMr: number;
    readonly answered: number;
    readonly open: number;
    readonly rework: number;
    readonly verifications: {
      readonly pass: number;
      readonly fail: number;
      readonly unstable: number;
    };
  }

  export interface Report {
    readonly since: string | null;
    readonly total: number;
    readonly runs: ReadonlyArray<{
      readonly runId: string;
      readonly workflow: string;
      readonly parent: string | null;
      readonly project: string;
      readonly created: string;
      readonly status: "pending" | "suspended" | "complete" | "failed";
      /** The issues its input says \`Closes #n\` for. */
      readonly closes: ReadonlyArray<number>;
      readonly mr: string | null;
      /** Its merge request's disposition was recorded as merged. */
      readonly merged: boolean;
      /** The questions it asked that were not set aside, with what answered each. */
      readonly questions: ReadonlyArray<{ readonly name: string; readonly answer: string | null }>;
    }>;
    readonly workflows: ReadonlyArray<WorkflowTally>;
    readonly failed: ReadonlyArray<{ runId: string; workflow: string; reason: string }>;
    readonly completed: ReadonlyArray<{
      runId: string;
      workflow: string;
      value: string;
      mr: string | null;
    }>;
    readonly stopped: ReadonlyArray<{ runId: string; workflow: string }>;
  }

  export type Host = HostApi;

  /** How every workflow reports a failure. */
  export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
    "WorkflowError",
    { reason: Schema.String },
  ) {
    /** The reason, so a died refusal still names it. */
    override get message(): string;
  }

  /** The Run a workflow is executing as: supplied by the host, never passed by hand. */
  export interface RunApi {
    readonly id: string;
    /** The public id of the workflow it is a Run of. */
    readonly workflow: string;
  }
  export const Run: Context.Service<RunApi, RunApi>;
  export type Run = RunApi;

  export interface ClaudeSubagents {
    readonly enabled?: boolean;
    readonly model?: string;
    readonly forceModel?: boolean;
    readonly cacheTtl?: "5m" | "1h";
    readonly maxDepth?: number;
    readonly maxConcurrent?: number;
  }

  /** Which agent does the work: each is inherited from the configuration where it is left out. */
  export interface AgentPreferences {
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly claudeSubagents?: ClaudeSubagents;
    /** Past this share of its busiest window, 1–100, this agent is not chosen for new work. */
    readonly upTo?: number;
    /** What to try past \`upTo\` or once Exhausted, before the human's \`fallbacks\`. */
    readonly otherwise?: ReadonlyArray<AgentPreferences>;
  }

  /** One window of a Subscription's usage, as its source reported it. */
  export interface UsageWindow {
    readonly kind: "session" | "weekly" | "weekly-model" | "other";
    readonly label: string;
    /** The model a \`weekly-model\` window applies to. */
    readonly model: string | null;
    /** 0–100. */
    readonly usedPercent: number;
    readonly resetsAt: string | null;
    readonly reached: boolean;
  }

  /** How much of one Subscription a Machine's login has used, and when that was true. */
  export interface UsageReading {
    readonly subscription: "claude" | "chatgpt";
    /** The account's stable id, never its email. */
    readonly account: string | null;
    readonly accountLabel: string | null;
    readonly plan: string | null;
    readonly windows: ReadonlyArray<UsageWindow>;
    readonly at: string;
    readonly source: "claude-usage" | "claude-status-line" | "codex-app-server";
    /** Why there is no fresh reading, in a sentence. */
    readonly problem: string | null;
  }

  /** The Subscription a choice draws on, or null where Collie reads none for it. */
  export function subscriptionOf(choice: {
    readonly harness: string;
    readonly model: string;
  }): "claude" | "chatgpt" | null;

  /**
   * How much of the busiest window that applies to this choice is used at \`now\`, and
   * whether its Subscription is Exhausted for it; null where nothing is read for it.
   */
  export function usedFor(
    readings: ReadonlyArray<UsageReading>,
    choice: { readonly harness: string; readonly model: string },
    now: number,
  ): {
    readonly window: UsageWindow;
    readonly usedPercent: number;
    readonly resetsAt: string | null;
    readonly exhausted: boolean;
  } | null;

  /**
   * One place at a panel: the agent that sits there, and what it is and is told where that
   * is not its role's persona and its work's own instructions.
   */
  export interface Seat extends AgentPreferences {
    /** Tells this seat's work apart from the others', in its operation's name. */
    readonly name?: string;
    /** The persona it is started as, in place of its role's. */
    readonly persona?: string;
    /** What it is told in place of its work's instructions, filled from the same input. */
    readonly instructions?: string | Template<unknown>;
  }

  /**
   * What a definition prefers: for all of its work, and over that for the work of a role —
   * one seat, or a panel of them — which is how a fork moves one role's agents and leaves
   * everything else the original's.
   */
  export interface WorkflowAgentPreferences extends AgentPreferences {
    readonly roles?: Readonly<Record<string, Seat | ReadonlyArray<Seat>>>;
  }

  /**
   * The panel this workflow's definition seats for a role: every seat it names, or one that
   * prefers nothing of its own where it names none. Work given a seat sits at it.
   */
  export function panelOf(role: string): Effect.Effect<readonly [Seat, ...Seat[]]>;

  /**
   * Every piece of agent work inside the effect prefers these — through any helper and into
   * any child — unless something nearer says otherwise. Parallel branches keep their own.
   */
  export function withAgents(
    preferences: AgentPreferences,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

  /** What a workflow's own code may use without providing it: the host lends all of it. */
  export type Lent =
    | Run
    | Host
    | Agents
    | Children
    | WorkflowEngine
    | WorkflowInstance
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner;

  /** What a definition declares about itself beside what it does. */
  export interface Declarations {
    readonly connections?: WorkflowConnections;
    /** The Steps it expects to take, in order: a forecast, never a precondition. */
    readonly path?: ReadonlyArray<Step>;
    readonly hints?: Readonly<Record<string, string>>;
    readonly outcome?: OutcomeContract;
    /** A worktree the host cuts before the Run exists; absent works where it was started. */
    readonly checkout?: "branch" | "roaming";
    readonly closes?: "reported";
    /** The healer: what the host starts for a park its own recovery could not clear. */
    readonly heals?: true;
    readonly followUps?: ReadonlyArray<FollowUp>;
    readonly actions?: ReadonlyArray<ActionProvider>;
    /** The boolean setting that, on, makes a start on a merge request its login's one Run of it. */
    readonly follows?: string;
  }

  export interface WorkflowConnections {
    readonly needs?: Partial<Record<ConnectionId, { readonly with: string }>>;
    readonly uses?: Partial<Record<ConnectionId, { readonly with: string; readonly without: string }>>;
  }

  /** A workflow: its identity, what it takes and gives, what it declares, and what it does. */
  export interface Definition<
    Fields extends Schema.Struct.Fields,
    Output extends Schema.Top,
    Err extends Schema.Top,
    Provided,
  > extends Declarations {
    readonly id: string;
    readonly title?: string;
    readonly description?: string;
    readonly input?: Schema.Struct<Fields>;
    readonly output?: Output;
    /** A typed failure of the workflow's own, beside the WorkflowError every workflow has. */
    readonly error?: Err;
    /** The agent every piece of work defaults to, over the operator's configuration. */
    readonly agents?: WorkflowAgentPreferences;
    /** The services run needs that the host does not lend. */
    readonly layer?: Layer.Layer<Provided, never, Exclude<Lent, Run | WorkflowInstance>>;
    readonly run: (context: {
      readonly input: Schema.Struct<Fields>["Type"];
    }) => Effect.Effect<Output["Type"], WorkflowError | Err["Type"], Lent | Provided>;
  }

  /**
   * A workflow, as the one thing its module exports by default. Left out, the title is the
   * id, the description is empty, it takes nothing and it gives nothing back.
   */
  export function defineWorkflow<
    const Fields extends Schema.Struct.Fields = {},
    Output extends Schema.Top = typeof Schema.Void,
    Err extends Schema.Top = typeof Schema.Never,
    Provided = never,
  >(
    definition: Definition<Fields, Output, Err, Provided>,
  ): Definition<Fields, Output, Err, Provided>;

  /** One solution a question offers; an answer names its id or its title. */
  export interface Solution {
    readonly id: string;
    readonly title: string;
    readonly detail?: string;
    readonly recommended?: boolean;
  }

  /** A question as the host records it: its identity, what it asks, what it takes. */
  export type ShippingGo =
    | { readonly action: "merge" | "stage" | "deploy"; readonly head: string }
    | { readonly action: "deploy"; readonly tag: string };

  export interface DecisionSpec {
    readonly shipping?: ShippingGo;
    readonly name: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string | Solution>;
    /** What keeps it short of standard, flagged wherever it is shown. */
    readonly shortfall?: string;
  }

  /** One answer an \`ask\` takes: a bare string is its id and title. */
  export type AskOption =
    | string
    | {
        readonly id: string;
        readonly title?: string;
        /** One line on why it matters or what it leads to. */
        readonly detail?: string;
        readonly recommended?: boolean;
      };

  /**
   * A question this Run waits on, asked when the work reaches it. The name is its identity,
   * and it returns the chosen option's id. Exactly one option is recommended; none or more
   * than one is posted unmarked with a shortfall, and the Run goes on.
   */
  export function ask(question: {
    readonly shipping?: ShippingGo;
    readonly name: string;
    readonly prompt?: string;
    /** The answers it takes; none is a question answered in the operator's own words. */
    readonly options?: ReadonlyArray<AskOption>;
  }): Effect.Effect<string, never, Run | Host | WorkflowEngine | WorkflowInstance>;

  /** Where a Run watching a merge request left off: its head, the comments it saw, its head's checks. */
  export interface WatchCursor {
    readonly head: string;
    readonly seen: ReadonlyArray<string>;
    readonly pipeline: string;
    readonly headOnly?: boolean;
  }
  /** What changed on a watched merge request; \`forcePush\` says a new head does not descend from \`previous\`. */
  export interface WatchChange {
    readonly head: string;
    readonly previous: string;
    readonly newHead: boolean;
    readonly comments: ReadonlyArray<string>;
    readonly pipeline: string | null;
    readonly forcePush: boolean | null;
  }
  export type Woke =
    | { readonly _tag: "Changed"; readonly change: WatchChange }
    | { readonly _tag: "Ended"; readonly state: "merged" | "closed" };

  /**
   * Suspends this Run, with no agent and no forge read of its own, until the merge watch reads
   * \`target\` changed from \`cursor\` in a way that matters, or merged or closed. The name is
   * its identity, as an \`ask\`'s is.
   */
  export function watch(options: Watching): Effect.Effect<Woke, WorkflowError, Run | Host | WorkflowEngine | WorkflowInstance>;
  export interface Watching {
    readonly name: string;
    readonly target: string;
    readonly cwd: string;
    readonly cursor: WatchCursor;
    /** Who the card names as waited on, the author by default. */
    readonly author?: string;
    /** The head this login's approval stands at, which the card says beside the wait. */
    readonly approved?: string;
  }
  export interface Answered {
    readonly _tag: "Answered";
    readonly answer: string;
  }
  /**
   * Asks \`question\` while watching as \`watch\` does, under the watch's name: whichever comes
   * first, its answer or a change that matters, is what this returns. A change closes the
   * question unanswered.
   */
  export function askWhileWatching(
    question: {
      readonly prompt?: string;
      readonly options?: ReadonlyArray<AskOption>;
    },
    options: Watching,
  ): Effect.Effect<Woke | Answered, WorkflowError, Run | Host | WorkflowEngine | WorkflowInstance>;

  /** What a parent asks for when part of its own work is another workflow. */
  export interface ChildAsk {
    /** Stable within the parent: the same one twice is the same child. */
    readonly invocation: string;
    /** A public id, or "self" for the parent's own. */
    readonly workflow: string;
    readonly input: Readonly<Record<string, unknown>>;
    /** The host's own options for the child; only the host's own names are taken. */
    readonly options?: Readonly<Record<string, string>>;
    /** A Task of its own, with its own workspace and card, rather than the parent's. */
    readonly ownTask?: boolean;
  }

  /** A child as the host admitted it; fresh is false for one already admitted. */
  export interface ChildRun {
    readonly runId: string;
    readonly workflow: string;
    readonly invocation: string;
    readonly fresh: boolean;
  }

  /** What a host lends a workflow that is made of other workflows. */
  export interface ChildrenApi {
    readonly start: (ask: ChildAsk) => Effect.Effect<ChildRun, WorkflowError>;
    readonly result: (child: ChildRun) => Effect.Effect<unknown, WorkflowError>;
  }
  export const Children: Context.Service<ChildrenApi, ChildrenApi>;
  export type Children = ChildrenApi;

  /** One child workflow, started and waited on. */
  export function child(
    ask: ChildAsk,
  ): Effect.Effect<unknown, WorkflowError, Children>;

  export type StepKind = "agent" | "question" | "workflow" | "check";
  export type Produces = "plan" | "review" | "evidence" | "merge-request";

  /** What a reader needs of a Step before it runs. */
  export interface StepMeta {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly kind: StepKind;
    readonly role: string | null;
    readonly produces: Produces | null;
  }

  /** What an author declares of a Step. */
  export interface StepDeclaration {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly kind: StepKind;
    readonly role?: string;
    readonly produces?: Produces;
  }

  /** Which run of a Step a call is: a round under its bound, or an item of its list. */
  export type StepCall =
    | { readonly round: number; readonly of?: number }
    | { readonly item: string; readonly items: ReadonlyArray<string> };

  /** Called around the Effect that does its work: it runs it unchanged and records it. */
  export interface Step extends StepMeta {
    <A, E, R>(
      work: Effect.Effect<A, E, R>,
      place?: StepCall,
    ): Effect.Effect<A, E, R | Run | Host | WorkflowEngine | WorkflowInstance>;
    readonly meta: StepMeta;
  }

  /** A Step, made where its work is written. */
  export function step(declared: StepDeclaration): Step;

  /** The path from here, once the Run knows which branch it takes. Never a precondition. */
  export function forecast(
    path: ReadonlyArray<Step>,
  ): Effect.Effect<void, never, Run | Host | WorkflowEngine | WorkflowInstance>;

  /** Records that the Step the work is in failed, for a Run that parks to be resumed. */
  export function stepFailed(why: string): Effect.Effect<void, never, Run | Host>;

  /** A schema that decodes an agent's Output without services of its own. */
  export type OutputContract = Schema.Codec<unknown, unknown, never, never>;

  /** One piece of agent work, named so that replaying it finds what it already did. */
  export interface AgentAsk {
    readonly runId: string;
    readonly operation: string;
    readonly role: string;
    /** The agent this work goes to; null gives this operation one of its own. */
    readonly agent: string | null;
    readonly workflow: string;
    /** The Run's Task, whose workspace its agents open in; null opens where the host is. */
    readonly task: string | null;
    /** The Run's own workspace, where it asked for one; its agents open there instead. */
    readonly workspace?: string | null;
    readonly cwd: string;
    readonly prompt: string;
    readonly output: string;
    /** A skill this work is started with, as the human channel invokes one. */
    readonly skill: string | null;
    readonly harness: string | null;
    readonly model: string | null;
    readonly effort: string | null;
    readonly claudeSubagents?: ClaudeSubagents;
    readonly permissions: string | null;
  }

  /** The agent this work is on, as the launch recorded it. */
  export interface Launched {
    readonly agent: string;
    readonly output: string;
    readonly reused: boolean;
    readonly runId: string;
    readonly operation: string;
    readonly role: string;
    readonly workflow: string;
    readonly harness: string;
    readonly terminalId?: string;
  }

  /** Nobody can say whether the agent is there, so nothing was started. */
  export class AgentUncertain extends Schema.TaggedError<AgentUncertain>()(
    "AgentUncertain",
    { operation: Schema.String, reason: Schema.String },
  ) {}

  /** The work cannot go on until something outside the Run changes; a resume picks it up. */
  export class AgentParked extends Schema.TaggedError<AgentParked>()(
    "AgentParked",
    { operation: Schema.String, reason: Schema.String },
  ) {}

  /** What a host lends a workflow that needs an agent. */
  export interface AgentsApi {
    readonly outputFor: (runId: string, operation: string) => string;
    /** Where each named skill is installed, for the mentions a prompt carries. */
    readonly skills: (
      names: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, string>>;
    /**
     * What an agent is told about asking for a decision its work does not cover: the
     * pane of whoever is live in that role in this lineage, and otherwise to decide and
     * record it under \`assumptions\` in its Output, which that Output's schema has to have.
     */
    readonly askRoute: (role: string, lineage: ReadonlyArray<string>) => Effect.Effect<string>;
    readonly launch: (ask: AgentAsk) => Effect.Effect<Launched, AgentUncertain | AgentParked>;
    /** This work's agent started again with its prompt, where it is gone and wrote nothing. */
    readonly revive: (
      ask: AgentAsk,
      unless?: string | null,
    ) => Effect.Effect<void, AgentUncertain | AgentParked>;
    /** A message to the live agent in this role of a Run this one came from; null for none. */
    readonly handOff: (options: {
      readonly runId: string;
      readonly role: string;
      readonly lineage: ReadonlyArray<string>;
      readonly text: string;
    }) => Effect.Effect<Steered | null, AgentParked>;
    /** Closes the panes of this run's live agents; \`left\` may still be running. */
    readonly halt: (
      runId: string,
    ) => Effect.Effect<{ readonly stopped: ReadonlyArray<string>; readonly left: ReadonlyArray<string> }>;
    readonly collect: (
      launched: Launched,
      unless?: string | null,
    ) => Effect.Effect<string | null, AgentUncertain>;
    readonly repair: (
      launched: Launched,
      problem: string,
      unusable: string,
    ) => Effect.Effect<boolean, AgentUncertain | AgentParked>;
    readonly steer: (options: {
      readonly runId: string;
      readonly text: string;
      readonly request: string;
      /** A role (builder, reviewer, planner), an agent or an operation; else the agent at work. */
      readonly to?: string;
      readonly operation?: string;
      /** One of the run's agents by name, which wins over operation. */
      readonly agent?: string;
      readonly mode?: DeliveryMode;
    }) => Effect.Effect<Steered>;
    readonly pollMs: number;
  }

  export type DeliveryMode = "boundary" | "now" | "interrupt";

  /** What became of one delivery; delivered is never "it was accepted for sending". */
  export interface Steered {
    readonly agent: string;
    readonly delivered: boolean;
    readonly detail: string;
    readonly queued?: boolean;
    /** Whether the agent was seen to take it, and how. */
    readonly observed?: boolean;
    readonly how?: string;
  }
  export const Agents: Context.Service<AgentsApi, AgentsApi>;
  export type Agents = AgentsApi;

  /** What you ask for: the work, not the steps it takes. */
  export type AgentWork<
    Output extends OutputContract,
    Input extends Readonly<Record<string, Schema.Json>> = never,
  > = Doing<Output> & Told<Input>;

  /**
   * What the agent is told: a template and the input it declares, or text of your own
   * with input for any "{{name}}" in it. An expression nothing fills is refused before an
   * agent starts.
   */
  export type Told<Input extends Readonly<Record<string, Schema.Json>>> =
    | { readonly instructions: Template<Input>; readonly input: Input }
    | { readonly instructions: string; readonly input?: Readonly<Record<string, Schema.Json>> };

  export interface Doing<Output extends OutputContract> {
    readonly operation: string;
    /** Where the agent works; the checkout the host placed the Run on where it is left out. */
    readonly cwd?: string;
    /** What the Output has to be. Left out, the agent answers in plain text. */
    readonly output?: Output;
    readonly role?: string;
    /** The agent this work goes to, where several operations are one agent's list. */
    readonly agent?: string;
    readonly workflow?: string;
    /** The skill this work is started with, where the work is one a skill describes. */
    readonly skill?: string;
    /** The agent pushes the branch: while its merge request auto-merges, the Run parks instead. */
    readonly pushes?: boolean;
    /**
     * The step's Clearance, typed on one line after its pointer: each entry one sentence
     * naming one action and its target, from facts Collie holds, never from an Output.
     */
    readonly clears?: ReadonlyArray<string>;
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly permissions?: "auto" | "bypass" | "harness";
    readonly claudeSubagents?: ClaudeSubagents;
    /**
     * The panel seat this work sits at: its agent over the role's, and its persona and
     * instructions where it names them. Work for a role given none takes the agent of the
     * role's first seat, and keeps its own persona and instructions.
     */
    readonly seat?: Seat;
    /** What only the workflow knows of this work, for a hand-over to an agent taking it over. */
    readonly handOver?: HandOverGiven;
    /**
     * The agent whose work this continues, where \`agent\` has not yet run in this Run: it is
     * ended and found Quiet first, and \`agent\` is first handed the host's hand-over.
     */
    readonly takesOver?: { readonly agent: string; readonly why: string };
  }

  /** What an agent may say beside its Output for whoever takes its work over. */
  export const OutgoingFields: {
    readonly decisions: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly rejected: Schema.optionalKey<Schema.$Array<Schema.String>>;
    readonly next_action: Schema.optionalKey<Schema.String>;
  };
  export interface Outgoing {
    readonly decisions?: ReadonlyArray<string>;
    readonly rejected?: ReadonlyArray<string>;
    readonly next_action?: string;
  }

  /** What only the workflow knows of the work a hand-over is about. */
  export interface HandOverGiven {
    readonly ticket?: string;
    /** The plan directory, whose digest is the plan revision. */
    readonly plan?: string;
    /** The ticket's acceptance criteria, from its checkboxes. */
    readonly criteria?: ReadonlyArray<string>;
    /** The work's last decoded Output's answers to them. */
    readonly answers?: ReadonlyArray<{ readonly criterion: string; readonly met: string }>;
    readonly checks?: ReadonlyArray<string>;
    readonly findings?: ReadonlyArray<Finding>;
    /** The head the findings were reviewed at. */
    readonly reviewed?: string;
    /** The outgoing agent's last Output. */
    readonly said?: Outgoing;
  }

  /** A message handed to the live agent in this role of a Run this one came from, or null. */
  export function handOffWork(options: {
    readonly operation: string;
    readonly role: string;
    readonly text: string;
    readonly lineage?: ReadonlyArray<string>;
  }): Effect.Effect<
    string | null,
    WorkflowError,
    Run | Agents | Host | WorkflowEngine | WorkflowInstance
  >;

  /** One agent, once, and its Output as a value of your own type. */
  export function agentWork<
    Output extends OutputContract = typeof Schema.String,
    Input extends Readonly<Record<string, Schema.Json>> = never,
  >(
    work: AgentWork<Output, Input>,
  ): Effect.Effect<
    Output["Type"],
    WorkflowError,
    Run | Agents | Host | WorkflowEngine | WorkflowInstance
  >;

  /** Everything a prompt is built from, none of which is an Activity. */
  export interface PromptParts {
    readonly role: string;
    readonly instructions: string;
    readonly output: string;
    /** What the Output is drawn to; null asks for plain text. */
    readonly contract: Projection | null;
    readonly input?: Readonly<Record<string, unknown>>;
    /** Where each mentioned skill is installed; a mention of one that is not says so. */
    readonly skills?: ReadonlyMap<string, string>;
    readonly cwd?: string;
  }

  /** The ask an agent is sent, built from decoded values and your Markdown. */
  export function promptFor(parts: PromptParts): string;

  /** An agent's file as your own type, or every reason it could not be used. */
  export function decodeOutput<Output extends OutputContract>(
    contract: Output,
    text: string,
  ): { readonly ok: true; readonly value: Output["Type"] }
    | { readonly ok: false; readonly problem: string };

  export type Outcome =
    | "unspecified" | "feature" | "bug" | "refactor" | "investigation"
    | "docs" | "migration" | "review" | "plan" | "performance";

  export type OutcomeContract =
    | { readonly fixed: Outcome; readonly selectable?: undefined }
    | { readonly fixed?: undefined; readonly selectable: ReadonlyArray<Outcome> };

  /**
   * Where an offer's input comes from, as the Run it is offered about knows it. A closed
   * list: Collie fills these in, and anything else is the caller's to give.
   */
  export type Source =
    | "run-id"
    | "run-dir"
    | "plan-dir"
    | "diff-target"
    | "branch"
    | "merge-request"
    | "started-with"
    | "findings"
    | "finding";

  export interface FollowUp {
    readonly entry?: (facts: ActionFacts) => string;
    readonly connections?: ReadonlyArray<ConnectionId>;
    readonly id: string;
    readonly title: string;
    /** A public workflow id, or "self" for the one declaring it. */
    readonly workflow: string;
    readonly when: "succeeded" | "failed" | "always";
    /** What Collie fills in from the Run itself; the rest is the caller's to give. */
    readonly inputs?: Readonly<Record<string, Source>>;
    /** How many findings the offer takes, where its input is a selection. */
    readonly selects?: "many" | "one";
    /** A further condition on the facts, where how it ended is not the whole of it. */
    readonly eligible?: (facts: ActionFacts) => boolean;
    readonly given?: OfferGiven;
    readonly ships?: Ships;
    readonly confirm?: string;
  }

  /** Inputs an offer always starts its workflow with; never asked for, and never the caller's. */
  export type OfferGiven = Readonly<Record<string, Schema.Json>>;
  /** What taking an offer ships: \`merge\` only merges, \`release\` also tags and deploys. */
  export type Ships = "merge" | "release";

  /** What an action decides eligibility from: facts, never a workflow's name. */
  export interface ActionFacts {
    readonly review?: { readonly head: string; readonly reviewed: string; readonly owned: boolean };
    readonly recovery?: Recovery;
    readonly outcome: Outcome;
    readonly succeeded: boolean;
    readonly branch: string | null;
    readonly mrUrl: string | null;
    /** It completed with no change to land, so there is nothing to carry on from. */
    readonly nothingToLand?: boolean;
    readonly planIssues: number;
    readonly disposed: boolean;
    /** Findings it left for somebody to fix, which is what a fix is offered over. */
    readonly openFindings: number;
    /** What it was pointed at, where it was pointed at anything. */
    readonly diffTarget: string | null;
    /** The shared claims it still holds, by the projects claimed; null where it holds none. */
    readonly claim: string | null;
  }

  export interface ActionProvider {
    readonly connections?: ReadonlyArray<ConnectionId>;
    readonly id: string;
    readonly title: string;
    /** A public workflow id, or "self" for the one declaring it. */
    readonly workflow: string;
    readonly arguments: Schema.Struct.Fields;
    readonly eligible: (facts: ActionFacts) => boolean;
    /** What Collie fills in from the Run itself; the rest is the caller's to give. */
    readonly inputs?: Readonly<Record<string, Source>>;
    /** How many findings the offer takes, where its input is a selection. */
    readonly selects?: "many" | "one";
    readonly given?: OfferGiven;
    readonly ships?: Ships;
    /** What taking it does, which a front door shows and asks about before taking it. */
    readonly confirm?: string;
  }

  /** Names the host supplies at launch; an input of one of these is refused. */
  export const RESERVED_INPUTS: Readonly<Record<string, string>>;
  export const EXCLUSIVE_STRATEGIES: ReadonlyArray<string>;

  export interface Finding {
    id?: string;
    status?: "open" | "fixed" | "disputed" | "obsolete";
    head?: string;
    note?: string;
    file?: string;
    line?: number;
    severity: string;
    title: string;
    detail?: string;
    /** Whether the finding was seen or reasoned to. */
    basis?: "fact" | "inference";
    /** What shows it, in the finder's own words. */
    evidence?: string;
    /** What the finder would do about it. */
    suggested?: "fix" | "ticket" | "investigate" | "plan" | "none";
    internal?: boolean;
    /** A reviewer's answer to the implementer's reason for disputing this finding. */
    rebuttal?: string;
    /** Why a synthesis dropped this finding; only a dropped entry carries one. */
    reason?: string;
  }

  /**
   * The one judgement a reviewer gives that nothing else can, named by the kind of result
   * the change was for. One applies and the rest do not, so all are optional.
   */
  export interface Judgement {
    scope_met?: boolean;
    behavior_preserved?: boolean;
    supported?: boolean;
    accurate?: boolean;
    compatible?: boolean;
    /** Beside \`behavior_preserved\`, for a performance change: the benchmark measures what it claims. */
    measurement_valid?: boolean;
  }

  export interface ReviewOutput extends Judgement {
    verdict: "clean" | "findings";
    findings: Finding[];
    disputed: Finding[];
  }

  export interface Fixed {
    file?: string;
    title: string;
    note?: string;
  }

  /** How one of a ticket's acceptance criteria is met: a test, a file, or "not met: <reason>". */
  export interface Criterion {
    readonly criterion: string;
    readonly met: string;
  }

  /** The newest answer to this criterion's whole wording; a copy without its formatting counts. */
  export function answerFor(
    criterion: string,
    answers: ReadonlyArray<Criterion>,
  ): Criterion | undefined;

  /** Each criterion whose newest answer says only CI, a merge or a deploy can show it. */
  export function afterMergeAnswers(
    criteria: ReadonlyArray<string>,
    answers: ReadonlyArray<Criterion>,
  ): Criterion[];

  /**
   * Each criterion of the ticket the builder's answers leave unanswered or say is not met,
   * as a blocking finding against the ticket.
   */
  export function unmetCriteria(
    ticket: string,
    criteria: ReadonlyArray<string>,
    answers: ReadonlyArray<Criterion>,
  ): Finding[];

  export interface Synthesis extends ReviewOutput {
    summary: string;
    public_summary?: string;
    dropped: Finding[];
    fixed: Fixed[];
  }

  /** One check the implementer says it ran. Whether it passed is read from the journal. */
  export interface Check {
    name: string;
    note?: string;
  }

  export interface FixOutput {
    verdict: "clean" | "findings";
    findings: Finding[];
    fixed: Fixed[];
    disputed: Finding[];
    checks: Check[];
  }

  export type Halt =
    | "no_progress"
    | "dispute_unresolved"
    | "fix_unverified"
    | "definition_changed"
    | "evidence_missing";

  /** What a review left for the implementer, and what is the human's call instead. */
  export interface Split {
    live: Finding[];
    settled: Finding[];
    rebutted: Finding[];
  }

  /** Where a review/fix rally goes after one review. */
  export type Rally =
    | { readonly go: "clean"; readonly remaining: Finding[] }
    | {
        readonly go: "fix";
        readonly live: Finding[];
        readonly blocking: Finding[];
        readonly keys: ReadonlyArray<string>;
      }
    | {
        readonly go: "halt";
        readonly halt: Halt;
        readonly reason: string;
        readonly outstanding: Finding[];
      };

  export type FinalFix =
    | { ok: true; attestation: string; outstanding: Finding[] }
    | {
        ok: false;
        halt: "dispute_unresolved";
        attestation: string;
        reasons: string[];
        outstanding: Finding[];
      }
    | { ok: false; halt: "fix_unverified"; reasons: string[]; outstanding: Finding[] };

  /** Minor is the one severity not worth blocking on; anything else fails closed. */
  export function isBlocking(finding: Finding): boolean;
  export function findingKey(finding: Pick<Finding, "file" | "title">): string;
  export function sameFinding(left: Finding, right: Finding): boolean;
  /** One finding is another's by the id both give, or by the place and title they share. */
  export function isSameFinding(earlier: Finding, finding: Finding): boolean;
  export function blockingKeys(findings: ReadonlyArray<Finding>): string[];
  /** Whether a blocking finding says where and why, so it can be acted on. */
  export function substantiated(finding: Finding): boolean;
  export function unsubstantiated(findings: ReadonlyArray<Finding>): string | null;
  /** Disputes the review has neither confirmed fixed nor withdrawn with a reason. */
  export function remainingDisputes(
    disputed: ReadonlyArray<Finding>,
    review: {
      readonly findings: ReadonlyArray<Finding>;
      readonly disputed: ReadonlyArray<Finding>;
      readonly dropped: ReadonlyArray<Finding>;
      readonly fixed: ReadonlyArray<Fixed>;
    },
  ): Finding[];
  /** One line per finding a review both raises open and resolves. */
  export function conflictingDispositions(review: {
    readonly findings: ReadonlyArray<Finding>;
    readonly disputed: ReadonlyArray<Finding>;
    readonly dropped: ReadonlyArray<Finding>;
    readonly fixed: ReadonlyArray<Fixed>;
  }): string[];
  /** A finding the implementer already rejected stops driving the loop. */
  export function splitDisputed(
    findings: ReadonlyArray<Finding>,
    disputed: ReadonlyArray<Finding>,
  ): Split;
  /** Where one round goes next: another fix, clean, or the human's call. */
  export function settleRound(round: {
    readonly live: ReadonlyArray<Finding>;
    readonly disputed: ReadonlyArray<Finding>;
    readonly reopened?: ReadonlyArray<Finding>;
    readonly at: number;
    readonly seen?: { readonly at: number; readonly keys: ReadonlyArray<string> } | null;
  }): Rally;
  /** The last fix has no review after it, so its own account and the journal decide. */
  /** A fix report as a reader takes one; a decoded Output is one without being copied. */
  export interface FixReport {
    readonly verdict: "clean" | "findings";
    readonly findings: ReadonlyArray<Finding>;
    readonly fixed: ReadonlyArray<Fixed>;
    readonly disputed: ReadonlyArray<Finding>;
    readonly checks: ReadonlyArray<Check>;
  }
  export function settleFinalFix(
    live: ReadonlyArray<Finding>,
    fix: FixReport,
    evidence: CheckEvidence,
  ): FinalFix;
  export function renderReview(synthesis: SynthesisReport): string;
  export function renderPublicReview(synthesis: SynthesisReport): string;
  export function formatFindings(findings: ReadonlyArray<Finding>): string;
  /** Where the report a findings-kind source's findings were written is: review.md, investigation.md, or findings.json. */
  export function reportIn(dir: string): Effect.Effect<string>;
  /** Whether a finding's status still asks somebody to build it. */
  export function isOpenFinding(status: string): boolean;
  export function buildable(
    findings: ReadonlyArray<Finding>,
    statuses: ReadonlyArray<{
      readonly id: string;
      readonly status: string;
      readonly run: string | null;
    }>,
    by: string,
  ): ReadonlyArray<Finding>;

  /** The prose a human reads, and the findings a card counts, where both are looked for. */
  export const REVIEW_FILE: string;
  export const FINDINGS_FILE: string;
  /**
   * The one place a Run's findings are left: the ids already given are kept, and every
   * other finding takes the next free \`<run>-F<n>\`, never one a removed finding had.
   */
  export function leaveFindings(
    dir: string,
    findings: ReadonlyArray<Finding>,
    ledger?: ReadonlyArray<Finding>,
    report?: string,
  ): Effect.Effect<ReadonlyArray<Finding>, never, FileSystem.FileSystem>;
  export function leaveReview(
    dir: string,
    synthesis: SynthesisReport,
    ledger?: ReadonlyArray<Finding>,
  ): Effect.Effect<ReadonlyArray<Finding>, never, FileSystem.FileSystem>;

  /** The findings still standing after a last fix settleFinalFix accepted; the prose stays. */
  export function leaveOutstanding(
    dir: string,
    outstanding: ReadonlyArray<Finding>,
  ): Effect.Effect<ReadonlyArray<Finding>, never, FileSystem.FileSystem>;

  /** The findings of the review the Run that owns this directory left, or none. */
  export function findingsIn(
    dir: string,
  ): Effect.Effect<ReadonlyArray<Finding>, never, FileSystem.FileSystem>;

  /** How many findings the Run that owns this directory left for somebody to fix. */
  export function openFindingsIn(
    dir: string,
  ): Effect.Effect<number, never, FileSystem.FileSystem>;

  /** The extra axes a human asked for, as a paragraph, or nothing where they asked for none. */
  export function riskLine(risks: string): string;

  /** A merge request a target names: its project, where it carries one, and its iid. */
  export interface MrRef {
    readonly project: string | null;
    readonly iid: string;
  }
  export function parseMrTarget(target: string): MrRef | null;
  /** Any way a merge request is named: an \`mr:\` target, its URL, or GitHub's \`owner/repo#30\`. */
  export function readMrRef(text: string): MrRef | null;
  /** Where a merge request is read in a browser, where its reference says which project. */
  export function mrUrlOf(ref: MrRef): string | null;
  /** \`group/app!345\` or \`owner/repo#30\` rather than the whole URL. */
  export function mrLabel(mr: string): string;
  /** The forge a merge request is on. */
  export function forgeOfRef(ref: MrRef): "gitlab" | "github";
  /** The merge requests a set names, each once by MR id, or the first reference naming none; null for one or none. */
  export function mrSet(text: string):
    | { readonly mrs: ReadonlyArray<{ readonly id: string; readonly target: string; readonly url: string }> }
    | { readonly unresolved: string }
    | null;

  /** Which of the three kinds of change a settled diff target names. */
  export function targetKind(target: string): "mr" | "branch" | "worktree" | "";

  /** The glab arguments that point a command at a project rather than at the cwd. */
  export function repoArgs(project: string | null): string[];

  /**
   * An \`mr:\` target's forge as a prompt says it — its name and noun, and the commands that
   * read the change and its description and check it out — or null for any other target.
   */
  export function mrForgeFacts(target: string): {
    readonly forge: string;
    readonly noun: string;
    readonly diff: string;
    readonly view: string;
    readonly checkout: string;
  } | null;

  /** A decoded review: the lists are the decoder's, not the reader's to change. */
  export interface ReviewReport extends Judgement {
    readonly verdict: "clean" | "findings";
    readonly findings: ReadonlyArray<Finding>;
    readonly disputed: ReadonlyArray<Finding>;
  }

  export interface SynthesisReport extends ReviewReport {
    readonly summary: string;
    readonly public_summary?: string;
    readonly dropped: ReadonlyArray<Finding>;
    readonly fixed: ReadonlyArray<Fixed>;
  }

  /**
   * The shapes the shipped steps write, shared so a step declares one contract. Each is
   * an ordinary schema: hand one to agentWork and what comes back is its own type.
   */
  export const FindingSchema: Schema.Codec<Finding, unknown, never, never>;
  export const FixedSchema: Schema.Codec<Fixed, unknown, never, never>;
  export const CriterionSchema: Schema.Codec<Criterion, unknown, never, never>;
  export const CheckSchema: Schema.Codec<Check, unknown, never, never>;
  export const ReviewOutputSchema: Schema.Codec<ReviewReport, unknown, never, never>;
  export function ReassessmentSchema(ids: ReadonlyArray<string>): Schema.Codec<{
    readonly findings: ReadonlyArray<{
      readonly id: string;
      readonly status: "open" | "fixed" | "disputed" | "obsolete";
      readonly reason: string;
    }>;
  }, unknown, never, never>;
  export const SynthesisSchema: Schema.Codec<SynthesisReport, unknown, never, never>;
  export const FixOutputSchema: Schema.Codec<FixReport & Outgoing, unknown, never, never>;
  export const MrOutputSchema: Schema.Codec<
    { readonly pushed: boolean; readonly mr_url?: string | null; readonly note?: string },
    unknown,
    never,
    never
  >;
  export const PlanOutputSchema: Schema.Codec<
    { readonly issues_dir: string; readonly spec?: string },
    unknown,
    never,
    never
  >;

  /**
   * Instructions whose "{{name}}" expressions read only the input it declares: template
   * refuses any other when it is made, and agentWork refuses one left unfilled before any
   * agent starts.
   */
  export class Template<Input> {
    declare readonly input: Input;
    constructor(text: string);
    readonly text: string;
  }

  /**
   * Instructions, and the input they take. What the text names and fields does not
   * declare is refused here — role, cwd and output_path are always given — so a template
   * made where a module loads is checked by every load of it, collie doctor and collie
   * workflow check among them.
   */
  export function template<const Fields extends Schema.Struct.Fields>(
    text: string,
    fields: Fields,
  ): Template<Schema.Struct<Fields>["Type"]>;

  /** What agents are told, read from Markdown. */
  export interface Content {
    readonly preamble: string;
    readonly sections: ReadonlyMap<string, string>;
    /** A section under the preamble; one the file does not have is refused, never sent empty. */
    readonly prompt: (section: string) => string;
    /** A section under the preamble, as a template of what it takes. */
    readonly template: <const Fields extends Schema.Struct.Fields>(
      section: string,
      fields: Fields,
    ) => Template<Schema.Struct<Fields>["Type"]>;
  }

  /**
   * A Markdown file as the content it is: what stands above the first heading, and one
   * entry per "## name" section below it. Front matter is refused: a workflow's inputs,
   * steps and questions are its definition's.
   */
  export function contentOf(markdown: string): Content;

  /** One item of work that finished, and what it left for the ones after it. */
  export interface Handed {
    readonly item: string;
    readonly title: string;
    readonly commits: ReadonlyArray<string>;
    /** What was verified while it ran, as "name: result". */
    readonly verifications?: ReadonlyArray<string>;
  }

  /** What the items before this one left behind: their work, commits and evidence. */
  export function renderProgress(done: ReadonlyArray<Handed>): string;

  /**
   * Why these identities cannot key a list of work, or null where they can: an identity
   * is a name of its own, and no two items may share one.
   */
  export function identityProblem(keys: ReadonlyArray<string>): string | null;

  /** One ticket of a plan: where it is, what it is called, what it waits for. */
  export interface Slice {
    readonly file: string;
    readonly number: string;
    readonly title: string;
    readonly blockedBy: ReadonlyArray<string>;
    /** The verification names its **Checks:** line promised will prove it. */
    readonly checks: ReadonlyArray<string>;
    /** Its acceptance criteria, which the builder answers one by one. */
    readonly criteria: ReadonlyArray<string>;
    /** The benchmark plan its speed-up criterion is measured by, as benchmarkIn reads it. */
    readonly benchmark: string | null;
    readonly prerequisites: ReadonlyArray<Prerequisite>;
  }

  /** Another Run's Change a ticket needs merged first; change is null for that Run's default Change. */
  export interface Prerequisite {
    readonly run: string;
    readonly change: string | null;
  }

  /** The verification names a ticket's **Checks:** line promises. */
  export function checksIn(text: string): string[];

  /** The benchmark plan a ticket's **Benchmark:** line names, beside the ticket; null where it names none. */
  export function benchmarkIn(text: string): string | null;

  /** Where a ticket's benchmark plan is: in the plan's issues/, beside the ticket. */
  export function benchmarkFile(planDir: string, benchmark: string): string;

  /**
   * Why a ticket's benchmark plan is not one collie measure takes, naming the ticket and the
   * file; null where every ticket's is, or none names one.
   */
  export function benchmarkRefusalOf(
    planDir: string,
  ): Effect.Effect<string | null, never, FileSystem.FileSystem | Path.Path>;

  /**
   * A ticket's acceptance criteria: each checkbox item with its wrapped lines, under its
   * Acceptance criteria heading where it has one, and never under ## After merge. A nested
   * list and fenced code are not.
   */
  export function criteriaIn(text: string): string[];

  /** What only CI, a merge or a deploy can show: the items under a ticket's ## After merge. */
  export function afterMergeIn(text: string): string[];

  /** A plan's tickets in an order they can be built in, narrowed to one repository's Change. */
  export function orderedTickets(
    tickets: ReadonlyArray<{ readonly file: string; readonly text: string }>,
    repo?: string,
    change?: string,
  ): Slice[];

  /** The same reading, against a plan directory on disk. */
  export function orderedTicketsOf(
    planDir: string,
    repo?: string,
    change?: string,
  ): Effect.Effect<Slice[], never, FileSystem.FileSystem | Path.Path>;

  /** One Change of a plan: its repository, its name, and its tickets in plan order. */
  export interface PlanRepo {
    readonly path: string;
    /** Absent for the repository's default Change. */
    readonly change?: string;
    /** The key of the Change in the same repository this one is cut from. */
    readonly stacked?: string;
    readonly tickets: ReadonlyArray<string>;
  }

  /**
   * The branch a stacked Change run builds on and opens its merge request against, named
   * from its own branch; null where its own is not the one its Change is given.
   */
  export function stackedBranch(
    own: string,
    run: { readonly repo: string; readonly change?: string; readonly stacked: string },
  ): string | null;

  /** How a Change is named in waves, refusals and invocations: api, or api--schema. */
  export function changeKey(one: { readonly path: string; readonly change?: string | undefined }): string;

  /** Why this plan cannot be fanned out. The message is what the human is shown. */
  export interface PlanRefusal {
    readonly kind:
      | "cycle"
      | "missing-repo"
      | "missing-checkout"
      | "outside-root"
      | "unknown-blocker"
      | "duplicate-ticket"
      | "bad-change"
      | "bad-prerequisite";
    readonly message: string;
  }

  export interface PlanRepos {
    readonly repos: ReadonlyArray<PlanRepo>;
    /** Change keys in the order their runs may start; each wave waits on the one before. */
    readonly waves: ReadonlyArray<ReadonlyArray<string>>;
    readonly refusal: PlanRefusal | null;
  }

  /** What a fan-out would do with a plan: its repositories, its waves, or its refusal. */
  export function readPlanRepos(
    tickets: ReadonlyArray<{ readonly file: string; readonly text: string }>,
    checkouts: ReadonlySet<string>,
  ): PlanRepos;

  /** The same reading, against a plan directory and the checkouts under a root. */
  export function planReposOf(
    planDir: string,
    root: string,
  ): Effect.Effect<PlanRepos, PlatformError, FileSystem.FileSystem | Path.Path>;

  /** Whether this plan is one repository and that repository is the run's own root. */
  export function isSingleRepo(plan: PlanRepos): boolean;

  /** This Run's checks as a human would type them, for a prompt to name them. */
  export function renderApproved(approved: ReadonlyArray<VerifySpec>): string;

  /** Text with every credential-shaped value replaced, before it is published. */
  export function redact(text: string): string;

  /** Recorded evidence for prompts, or repository commands and results for public text. */
  export function renderEvidence(got: {
    readonly verifications: ReadonlyArray<Verification>;
    readonly final: Snapshot;
    /** The latest \`final\` of these is named with its verdicts. */
    readonly measurements?: ReadonlyArray<Measurement>;
  }, audience?: "internal" | "public"): string;

  /** Where a reference a Run's Outputs give may point: its own directory, its checkout, and a planning Run's. */
  export function evidenceRoots(own: string, cwd: string, workSource: string): string[];

  /**
   * Every check this Run's journal holds, latest of each and its baseline, for a reviewer to
   * read; then each check left to CI, with its job's state where the Run has a merge request.
   */
  export function renderRecordedChecks(
    got: { readonly verifications: ReadonlyArray<Verification>; readonly final: Snapshot },
    leftToCi?: ReadonlyArray<{
      readonly name: string;
      readonly job: string;
      readonly state: string | null;
    }>,
  ): string;

  /**
   * Everything still missing before this Run may say it proved its kind of result, one
   * sentence each. Empty means the evidence is there. An Output is a claim whatever it
   * says; what decides a check is the journal, on the tree in front of it.
   */
  /** Whether this is one of the kinds of result a Run can be for. */
  export function isOutcome(value: string): value is Outcome;

  export function evidenceGapsOf(options: {
    readonly kind: Outcome;
    readonly evidence: CheckEvidence;
    readonly approved: ReadonlyArray<VerifySpec>;
    /** What each piece of work reported, by the name it was done under. */
    readonly outputs: Readonly<Record<string, unknown>>;
    /** Which of those are a reviewer's judgement rather than the implementer's claim. */
    readonly reviewed: ReadonlyArray<string>;
    /** The tree each of those reviewed. A \`performance\` verdict counts only from a review of the tree in front of it. */
    readonly reviewedOn?: Readonly<Record<string, Snapshot>>;
    /** The directories this Run owns, which a reference it gives has to point inside. */
    readonly roots: ReadonlyArray<string>;
    readonly tickets: ReadonlyArray<{
      readonly file: string;
      readonly checks: ReadonlyArray<string>;
    }>;
  }): ReadonlyArray<string>;
  /**
   * The gaps among those a verification on this tree could close: what a fix may be
   * handed. A reviewer's judgement and an Output's claim are not moved by running anything.
   */
  export function checkGapsOf(
    options: Parameters<typeof evidenceGapsOf>[0],
  ): ReadonlyArray<string>;
  /** The gaps among those a fresh review could close: what is worth paying a reviewer for. */
  export function reviewGapsOf(
    options: Parameters<typeof evidenceGapsOf>[0],
  ): ReadonlyArray<string>;
  /**
   * Whether the Run is done with no patch to deliver, which is an outcome and not a failure:
   * an investigation that says so, or a performance Run whose tree is its latest base tree again.
   */
  export function endsWithoutPatchOf(options: Parameters<typeof evidenceGapsOf>[0]): boolean;

  /**
   * A Check's proof on this tree: passed, failed, unstable, earlier (its latest record is on an
   * earlier tree and no failure there, so it owes a pass here), or never run; for a check left
   * to CI, waiting on its job or proved by it.
   */
  export interface CheckProof {
    readonly state: "passed" | "failed" | "unstable" | "earlier" | "never" | "waiting" | "proved";
    /** Every run of the Check's own command, oldest first. */
    readonly runs: ReadonlyArray<Verification>;
    /** The latest of them on this tree. */
    readonly last: Verification | undefined;
  }
  /** Whose records count, by name, for a Check whose command is not given. */
  export type Unmatched = "anyone" | "collie";
  export function checkProof(
    got: CheckEvidence & { readonly approved?: ReadonlyArray<VerifySpec> },
    name: string,
    unmatched?: Unmatched,
  ): CheckProof;
  /** The Checks a Run runs itself: all but those left to CI. */
  export function owedLocally<C extends { readonly name: string; readonly ci?: string }>(
    checks: ReadonlyArray<C>,
  ): ReadonlyArray<C>;

  /** The fingerprint of a tree too large to measure: two of them are not the same tree. */
  export const TOO_LARGE: "unstable:too-large";
  /** Whether two snapshots are the same bytes, whatever commit each was on. A tree too large to look at is never the same as another. */
  export function sameTree(
    one: { readonly fingerprint: string },
    other: { readonly fingerprint: string },
  ): boolean;

  /** A Run's checks read against its journal, for which tests failed and how each rerun went. */
  type FailedChecks = CheckEvidence & { readonly approved: ReadonlyArray<VerifySpec> };
  /** Each failed test of a check's latest run on this tree that has not been run again alone yet. */
  export function rerunsOwed(
    got: FailedChecks,
  ): Array<{ readonly check: string; readonly test: FailedTest }>;
  /** The checks whose latest run on this tree failed without naming its tests, or that have none of their command. */
  export function wholeRunsOwed(got: FailedChecks): string[];
  /** Of those, the ones with no recheck of their command on this tree yet. */
  export function recheckOwed(got: FailedChecks): string[];
  /** Each Flake on this tree, by the check it failed in: never a pass. */
  export function flakesOf(got: FailedChecks): Array<FailedTest & { readonly check: string }>;
  /** Each test still failing after its rerun that the base has not been asked about since. */
  export function baselinesOwed(
    got: FailedChecks,
  ): Array<{ readonly check: string; readonly test: FailedTest }>;
  /** Each still-failing test that also fails where the branch leaves the default branch, at that revision. */
  export function baseFailuresOf(
    got: FailedChecks,
  ): Array<FailedTest & { readonly check: string; readonly at: string }>;
  /** The checks settled without a pass: every test each failed on was a Flake or fails at the base too. */
  export function settledChecks(got: FailedChecks): string[];

  /** Where the work to be done was described. */
  export interface WorkSource {
    readonly kind: "plan-dir" | "linear" | "text" | "review" | "followup" | "mr" | "branch" | "worktree";
    readonly value: string;
    readonly source: string;
    readonly label?: string;
  }

  /** What a work source turned out to be: a plan, a review, an issue, a follow-up, text. */
  export function classifyWorkSource(
    typed: string,
  ): Effect.Effect<WorkSource, unknown, FileSystem.FileSystem | Path.Path>;

  /** The JSON Schema for a prompt, and what the drawing does not say. */
  export interface Projection {
    readonly document: unknown;
    readonly limits: ReadonlyArray<string>;
  }
  export function jsonSchemaFor(schema: Schema.Top): Projection;
}

declare module "*.md" {
  const text: string;
  export default text;
}
`;

let sdkInstalled = false;

// WARNING: `self` is the offering workflow even after a fork renames it.
const itself = (workflow: string) => (workflow === "self" ? SELF : workflow);

export function declaredByModule(metadata: WorkflowMetadata | undefined) {
  const actions = Arr.map(metadata?.actions ?? [], (action) => ({
    id: action.id,
    title: action.title,
    workflow: itself(action.workflow),
    arguments: jsonSchemaFor(Schema.Struct(action.arguments)).document,
    kind: "action" as const,
    inputs: action.inputs ?? {},
    selects: action.selects,
    given: action.given,
    ships: action.ships,
    confirm: action.confirm,
    connections: action.connections,
    eligible: action.eligible,
  }));
  const followUps = Arr.map(metadata?.followUps ?? [], (offer) => ({
    id: offer.id,
    title: offer.title,
    workflow: itself(offer.workflow),
    arguments: null,
    kind: "follow-up" as const,
    entry: offer.entry,
    inputs: offer.inputs ?? {},
    given: offer.given,
    selects: offer.selects,
    ships: offer.ships,
    confirm: offer.confirm,
    connections: offer.connections,
    eligible: (facts: ActionFacts) =>
      (offer.when === "always" || (offer.when === "succeeded") === facts.succeeded) &&
      (offer.eligible?.(facts) ?? true),
  }));
  const returned: Array<Declared> = [...actions, ...followUps];
  return returned;
}

export function installSdk() {
  if (sdkInstalled) {
    return;
  }
  sdkInstalled = true;
  Bun.plugin({
    name: "collie-sdk",
    setup(build) {
      for (const [specifier, namespace] of sdkModules()) {
        // WARNING: spread so the values stay the binary's own; the loader takes a plain object.
        build.module(specifier, () => ({ exports: { ...namespace }, loader: "object" }));
      }
      for (const [specifier, reason] of REMOVED) {
        build.module(specifier, () => {
          throw new Error(reason);
        });
      }
    },
  });
}

// WARNING: importing runs the author's top-level code; nothing here is a sandbox.
export const loadEntry: (
  file: string,
  revision?: string,
) => Effect.Effect<WorkflowEntry, EntryError, FileSystem.FileSystem> = Effect.fn(
  "Engine.loadEntry",
)(function* (file: string, revision?: string) {
  // WARNING: Bun's module registry never invalidates; each read must be of a fresh staged copy.
  const staged = yield* stagedEntry(file, revision);
  return yield* readStagedEntry(file, staged);
});

const readStagedEntry = Effect.fn("Engine.readStagedEntry")(function* (
  file: string,
  staged: { readonly file: string; readonly root: string },
) {
  installSdk();
  const loaded = yield* Effect.tryPromise({
    try: () => import(staged.file),
    catch: (cause) =>
      new EntryError({ file, message: pipe(String(cause), Str.replaceAll(staged.root, "")) }),
  });
  const read = readDefinition(loaded.default);
  if (read._tag === "Failure" || !isWritten(loaded.default)) {
    return yield* new EntryError({
      file,
      message:
        loaded.default === undefined
          ? "a workflow module exports its definition by default: export default defineWorkflow({ ... })"
          : `the default export is not a workflow definition: ${read._tag === "Failure" ? read.failure.message : ""}`,
    });
  }
  const entry = entryOf(definitionOf(loaded.default));
  const problems = checkEntry(entry);
  if (problems.length > 0) {
    return yield* new EntryError({ file, message: Arr.join(problems, "; ") });
  }
  return entry;
});

const IsSchema = Schema.declare(Schema.isSchema);

const DefinitionContract = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.declare((u) => Schema.isSchema(u) && "fields" in u)),
  output: Schema.optionalKey(IsSchema),
  error: Schema.optionalKey(IsSchema),
  layer: Schema.optionalKey(Schema.declare(Layer.isLayer)),
  run: Schema.declare(Predicate.isFunction),
});
const readDefinition = Schema.decodeUnknownResult(DefinitionContract, { errors: "all" });

const isWritten = (exported: unknown): exported is WrittenDefinition =>
  Schema.is(DefinitionContract)(exported);

const entryOf: (definition: WorkflowDefinition) => WorkflowEntry = (definition) => {
  const { outcome, checkout, closes, heals, followUps, actions, connections, follows } = definition;
  const path = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(definition.path), (present) =>
      Arr.map(present, (one) => one.meta),
    ),
  );
  const hints =
    definition.hints === undefined
      ? undefined
      : Rec.fromEntries(
          Arr.map(
            Rec.toEntries(definition.hints),
            ([name, hint]) => [name, strategyNamed(hint)] as const,
          ),
        );
  const declared = Rec.fromEntries(
    Arr.filter(
      Rec.toEntries({
        hints,
        outcome,
        checkout,
        closes,
        heals,
        followUps,
        actions,
        path,
        connections,
        follows,
      }),
      ([, value]) => value !== undefined,
    ),
  );
  // WARNING: checkEntry refuses an input field that is not a schema before anything settles one.
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    input: definition.input.fields,
    metadata: declared,
    agents: definition.agents,
    make: (name) => registrationOf(definition, name),
  };
};

const WorkflowHints = Context.Reference<Readonly<Record<string, InputStrategy>>>(
  "collie/WorkflowHints",
  { defaultValue: () => ({}) },
);

const readEnvelope = flow(
  Schema.decodeUnknownResult(Schema.Struct({ runId: Schema.String })),
  Result.getOrThrow,
);

const noteStep = (dir: string, note: StepNote) =>
  Effect.gen(function* () {
    yield* appendStepLine(dir, { ...note, at: yield* nowIso });
  });

const entryCauses = new Map<string, "restarted" | "resumed">();

const heldAtEntry = new Map<string, Deferred.Deferred<void>>();

const releaseEntry = (runId: string) =>
  Effect.suspend(() => {
    const hold = heldAtEntry.get(runId);
    heldAtEntry.delete(runId);
    return hold === undefined ? Effect.succeed(false) : Deferred.succeed(hold, undefined);
  });

// WARNING: upstream resume gives no wake acknowledgment, so entries are observed here.
const entriesOf = new WeakMap<HostWorkflow, Map<string, number>>();

const waitForEntry = (workflow: HostWorkflow, runId: string, before: number) =>
  Effect.suspend(() =>
    (entriesOf.get(workflow)?.get(runId) ?? 0) > before ? Effect.succeed(true) : Effect.fail(false),
  ).pipe(
    Effect.retry({ times: WAKE_TRIES, schedule: Schedule.spaced(WAKE_INTERVAL) }),
    Effect.orElseSucceed(() => false),
  );

const registrationOf: (definition: WorkflowDefinition, name: string) => Registration = (
  definition,
  name,
) => {
  // WARNING: every workflow is executed with this envelope, and its input is the definition's own struct, whose fields checkEntry has held to be schemas.
  const payload = Schema.Struct({ runId: Schema.String, input: definition.input }) as HostPayload;
  const error: HostCodec =
    definition.error === undefined
      ? WorkflowError
      : Schema.Union([WorkflowError, definition.error]);
  const workflow: HostWorkflow = Workflow.make(name, {
    payload,
    idempotencyKey: (envelope) => readEnvelope(envelope).runId,
    success: definition.output,
    error,
  });
  const entries = new Map<string, number>();
  entriesOf.set(workflow, entries);
  const path =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(definition.path), (present_) =>
        Arr.map(present_, (one) => one.meta),
      ),
    ) ?? [];
  const enter = (envelope: Schema.Schema.Type<HostPayload>) => {
    // WARNING: the envelope decoded against the definition's own input struct.
    const input = envelope.input as never;
    const run = Run.of({ id: readEnvelope(envelope).runId, workflow: definition.id });
    const before = entries.get(run.id) ?? 0;
    entries.set(run.id, before + 1);
    // WARNING: a first entry by this host into work an earlier host entered resumes it; it restarts only where none did.
    const cause = entryCauses.get(run.id) ?? (before === 0 ? "restarted" : null);
    entryCauses.delete(run.id);
    const entered = Effect.gen(function* () {
      const host = yield* Host;
      yield* host.step(run.id, { kind: "entry", cause });
      if (path.length > 0) {
        yield* Activity.make({
          name: "path",
          execute: host.step(run.id, { kind: "forecast", steps: path }),
        });
      }
    });
    return entered.pipe(
      Effect.andThen(
        // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded author error schemas are erased; the workflow's codec retains their actual values.
        definition.run({ input }),
      ),
      Effect.provideService(Run, run),
      Effect.provideService(WorkflowAgents, definition.agents),
      Effect.provideService(WorkflowHints, definition.hints ?? {}),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : ended(run.id, exitStatus(exit, definition.id, workflow.successSchema, error)),
      ),
    );
  };
  const body = workflow.toLayer((envelope) => {
    const hold = heldAtEntry.get(readEnvelope(envelope).runId);
    return hold === undefined
      ? // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded author error schemas are erased; the workflow's codec retains their actual values.
        enter(envelope)
      : // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- The same erased author error, entered once the hold is released.
        Deferred.await(hold).pipe(Effect.andThen(Effect.suspend(() => enter(envelope))));
  });
  const layer = definition.layer === undefined ? body : body.pipe(Layer.provide(definition.layer));
  return { workflow, layer };
};

const RECOVERY_PARENT = "recovery-parent";

const TERMINAL = "terminal.json";

const ended = (runId: string, status: typeof RunStatus.Type) =>
  Effect.gen(function* () {
    if (status.status === "complete" || status.status === "failed") {
      // WARNING: the host runs every Run with its records; a module's own Layer cannot ask for them.
      const records = yield* Effect.serviceOption(RunRecords);
      if (Option.isNone(records)) {
        return yield* Effect.die(`${runId} ended with no records to keep it`);
      }
      yield* records.value.put(runId, TERMINAL, asJsonText(status));
      // WARNING: findings.json can change until the Run ends, so the count is kept again here.
      const host = yield* Effect.serviceOption(Host);
      if (Option.isSome(host)) {
        yield* storeOpenCount(runDir(host.value.dir, runId)).pipe(
          Effect.provideService(RunRecords, records.value),
          Effect.orElseSucceed(() => 0),
        );
      }
      // WARNING: requests its agents made after their last delivery are read nowhere else.
      const agents = yield* Effect.serviceOption(Agents);
      if (Option.isSome(agents)) {
        const store = yield* Effect.serviceOption(Store);
        const row = Option.isSome(store)
          ? yield* store.value.run(runId).pipe(Effect.orElseSucceed(() => null))
          : null;
        const placing = Option.getOrUndefined(decodePlacing(row?.placing ?? ""));
        yield* agents.value.account(runId, placing?.heals !== undefined);
      }
    }
    const oversight = yield* Effect.serviceOption(Oversight);
    if (Option.isSome(oversight)) {
      yield* oversight.value.finish(runId);
    }
    yield* told(runId, status);
  });

const told = (runId: string, status: typeof RunStatus.Type) =>
  Effect.serviceOption(Notifier).pipe(
    Effect.flatMap((found) => {
      if (Option.isNone(found)) {
        return Effect.void;
      }
      if (status.status === "complete") {
        return found.value.notify(
          runId,
          "run-done",
          isText(status.value) ? status.value : asJsonText(status.value),
        );
      }
      if (status.status !== "failed") {
        return Effect.void;
      }
      return found.value.notify(runId, "run-failed", status.reason);
    }),
  );

// WARNING: the cache is imported as code, so it is used only where nobody else can write.
const entriesRoot = Effect.fn("Engine.entriesRoot")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const cache = Bun.env.XDG_CACHE_HOME || `${Bun.env.HOME ?? Bun.env.TMPDIR ?? "/tmp"}/.cache`;
  const entries = `${cache}/collie/entries`;
  yield* fs.makeDirectory(entries, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  const info = yield* fs.stat(entries).pipe(Effect.option);
  const mine =
    Option.isSome(info) &&
    Option.getOrNull(info.value.uid) === (process.getuid?.() ?? null) &&
    (info.value.mode & 0o022) === 0;
  if (!mine) {
    return yield* new EntryError({
      file,
      message: `${entries} is writable by others or is not yours, so nothing is read from it: remove it, or make it yours with \`chmod 700\``,
    });
  }
  return entries;
});

// WARNING: stage under a temp name, then rename, so no process imports a copy another is still writing.
const stagedEntry = Effect.fn("Engine.stagedEntry")(function* (file: string, revision?: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* entriesRoot(file);
  const dir = directoryOf(file);
  const name = `${Bun.hash(dir).toString(16)}-${revision ?? (yield* revisionOf(dir))}`;
  const root = `${entries}/generations/${name}`;
  const staged = { root, file: `${root}${file}` };
  if (yield* fs.exists(staged.file).pipe(Effect.orElseSucceed(() => false))) {
    // WARNING: an entry's age is its last use, which cleanup removes entries by.
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* fs.utimes(root, now, now).pipe(Effect.ignore);
    return staged;
  }
  const draft = `${name}.${yield* Random.nextInt}`;
  yield* stageGeneration({ dir: entries, name: draft, entry: file }).pipe(
    Effect.provide(Path.layer),
  );
  const drafted = `${entries}/generations/${draft}`;
  yield* fs
    .rename(drafted, root)
    .pipe(Effect.catch(() => fs.remove(drafted, { recursive: true }).pipe(Effect.ignore)));
  return staged;
});

const unstaged = (name: string) =>
  name === "node_modules" || pipe(name, Str.startsWith(CHECK_PROJECT));
const CHECK_PROJECT = ".collie-check";

const sourcesIn = Effect.fn("Engine.sourcesIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const names: Array<string> = [];
  const top = yield* fs.readDirectory(dir).pipe(
    Effect.orElseSucceed(() => {
      const returned: Array<string> = [];
      return returned;
    }),
  );
  for (const name of top) {
    if (unstaged(name)) {
      continue;
    }
    names.push(name);
    const info = yield* fs.stat(`${dir}/${name}`).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") {
      continue;
    }
    const link = yield* fs.readLink(`${dir}/${name}`).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (link) {
      continue;
    }
    const below = yield* fs.readDirectory(`${dir}/${name}`, { recursive: true }).pipe(
      Effect.orElseSucceed(() => {
        const returned: Array<string> = [];
        return returned;
      }),
    );
    names.push(...Arr.map(below, (one) => `${name}/${one}`));
  }
  return names;
});

export const revisionOf: (dir: string) => Effect.Effect<string, never, FileSystem.FileSystem> =
  Effect.fn("Engine.revisionOf")(function* (dir: string) {
    return (yield* sourceTree(dir)).revision;
  });

const sourceTree = Effect.fn("Engine.sourceTree")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const contents = new Map<string, string>();
  const contentOf = (file: string) => {
    const cached = contents.get(file);
    return cached !== undefined
      ? Effect.succeed(cached)
      : fs.readFileString(file).pipe(
          Effect.orElseSucceed(() => ""),
          Effect.map((content) => {
            contents.set(file, content);
            return content;
          }),
        );
  };
  // WARNING: an installed dependency counts by names alone; reading the whole toolchain costs more than a start.
  const installed = yield* fs.readDirectory(`${dir}/node_modules`, { recursive: true }).pipe(
    Effect.orElseSucceed(() => {
      const returned: Array<string> = [];
      return returned;
    }),
  );
  let read = Arr.join(
    Arr.map(installed.sort(), (name) => `node_modules/${name}\n`),
    "",
  );
  const names = (yield* sourcesIn(dir)).sort();
  for (const name of names) {
    // WARNING: a directory reads as nothing; its contents are listed under their own names.
    const content = yield* contentOf(`${dir}/${name}`);
    read += `${name}:${Bun.hash(content).toString(16)}\n`;
  }
  const outside = yield* outsideOf(dir, contentOf, names);
  for (const file of outside) {
    const content = yield* contentOf(file);
    read += `${file}:${Bun.hash(content).toString(16)}\n`;
  }
  return { names, outside, revision: Bun.hash(read).toString(16) };
});

const outsideOf = Effect.fn("Engine.outsideOf")(function* (
  dir: string,
  contentOf?: (file: string) => Effect.Effect<string>,
  names?: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const pending = Arr.map(names ?? (yield* sourcesIn(dir)), (name) => `${dir}/${name}`);
  const outside = new Set<string>();
  const looked = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (let at = parentOf(file); !looked.has(at); at = parentOf(at)) {
      looked.add(at);
      if (at === dir || pipe(at, Str.startsWith(`${dir}/`))) {
        continue;
      }
      const manifest = `${at}/package.json`;
      if (yield* fs.exists(manifest).pipe(Effect.orElseSucceed(() => false))) {
        outside.add(manifest);
      }
    }
    const loader = loaderOf(file);
    if (loader === null) {
      continue;
    }
    const text = yield* (
      contentOf?.(file) ?? fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
    );
    for (const target of importedBy(file, text, loader)) {
      if (pipe(target, Str.startsWith(`${dir}/`)) || outside.has(target)) {
        continue;
      }
      outside.add(target);
      pending.push(target);
    }
  }
  return [...outside].sort();
});

const scanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
};

// WARNING: unparseable code imports nothing; an installed package is linked, never copied.
const importedBy = (file: string, text: string, loader: "ts" | "tsx" | "js") => {
  let imports: ReadonlyArray<{ readonly path: string }>;
  try {
    imports = scanners[loader].scanImports(text);
  } catch {
    return [];
  }
  return Arr.flatMap(imports, (one) => {
    if (!pipe(one.path, Str.startsWith(".")) && !pipe(one.path, Str.startsWith("#"))) {
      return [];
    }
    try {
      const target = Bun.resolveSync(one.path, directoryOf(file));
      return pipe(target, Str.includes("/node_modules/")) ? [] : [target];
    } catch {
      return [];
    }
  });
};

// WARNING: Bun's registry never invalidates, so each generation is a copy at fresh paths; a host wipes them on start.
export const stageGeneration: (options: {
  readonly dir: string;
  readonly name: string;
  readonly entry: string;
}) => Effect.Effect<string, EntryError, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Engine.stageGeneration",
)((options) => stageFiles(options));

const stageFiles = Effect.fn("Engine.stageFiles")(function* (
  options: { readonly dir: string; readonly name: string; readonly entry: string },
  sources?: { readonly names: ReadonlyArray<string>; readonly outside: ReadonlyArray<string> },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const from = directoryOf(options.entry);
  const outside = sources?.outside ?? (yield* outsideOf(from));
  const staged = (file: string) => path.join(options.dir, "generations", options.name, file);
  const failed = (cause: unknown) =>
    new EntryError({ file: options.entry, message: String(cause) });
  yield* fs.makeDirectory(staged(from), { recursive: true }).pipe(Effect.mapError(failed));
  const names =
    (sources === undefined
      ? undefined
      : Arr.filter(sources.names, (name) => !pipe(name, Str.includes("/")))) ??
    (yield* fs.readDirectory(from).pipe(Effect.mapError(failed)));
  for (const name of names) {
    if (unstaged(name)) {
      continue;
    }
    yield* fs
      .copy(path.join(from, name), staged(path.join(from, name)), { overwrite: true })
      .pipe(Effect.mapError(failed));
  }
  for (const file of outside) {
    yield* fs
      .makeDirectory(path.dirname(staged(file)), { recursive: true })
      .pipe(Effect.andThen(fs.copyFile(file, staged(file))), Effect.mapError(failed));
  }
  const looked = new Set<string>();
  for (const start of [from, ...Arr.map(outside, (file) => path.dirname(file))]) {
    for (let at = start; !looked.has(at); at = path.dirname(at)) {
      looked.add(at);
    }
  }
  for (const at of looked) {
    const installed = path.join(at, "node_modules");
    const link = path.join(staged(at), "node_modules");
    if (!(yield* fs.exists(installed).pipe(Effect.orElseSucceed(() => false)))) {
      continue;
    }
    if (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false))) {
      continue;
    }
    yield* fs
      .makeDirectory(staged(at), { recursive: true })
      .pipe(Effect.andThen(fs.symlink(installed, link)), Effect.mapError(failed));
  }
  return staged(options.entry);
});

const loaderOf: (name: string) => "ts" | "tsx" | "js" | null = (name) => {
  if (/\.(ts|mts|cts)$/.test(name)) {
    return "ts";
  }
  if (pipe(name, Str.endsWith(".tsx"))) {
    return "tsx";
  }
  return /\.(js|mjs|cjs|jsx)$/.test(name) ? "js" : null;
};

const directoryOf = (file: string) =>
  pipe(
    file,
    Str.slice(
      0,
      Option.getOrElse(pipe(file, Str.lastIndexOf("/")), () => -1),
    ),
  );
const parentOf = (at: string) =>
  pipe(
    at,
    Str.slice(
      0,
      Math.max(
        Option.getOrElse(pipe(at, Str.lastIndexOf("/")), () => -1),
        1,
      ),
    ),
  );

export const clearGenerations: (
  dir: string,
) => Effect.Effect<void, never, FileSystem.FileSystem> = (dir) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(`${dir}/generations`, { recursive: true, force: true })),
    Effect.ignore({ log: "Warn" }),
  );

export function engineLayer(options: {
  readonly dir: string;
  readonly messagePoll?: Duration.Input | undefined;
  readonly terminationTimeout?: Duration.Input | undefined;
}) {
  // WARNING: engine tables and Collie's rows share one connection in one file.
  const sql = hostDatabase(options.dir).pipe(Layer.orDie, Layer.provideMerge(Reactivity.layer));
  const shardingConfig = {
    // WARNING: a stopped host lets a running workflow finish its step rather than killing it.
    preemptiveShutdown: false,
    // WARNING: infinite, so a missing module waits for repair instead of failing its messages after a minute.
    entityRegistrationTimeout: Duration.infinity,
    // WARNING: one shard: each is a lock row held by the one runner.
    shardsPerGroup: 1,
  };
  const polled =
    options.messagePoll === undefined
      ? shardingConfig
      : { ...shardingConfig, entityMessagePollInterval: options.messagePoll };
  const bounded =
    options.terminationTimeout === undefined
      ? polled
      : { ...polled, entityTerminationTimeout: options.terminationTimeout };
  // WARNING: built when a host builds it, never on import; client commands must not pay for the cluster.
  const engine = Layer.unwrap(
    Effect.promise(() =>
      Promise.all([
        import("effect/cluster/Sharding"),
        import("effect/cluster/Runners"),
        import("effect/cluster/RunnerHealth"),
        import("effect/cluster/ShardingConfig"),
        import("effect/cluster/MessageStorage"),
        import("effect/cluster/SqlMessageStorage"),
        import("effect/cluster/SqlRunnerStorage"),
        import("effect/cluster/ClusterWorkflowEngine"),
      ]),
    ).pipe(
      Effect.map(
        ([
          Sharding,
          Runners,
          RunnerHealth,
          ShardingConfig,
          MessageStorage,
          SqlMessageStorage,
          SqlRunnerStorage,
          ClusterWorkflowEngine,
        ]) => {
          const storage = Layer.effect(MessageStorage.MessageStorage)(
            Effect.gen(function* () {
              const inner = yield* MessageStorage.MessageStorage;
              return touching(inner, yield* SqlClient.SqlClient, yield* EngineTouches);
            }),
          ).pipe(Layer.provide(SqlMessageStorage.layer));
          const cluster = Sharding.layer.pipe(
            Layer.provideMerge(Runners.layerNoop),
            Layer.provideMerge(storage),
            Layer.provide([Layer.orDie(SqlRunnerStorage.layer), RunnerHealth.layerNoop]),
            Layer.provide(ShardingConfig.layerFromEnv(bounded)),
            Layer.provide([oneShard.pipe(Layer.provideMerge(sql)), Digest.layerWebCrypto]),
          );
          return ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster));
        },
      ),
    ),
  );
  const returned: Layer.Layer<
    | WorkflowEngine.WorkflowEngine
    | MessageStorage.MessageStorage
    | SqlClient.SqlClient
    | Reactivity.Reactivity
    | EngineTouches,
    ConfigError
  > = engine.pipe(Layer.provideMerge(sql), Layer.provideMerge(engineTouchesLayer));
  return returned;
}

const ONE_SHARD = "default:1";

// WARNING: a message on any other shard is never read again, so move them here before the cluster reads storage.
const oneShard = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cluster_messages', 'cluster_locks')`;
    for (const { name } of tables) {
      yield* name === "cluster_messages"
        ? sql`UPDATE cluster_messages SET shard_id = ${ONE_SHARD} WHERE shard_id <> ${ONE_SHARD}`
        : sql`DELETE FROM cluster_locks WHERE shard_id <> ${ONE_SHARD}`;
    }
  }).pipe(Effect.orDie),
);

export const forgetExecution = (name: string, execution: string) =>
  Effect.gen(function* () {
    const [cluster, entity, ids, types, shard] = yield* Effect.promise(() =>
      Promise.all([
        import("effect/cluster/MessageStorage"),
        import("effect/cluster/EntityAddress"),
        import("effect/cluster/EntityId"),
        import("effect/cluster/EntityType"),
        import("effect/cluster/ShardId"),
      ]),
    );
    const storage = yield* cluster.MessageStorage;
    const address = (entityType: string) =>
      entity.EntityAddress.make({
        entityType: types.make(entityType),
        entityId: ids.make(execution),
        shardId: shard.make("default", 0),
      });
    yield* Effect.all([
      storage.clearAddress(address(`Workflow/${name}`)),
      storage.clearAddress(address("Workflow/-/DurableClock")),
    ]).pipe(Effect.orDie);
  });

const HAND_OVER_TIMEOUT = "30 seconds";

export { HOLD, STOP };
export const PARKED = "parked";
// WARNING: read only beside PARKED; the host clears both together.
export const PARK_CAUSE = "park-cause";
const PARK_INFO = "park-info";
const ParkJson = Schema.fromJsonString(Park);
const parkInfoOf = (text: string | null) =>
  text === null
    ? Effect.succeed(null)
    : Schema.decodeEffect(ParkJson)(text).pipe(Effect.orElseSucceed(() => null));
export const AWAITING = "awaiting";
export const USAGE = "usage";
const AWAITED = "awaited";
const NOTIFIED = "notified";

const decodeParkCause = Schema.decodeUnknownOption(ParkCause);
const parkCauseOf: (text: string | null) => ParkCause = (text) =>
  text === null
    ? "unknown"
    : Option.getOrElse(decodeParkCause(text), () => {
        const returned: ParkCause = "unknown";
        return returned;
      });

export const UsageWaitSchema = Schema.Struct({
  account: Schema.String,
  resetsAt: Schema.NullOr(Schema.String),
});
const UsageWaitJson = Schema.fromJsonString(UsageWaitSchema);

const UNSPECIFIED = "unspecified";

export const evidenceDir: (dir: string, runId: string) => string = (dir, runId) =>
  `${dir}/evidence/${runId}`;

export const runDir: (dir: string, runId: string) => string = (dir, runId) =>
  `${dir}/runs/${runId}`;

const lineageIn = (store: StoreApi) =>
  Effect.fn("Engine.lineageOf")(function* (runId: string) {
    const lineage = [runId];
    for (let at = 0; at < lineage.length; at++) {
      const row = yield* store.run(lineage[at]!);
      if (row === null) {
        continue;
      }
      const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
      const plan = Arr.map(Arr.filter(Rec.values(input), Schema.is(Schema.String)), planRunOf);
      for (const from of [row.parent, ...plan]) {
        if (from != null && !lineage.includes(from)) {
          lineage.push(from);
        }
      }
    }
    return lineage;
  });

const decodeAskedAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ attachments: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

export const checkoutRefusedFile = (dir: string) => `${dir}/checkout-refused`;

const reviewedAsk = (
  dir: string,
  runId: string,
  cwd: string,
  target: string,
  login: string | null,
) => ({
  cwd,
  name: runId,
  inputs: { [REVIEWED]: target, work: runDir(dir, runId), work_kind: "review" },
  strategies: { [REVIEWED]: "diff-target", work: "work-source" },
  login,
});

const recordedIn: (store: StoreApi) => RecordedBy = (store) => (at) =>
  store.runs.pipe(
    Effect.map((rows) => {
      const one = Option.getOrUndefined(
        Arr.findFirst(rows, (row) => placedOf(row, {}).worktree?.path === at),
      );
      return one === undefined
        ? null
        : {
            run: one.run,
            worktree: placedOf(one, {}).worktree ?? null,
            live: Effect.succeed(null),
            release: Effect.succeed("a review's fix round takes over nothing"),
          };
    }),
  );

const refusedCheckout = (o: {
  readonly dir: string;
  readonly store: StoreApi;
  readonly placing: { readonly herdr: Herdr; readonly env: PluginEnv };
  readonly starter: RunRow;
  readonly target: string;
  readonly awaits: boolean;
}) =>
  Effect.gen(function* () {
    const launch = yield* decodeStrings(o.starter.options ?? "{}").pipe(
      Effect.orElseSucceed(() => {
        const returned: Record<string, string> = {};
        return returned;
      }),
    );
    const placed = placedOf(o.starter, launch);
    const { herdr, env } = o.placing;
    const ask: Parameters<typeof checkoutRefusal>[1] = {
      ...reviewedAsk(o.dir, o.starter.run, placed.cwd, o.target, env.gitlabLogin),
      recordedBy: recordedIn(o.store),
    };
    if (o.awaits && placed.worktree !== null) {
      ask.starting = { run: o.starter.run, cwd: placed.cwd };
    }
    const refused = yield* Effect.result(checkoutRefusal(herdr, ask));
    return refused._tag === "Failure"
      ? `no checkout could be made: ${String(refused.failure)}`
      : refused.success;
  });

const recordedMergeRequest = (runId: string) =>
  RunRecords.use((records) => records.fact(runId, MERGE_REQUEST)).pipe(
    Effect.map((url) => (url === null ? null : Str.trim(url) || null)),
  );

const startOf = (cwd: string) =>
  defaultStart(cwd, runShell).pipe(
    Effect.flatMap((ref) =>
      runShell("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
        Effect.map((found) => (found.code === 0 ? ref : null)),
      ),
    ),
  );

// WARNING: checks are read at the start ref, or from the working tree where there is no ref.
const approvedAt = Effect.fn("Engine.approvedAt")(function* (
  cwd: string,
  userDir: string,
  ref: string | null,
) {
  const shown =
    ref === null ? null : yield* runShell("git", ["show", `${ref}:./${PROJECT_FILE}`], cwd);
  return yield* approvedFrom({
    cwd,
    userDir,
    project: yield* projectHere(cwd, runShell),
    base: ref === null ? undefined : { ref, text: shown?.code === 0 ? shown.stdout : null },
  });
});

// WARNING: frozen at admission, so editing the checks file changes the next Run only.
export const freezeApproved = Effect.fn("Engine.freezeApproved")(function* (options: {
  readonly dir: string;
  readonly runId: string;
  readonly project: string;
  readonly userDir: string;
  readonly approved?: ReadonlyArray<VerifySpec>;
}) {
  const evidence = evidenceDir(options.dir, options.runId);
  const frozen = yield* RunRecords.use((records) =>
    records.fact(options.runId, `${addressOf(evidence).prefix}approved.json`),
  );
  if (frozen !== null) {
    return;
  }
  const approved =
    options.approved ??
    (yield* approvedAt(options.project, options.userDir, yield* startOf(options.project)).pipe(
      Effect.orElseSucceed(() => {
        const returned: ReadonlyArray<VerifySpec> = [];
        return returned;
      }),
    ));
  yield* updateApproved(evidence, (was) => was ?? approved);
});

const approvedOf = (dir: string, runId: string) => approvedIn(evidenceDir(dir, runId));
const ciJobsOfIn = (dir: string, runId: string) =>
  Effect.map(approvedOf(dir, runId), (approved) =>
    Arr.flatMap(approved, (spec) => (spec.ci === undefined ? [] : [spec.ci])),
  );

const claimPath = (dir: string, runId: string) => `${runDir(dir, runId)}/helle.json`;

// WARNING: an older host recorded one claim, not a list; decode both shapes.
const decodeClaims = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([HelleClaimSchema, Schema.Array(HelleClaimSchema)])),
);
const encodeClaims = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(HelleClaimSchema))),
  Result.getOrThrow,
);

const recordedClaims: (
  file: string,
) => Effect.Effect<ReadonlyArray<HelleClaim>, never, FileSystem.FileSystem> = (file) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.flatMap(decodeClaims),
    Effect.map((read) => ("slug" in read ? [read] : read)),
    Effect.orElseSucceed(() => {
      const returned: ReadonlyArray<HelleClaim> = [];
      return returned;
    }),
  );

const writeClaims = (file: string, claims: ReadonlyArray<HelleClaim>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      claims.length === 0
        ? fs.remove(file, { force: true })
        : fs.writeFileString(file, encodeClaims(claims)),
    ),
  );

// WARNING: serialises claim changes, which several Runs make to one record at once.
const changingClaims = Semaphore.makeUnsafe(1);

const updateClaims = (
  file: string,
  change: (claims: ReadonlyArray<HelleClaim>) => ReadonlyArray<HelleClaim>,
) =>
  changingClaims.withPermits(1)(
    recordedClaims(file).pipe(Effect.flatMap((claims) => writeClaims(file, change(claims)))),
  );

const DeclaredSchema = Schema.fromJsonString(
  Schema.Struct({ projects: Schema.Array(Schema.String) }),
);

const declaredProjects = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${cwd}/.collie/helle.json`;
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return null;
    }
    const read = yield* fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(DeclaredSchema)),
      Effect.mapError(
        (cause) =>
          new HelleError({ message: `${file} is not {"projects": [...]}: ${String(cause)}` }),
      ),
    );
    return read.projects;
  });

const helleWhere = (
  cwd: string,
  deploys:
    | { readonly applications: ReadonlyArray<string>; readonly jobs: ReadonlyArray<string> }
    | undefined,
) =>
  Effect.gen(function* () {
    const env = yield* currentEnv.pipe(Effect.orDie);
    return {
      home: env.home,
      envFile: env.raw.HELLE_ENV_FILE ?? null,
      url: helleUrlOf(env.raw),
      repositoryPath: yield* projectHere(cwd, runShell),
      // WARNING: a checkout's name does not identify its Helle project.
      repoName: (yield* repositoryName(runShell, cwd)) ?? (yield* Path.Path).basename(cwd),
      deploys: deploys ?? null,
      declared: yield* declaredProjects(cwd),
    };
  });

export class Reliance extends Context.Service<
  Reliance,
  {
    readonly relied: (
      runId: string,
      command: Pick<Verification, "executable" | "argv" | "cwd">,
    ) => Effect.Effect<({ readonly check: string } & Reuse) | null>;
    readonly recorded: (
      runId: string,
      command: Pick<Verification, "name" | "executable" | "argv" | "cwd" | "expect"> & {
        readonly isolated?: Isolation;
      },
    ) => Effect.Effect<Reuse>;
  }
>()("collie/Reliance") {}

export class Executions extends Context.Service<
  Executions,
  {
    readonly stop: (runId: string) => Effect.Effect<{
      readonly runs: ReadonlyArray<string>;
      readonly left: ReadonlyArray<string>;
    }>;
    readonly stopped: (runId: string) => Effect.Effect<boolean>;
  }
>()("collie/Executions") {}

// WARNING: the old record goes only after its Runs stop and their agents close, or they keep changing what the claim guards.
export const handOverClaim = Effect.fn("Engine.handOverClaim")(function* (options: {
  readonly dir: string;
  readonly slug: string;
  readonly to: string;
  readonly runs: ReadonlyArray<string>;
  readonly stop: typeof Executions.Service.stop;
  readonly stopped: typeof Executions.Service.stopped;
  readonly halt: (runId: string) => Effect.Effect<AgentsSdk.Halted>;
  readonly patience?: { readonly everyMs: number; readonly forMs: number };
}) {
  const patience = options.patience ?? { everyMs: 250, forMs: 60_000 };
  const handed: Array<string> = [];
  for (const runId of options.runs) {
    if (runId === options.to) {
      continue;
    }
    const file = claimPath(options.dir, runId);
    const record = yield* recordedClaims(file);
    if (!Arr.some(record, (one) => one.slug === options.slug)) {
      continue;
    }
    const refused = (left: ReadonlyArray<string>) =>
      new HelleError({
        message: `the claim on ${options.slug} is ${runId}'s, and its agents did not all close (${Arr.join(left, "; ")}); close them, then resume ${options.to}`,
      });
    const tree = yield* options.stop(runId);
    if (tree.left.length > 0) {
      return yield* refused(tree.left);
    }
    const deadline = (yield* Clock.currentTimeMillis) + patience.forMs;
    for (const one of tree.runs) {
      const stopped = yield* options.stopped(one).pipe(
        Effect.repeat({
          until: (stopped) => stopped,
          schedule: Schedule.spaced(patience.everyMs).pipe(
            Schedule.while(({ now }) => now < deadline),
          ),
        }),
      );
      if (!stopped) {
        return yield* new HelleError({
          message: `the claim on ${options.slug} is ${runId}'s, and ${one} is still running a step its stop has not reached; resume ${options.to} once ${one} has stopped`,
        });
      }
    }
    const late: Array<string> = [];
    for (const one of tree.runs) {
      late.push(...(yield* options.halt(one)).left);
    }
    if (late.length > 0) {
      return yield* refused(late);
    }
    yield* updateClaims(file, (now) => Arr.filter(now, (one) => one.slug !== options.slug)).pipe(
      Effect.orDie,
    );
    yield* appendLog(
      runDir(options.dir, runId),
      `claim on ${options.slug} taken over by ${options.to}; its agents were closed`,
    ).pipe(Effect.orDie);
    handed.push(runId);
  }
  return handed;
});

const AWAY_FILE = "away-from";

// WARNING: a crash mid-comparison leaves the checkout at the base; this puts it back.
const restoreCheckout = (cwd: string, away: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const back = yield* fs.readFileString(away).pipe(Effect.orElseSucceed(() => ""));
    if (back === "") {
      return;
    }
    if ((yield* runShell("git", ["checkout", "-q", back], cwd)).code !== 0) {
      return yield* new WorkflowError({ reason: `the checkout could not be put back on ${back}` });
    }
    yield* fs.remove(away).pipe(Effect.ignore);
  });

const passAsked: (asked: Parameters<Sdk.HostApi["verify"]>[0]) => CheckPass = (asked) => {
  if (asked.at === "default-base") {
    return { pass: "baseline" };
  }
  if (asked.pass === "fix" && asked.round !== undefined) {
    return { pass: "fix", round: asked.round };
  }
  return { pass: asked.pass ?? "check" };
};

const defaultMergeBase = (cwd: string) =>
  Effect.gen(function* () {
    const git = (...args: Array<string>) => runShell("git", args, cwd);
    const branch = yield* defaultBase(runShell, cwd);
    if (branch === null) {
      return { found: false, why: "no default branch" } as const;
    }
    const remote = yield* git("merge-base", "HEAD", `origin/${branch}`);
    const merged = remote.code === 0 ? remote : yield* git("merge-base", "HEAD", branch);
    if (merged.code !== 0) {
      return { found: false, why: `no merge-base with ${branch}` } as const;
    }
    return { found: true, branch, base: Str.trim(merged.stdout) } as const;
  });

const localHead = (target: string, cwd: string) =>
  runShell(
    "git",
    ["rev-parse", "--verify", "--quiet", `${branchTargetHead(target) ?? "HEAD"}^{commit}`],
    cwd,
  ).pipe(
    Effect.map((said) => (said.code === 0 ? Str.trim(said.stdout) : "")),
    Effect.orElseSucceed(() => ""),
  );

const localChanges = (cwd: string, previous: string, head: string, base: string) =>
  Effect.gen(function* () {
    const git = (...args: Array<string>) => runShell("git", args, cwd);
    const range = `${previous}..${head}`;
    const commits = yield* git(
      "log",
      "--no-merges",
      "--format=- %h %s",
      range,
      ...(base === "" ? [] : ["--not", base]),
    );
    const files = yield* git("diff", "--name-status", previous, head);
    const own = base === "" ? null : yield* git("diff", "--name-only", `${base}...${head}`);
    const failed = Arr.filter(
      [commits, files, ...(own === null ? [] : [own])],
      (one) => one.code !== 0,
    );
    if (failed.length > 0) {
      return yield* new WorkflowError({
        reason: `the changes from ${previous} to ${head} could not be read: ${Str.trim(
          Arr.join(
            Arr.map(failed, (one) => one.stderr ?? ""),
            " ",
          ),
        )}`,
      });
    }
    const lines = (text: string) => (Str.trim(text) === "" ? [] : Str.split(Str.trim(text), "\n"));
    const owned = own === null ? null : new Set(lines(own.stdout));
    const changed = Arr.filter(
      Arr.map(lines(files.stdout), (one) => Str.split(one, "\t")),
      (fields) => owned === null || owned.has(fields.at(-1) ?? ""),
    );
    const listed = (all: ReadonlyArray<string>) =>
      all.length === 0 ? "(none)" : Arr.join(all, "\n");
    return Arr.join(
      [
        base === ""
          ? `Changed since it, in full with \`git diff ${previous} ${head}\`.`
          : `Changed since it, commit by commit with \`git log -p --no-merges ${range} --not ${base}\`.`,
        `Commits:\n${listed(lines(commits.stdout))}`,
        `Files:\n${listed(Arr.map(changed, (fields) => `- ${Arr.join(fields, " ")}`))}`,
      ],
      "\n\n",
    );
  });

const branchOwns = (cwd: string, test: FailedTest) =>
  Effect.gen(function* () {
    const branch = yield* defaultBase(runShell, cwd);
    return branch !== null && ownTests([test], yield* branchChange(cwd, branch)).length > 0;
  });

// WARNING: a checkout with changes of its own is refused; they would travel to the base.
const atDefaultBase = <A, R>(
  cwd: string,
  away: string,
  body: (branch: string) => Effect.Effect<A, WorkflowError, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = (...args: Array<string>) => runShell("git", args, cwd);
    const refuse = (why: string) =>
      new WorkflowError({ reason: `not compared at the default branch: ${why}` });
    if (Str.trim((yield* git("status", "--porcelain")).stdout) !== "") {
      return yield* refuse("the checkout has changes of its own");
    }
    const found = yield* defaultMergeBase(cwd);
    if (!found.found) {
      return yield* refuse(found.why);
    }
    const { branch, base } = found;
    const head = Str.trim((yield* git("rev-parse", "HEAD")).stdout);
    const named = yield* git("symbolic-ref", "-q", "--short", "HEAD");
    const back = named.code === 0 ? Str.trim(named.stdout) : head;
    yield* fs.writeFileString(away, back).pipe(Effect.orDie);
    if ((yield* git("checkout", "-q", "--detach", base)).code !== 0) {
      yield* fs.remove(away).pipe(Effect.ignore);
      return yield* refuse(`${base} could not be checked out`);
    }
    return yield* body(branch).pipe(Effect.ensuring(restoreCheckout(cwd, away).pipe(Effect.orDie)));
  });

const SYNCED_RECOVERY = "synced-recovery";
const RecoveryJson = Schema.fromJsonString(Recovery);
const encodeRecovery = flow(Schema.encodeResult(RecoveryJson), Result.getOrThrow);
const decodeRecovery = (text: string) =>
  Option.getOrUndefined(Schema.decodeOption(RecoveryJson)(text));

const recoveryFor = Effect.fn("Engine.recoveryFor")(function* (
  store: StoreApi,
  dir: string,
  runId: string,
  parent: string,
  source: string,
) {
  const id = Str.split(parent, "/").at(-1) ?? parent;
  const from = yield* store.run(id);
  const own = yield* store.run(runId);
  const options =
    own === null
      ? {}
      : yield* decodeStrings(own.options ?? "{}").pipe(
          Effect.orElseSucceed(() => {
            const returned: Record<string, string> = {};
            return returned;
          }),
        );
  const candidates = Arr.filter(
    yield* store.runs,
    (row) => row.run === id || (from?.task != null && row.task === from.task),
  );
  return yield* recoveryFrom({
    cwd: own === null ? dir : workingPlace(own).cwd,
    dir: runDir(dir, runId),
    parent: runDir(dir, id),
    candidates: from === null ? [] : Arr.map(candidates, (row) => runDir(dir, row.run)),
    source,
    outcome: Rec.get(options, "outcome").pipe(Option.getOrElse(() => "")),
    risks: Rec.get(options, "risks").pipe(Option.getOrElse(() => "")),
  });
});

export const hostLayer: (options: {
  readonly dir: string;
  readonly userDir?: string;
  readonly toast?: Toast;
  readonly slack?: typeof slackApi;
  readonly herd?: Herd;
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  readonly productionPoll?: Duration.Input;
  readonly issuePrivacyBudget?: Duration.Input;
  readonly reviewPoll?: Duration.Input;
  readonly collectMs?: Duration.Input;
}) => Layer.Layer<
  Host | Notifier | Oversight | Reliance,
  never,
  Store | Records | PlatformServices | ForgeHttp
> = (options) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const dir = options.dir;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* Store;
      type Collecting =
        | FileSystem.FileSystem
        | Path.Path
        | ChildProcessSpawner.ChildProcessSpawner
        | ForgeHttp
        | Records;
      const services = yield* Effect.context<Collecting>();
      const bun = yield* Effect.context<PlatformServices | Records>();
      const runRecords = yield* RunRecords;
      const mergeRequestOf = (runId: string) =>
        recordedMergeRequest(runId).pipe(Effect.provideService(RunRecords, runRecords));
      const under = <A, E>(effect: Effect.Effect<A, E, Collecting>) =>
        Effect.provideContext(effect, services);
      const parkReview = (reason: string) =>
        Effect.gen(function* () {
          const run = yield* Effect.serviceOption(Run);
          const instance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
          if (Option.isSome(run) && Option.isSome(instance)) {
            yield* host.parked(run.value.id, reason, "forge-unavailable");
            return yield* Workflow.suspend(instance.value);
          }
        });
      const reviewForge = <A, E>(effect: Effect.Effect<A, E, Collecting>) =>
        Effect.gen(function* () {
          const run = yield* Effect.serviceOption(Run);
          const instance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
          if (Option.isNone(run) || Option.isNone(instance)) {
            return yield* under(effect);
          }
          const parking = yield* Semaphore.make(1);
          return yield* under(
            effect.pipe(
              Effect.updateService(ForgeHttp, (http) =>
                ForgeHttp.of({
                  ask: (login, cwd, call) =>
                    http
                      .ask(login, cwd, call)
                      .pipe(
                        Effect.tap((answer) =>
                          !answer.ok && answer.transient
                            ? parkReview(answer.reason).pipe(parking.withPermits(1))
                            : Effect.void,
                        ),
                      ),
                }),
              ),
            ),
          );
        });
      const anySet = (runId: string, ...controls: ReadonlyArray<string>) =>
        controlSet(runId, ...controls).pipe(Effect.provideService(RunRecords, runRecords));
      const set = (control: string, runId: string) => anySet(runId, control);
      const untilSet = (runId: string, ...controls: ReadonlyArray<string>) =>
        anySet(runId, ...controls).pipe(
          Effect.repeat({ until: (on) => on, schedule: Schedule.spaced("1 second") }),
        );
      const untilStopped = (runId: string) => untilSet(runId, STOP);
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
      const toast = options.toast;
      const notifying = yield* Semaphore.make(1);
      const passedOverHere = (runId: string, cause: ParkCause, recoveries: ReadonlyArray<Metric>) =>
        Effect.gen(function* () {
          const row = yield* store.run(runId);
          const placing = Option.getOrUndefined(decodePlacing(row?.placing ?? ""));
          const env = Option.getOrUndefined(yield* currentEnv.pipe(Effect.option));
          const userDir = options.userDir ?? env?.userDir ?? dir;
          const audit = yield* under(readAudit(runDir(dir, runId))).pipe(
            Effect.orElseSucceed(() => []),
          );
          const questions = yield* askedQuestions(yield* store.asked(runId), audit);
          const passed = passedOver({
            cause,
            isHeal: placing?.heals !== undefined,
            on: yield* under(healOn(userDir)).pipe(Effect.orElseSucceed(() => true)),
            waitsOnYou:
              (yield* anySet(runId, HOLD, STOP)) ||
              Arr.some(questions, (one) => one.answer === null),
            recoveries,
          });
          if (passed !== null) {
            return passed;
          }
          const healer =
            row === null || env === undefined
              ? null
              : yield* under(healerFor({ pluginRoot: env.pluginRoot, userDir }, row.project));
          return healer === null ? "no workflow declares itself the healer" : null;
        });
      const notify: Notifier["Service"]["notify"] = (runId, kind, body, about = {}) =>
        under(
          Effect.gen(function* () {
            const settings =
              options.userDir === undefined
                ? {}
                : (yield* loadDefaults(options.userDir)).notifications;
            if (!wanted(settings, kind)) {
              return;
            }
            const raw = yield* readConfig(options.userDir ?? dir);
            const configured = configValue(raw, "slack.notification_channel");
            const channel = isText(configured) ? Str.trim(configured) : "";
            const row = yield* store.run(runId);
            if (toast === undefined && (channel === "" || row === null)) {
              return;
            }
            // WARNING: mark before delivery, so a replay never repeats an attempted post.
            const said = `${kind}:${pipe(about.key ?? "", Str.replaceAll("\n", " "))}`;
            if ((yield* runRecords.control(NOTIFIED, runId, said)) !== null) {
              return;
            }
            yield* runRecords.setControl(NOTIFIED, runId, "", said);
            const cwd =
              row === null
                ? dir
                : placedOf(
                    row,
                    yield* decodeStrings(row.options ?? "{}").pipe(
                      Effect.orElseSucceed(() => {
                        const returned: Record<string, string> = {};
                        return returned;
                      }),
                    ),
                  ).cwd;
            const task =
              row?.task == null
                ? null
                : yield* readTask(row.task).pipe(Effect.orElseSucceed(() => null));
            const title = notificationTitle(
              kind,
              cwd,
              task === null ? runId : taskTitleOf(task.label),
              about.subject,
            );
            if (toast !== undefined) {
              yield* toast(title, body, SOUND[kind], runId).pipe(Effect.ignore);
            }
            if (channel === "" || row === null) {
              return;
            }
            yield* Effect.gen(function* () {
              const reading = yield* host.connection("slack");
              if (reading.state !== "ok") {
                if (reading.state === "broken") {
                  yield* appendLog(
                    runDir(dir, runId),
                    `Slack notification (${kind}) was not posted: ${reading.detail}`,
                  );
                }
                return;
              }
              if (isDirectMessage(channel)) {
                return yield* Effect.fail("direct messages are no longer sent; pick a channel");
              }
              const { env } = yield* placing;
              const slack = options.slack ?? slackApi;
              yield* slack(yield* slackUserToken(env, slack)).post(
                channel,
                slackText(`${title}\n${body}`),
              );
            }).pipe(
              Effect.catch((reason) =>
                appendLog(
                  runDir(dir, runId),
                  `Slack notification (${kind}) was not posted: ${isText(reason) ? reason : "Slack's credential file could not be read"}`,
                ).pipe(Effect.ignore),
              ),
            );
          }),
        ).pipe(notifying.withPermits(1), Effect.ignore);
      const lineageOf = lineageIn(store);
      const recoveryLineage = Effect.fnUntraced(function* (runId: string) {
        const lineage: Array<string> = [];
        let from = runId;
        while (from !== "" && !lineage.includes(from)) {
          lineage.unshift(from);
          from = (yield* runRecords.fact(from, RECOVERY_PARENT)) ?? "";
        }
        return lineage;
      });
      const inheritedEvidence: (
        runs: ReadonlyArray<string>,
        cwd: string,
        seen: ReadonlySet<string>,
      ) => Effect.Effect<ReadonlyArray<Verification>, never, Collecting> = (runs, cwd, seen) =>
        Effect.map(
          Effect.forEach(runs, (runId) =>
            Effect.gen(function* () {
              const row = yield* store.run(runId).pipe(Effect.orDie);
              const consumed =
                row === null
                  ? undefined
                  : Option.getOrUndefined(decodePlacing(row.placing ?? ""))?.continues;
              if (consumed === undefined || seen.has(consumed.run)) {
                return [];
              }
              const own = yield* sourceEvidence({
                cwd,
                consumed,
                sourceDir: runDir(dir, consumed.run),
                sourceEvidence: evidenceDir(dir, consumed.run),
              });
              if (own === null) {
                return [];
              }
              const lineage = yield* recoveryLineage(consumed.run);
              const before = yield* inheritedEvidence(lineage, cwd, new Set([...seen, ...lineage]));
              return [...before, ...own];
            }),
          ),
          Arr.flatten,
        );
      const hostStarted = yield* nowIso;
      const relyOn = (runId: string, run: CheckRun, spec: VerifySpec, recorded: CheckPass) =>
        Effect.gen(function* () {
          const { record, miss } = yield* reliedFor(
            evidenceDir(dir, runId),
            run,
            spec,
            hostStarted,
          );
          const said =
            record !== null
              ? `relies on verification ${record.id}`
              : miss === null
                ? null
                : `runs: ${missSaid(miss)}`;
          if (said !== null) {
            yield* appendLog(runDir(dir, runId), `${recorded.pass}: ${spec.name} ${said}`).pipe(
              Effect.orDie,
            );
          }
          return record;
        });
      const check = (asked: Parameters<Sdk.HostApi["verify"]>[0], recorded: CheckPass) =>
        under(
          Effect.gen(function* () {
            const approved = yield* approvedOf(dir, asked.runId);
            const spec = Option.getOrUndefined(
              Arr.findFirst(approved, (entry) => entry.name === asked.name),
            );
            if (spec === undefined) {
              return yield* new WorkflowError({
                reason: `"${asked.name}" is not among this Run's checks`,
              });
            }
            const own = yield* treeOf(yield* store.run(asked.runId), asked.runId, dir);
            if (!(yield* insideRun(asked.cwd, own))) {
              return yield* new WorkflowError({
                reason: `"${asked.cwd}" is not inside run ${asked.runId}`,
              });
            }
            const journal = evidenceDir(dir, asked.runId);
            const marker = controlOf(runRecords, VERIFYING, asked.runId);
            const away = `${runDir(dir, asked.runId)}/${AWAY_FILE}`;
            yield* restoreCheckout(asked.cwd, away);
            const rerun =
              asked.pass === "rerun" || asked.at === "default-base" ? asked.test : undefined;
            if (asked.pass === "rerun" && rerun === undefined) {
              return yield* new WorkflowError({ reason: "a rerun names the one test it runs" });
            }
            if (asked.at === undefined && asked.expect !== "fail" && rerun === undefined) {
              const kept = yield* relyOn(asked.runId, { ...own, cwd: asked.cwd }, spec, recorded);
              if (kept !== null) {
                return kept;
              }
            }
            const env = yield* currentEnv.pipe(Effect.option);
            if (Option.isSome(env)) {
              const memory = yield* waitForMemory({
                env: { ...env.value, userDir: options.userDir ?? env.value.userDir },
                stateDir: dir,
                runId: asked.runId,
                what: `${recorded.pass}: ${spec.name}`,
                checkout: asked.cwd,
                stopped: set(STOP, asked.runId),
              });
              if (memory === "stopped") {
                return yield* new WorkflowError({
                  reason: `${spec.name} did not run: the Run was stopped while it waited for memory`,
                });
              }
            }
            const verified = (base: string | null) =>
              Effect.gen(function* () {
                const head = yield* runShell("git", ["rev-parse", "HEAD"], asked.cwd);
                if (base !== null && rerun !== undefined) {
                  const checkDir = yield* checkCwd({ ...own, cwd: asked.cwd }, spec);
                  const known = Option.getOrUndefined(
                    Arr.findLast(
                      yield* readVerifications(journal).pipe(Effect.orDie),
                      (v) =>
                        v.pass === "baseline" &&
                        v.name === spec.name &&
                        v.cwd === checkDir &&
                        v.test?.file === rerun.file &&
                        v.test.name === rerun.name &&
                        v.start.head_sha === Str.trim(head.stdout),
                    ),
                  );
                  if (known !== undefined) {
                    return known;
                  }
                }
                const started = yield* nowIso;
                const log = `${journal}/checks/${pipe(started, Str.replaceAll(/[:.]/g, "-"))}-${pipe(spec.name, Str.replaceAll(/[^\w.-]/g, "_"))}.log`;
                yield* marker.set(
                  encodeVerifying({
                    name: spec.name,
                    executable: rerun === undefined ? spec.executable : "bun",
                    argv: rerun === undefined ? spec.argv : rerunArgv(rerun),
                    pass: recorded.pass,
                    round: recorded.round ?? null,
                    revision: head.code === 0 ? Str.trim(head.stdout) : "",
                    base,
                    started,
                    checkout: asked.cwd,
                    log,
                  }),
                );
                return yield* (
                  rerun === undefined
                    ? runApproved(
                        journal,
                        { ...own, cwd: asked.cwd, checkouts: baseTreesDir(dir, asked.runId) },
                        approved,
                        spec,
                        asked.expect ?? "pass",
                        recorded,
                        log,
                      )
                    : rerunTest(
                        journal,
                        { ...own, cwd: asked.cwd },
                        spec,
                        rerun,
                        asked.at === "default-base"
                          ? { pass: "baseline" }
                          : { pass: "rerun", own: yield* branchOwns(asked.cwd, rerun) },
                        log,
                      )
                ).pipe(
                  Effect.tap((record) => noteVerification(journal, record)),
                  Effect.mapError((refused) => new WorkflowError({ reason: refused.why })),
                );
              });
            const ran = yield* Effect.raceFirst(
              (asked.at === "default-base"
                ? atDefaultBase(asked.cwd, away, verified)
                : verified(null)
              ).pipe(Effect.asSome),
              untilStopped(asked.runId).pipe(Effect.as(Option.none<Verification>())),
            ).pipe(Effect.ensuring(marker.set(null)));
            if (Option.isSome(ran)) {
              return ran.value;
            }
            const instance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
            if (Option.isSome(instance)) {
              return yield* Workflow.suspend(instance.value);
            }
            return yield* new WorkflowError({
              reason: `${spec.name} did not finish: the Run was stopped while it ran`,
            });
          }),
        );
      const placing = options.placing
        ? Effect.succeed(options.placing)
        : currentEnv.pipe(
            Effect.map((env) => ({ herdr: new Herdr(env), env })),
            Effect.orDie,
          );
      const publicRefusal = <E, R>(text: string, project: Effect.Effect<string | null, E, R>) =>
        Effect.gen(function* () {
          const leaks = leaksIn(text);
          if (leaks.length === 0) {
            return null;
          }
          const { env } = yield* placing;
          const bound = yield* project;
          return bound === COLLIE_REPOSITORY || bound === ownRepository(releasesOf(env.raw))
            ? null
            : refusal(leaks);
        });
      const waitingForAgents = (runId: string, cwd: string) =>
        Effect.gen(function* () {
          const mine = Arr.filter(yield* under(everyRegistered), (one) => one.runId === runId);
          if (mine.length === 0) {
            return "clear" as const;
          }
          const { herdr } = yield* placing;
          return yield* waitForAgents({
            budget: Duration.toMillis(options.collectMs ?? Duration.minutes(120)),
            poll: AGENT_WAIT_POLL,
            rosterBudget: AGENT_LIST_BUDGET,
            working: herdr.agentList().pipe(
              Effect.provideContext(bun),
              Effect.map((roster) =>
                Arr.map(
                  Arr.filter(mine, (one) => workingIn(one, roster, cwd)),
                  (one) => one.agent,
                ),
              ),
              Effect.orElseSucceed(() => null),
            ),
            stopped: set(STOP, runId),
            tell: (names, unknown) =>
              under(
                appendLog(
                  runDir(dir, runId),
                  `waiting for ${Arr.join(
                    unknown ? Arr.map(mine, (one) => one.agent) : names,
                    ", ",
                  )} to stop working in ${cwd}${
                    unknown ? `, where core cannot list its agents yet` : ""
                  }`,
                ),
              ).pipe(Effect.orDie),
          });
        });
      const madeByCollie = (cwd: string) =>
        Effect.gen(function* () {
          for (const row of yield* store.runs) {
            const worktree = placedOf(row, {}).worktree;
            if (
              worktree !== null &&
              worktree.path === cwd &&
              (yield* under(isTheOneMade(cwd, worktree)))
            ) {
              return true;
            }
          }
          return false;
        });
      const reviewing = (runId: string) =>
        Effect.gen(function* () {
          const row = yield* store.run(runId);
          if (row === null) {
            return { refused: `there is no Run ${runId}` };
          }
          const launch = yield* decodeStrings(row.options ?? "{}").pipe(
            Effect.orElseSucceed(() => {
              const returned: Record<string, string> = {};
              return returned;
            }),
          );
          const placed = placedOf(row, launch);
          const input = yield* decodeInput(row.input).pipe(
            Effect.orElseSucceed(() => {
              const returned: Readonly<Record<string, Schema.Json>> = {};
              return returned;
            }),
          );
          const field = fieldWith(yield* WorkflowHints, "diff-target");
          const target = field === undefined ? undefined : input[field];
          const { herdr, env } = yield* placing;
          return {
            row,
            placed,
            herdr,
            env,
            ask: reviewedAsk(dir, runId, placed.cwd, isText(target) ? target : "", env.gitlabLogin),
          };
        });
      const reviewedBranch = (runId: string) =>
        Effect.gen(function* () {
          const asked = yield* reviewing(runId);
          if (asked.refused !== undefined) {
            return { refused: asked.refused };
          }
          const { placed } = asked;
          if (placed.worktree !== null) {
            return { branch: placed.branch ?? placed.worktree.branch };
          }
          const plan = yield* Effect.result(branchFor(asked.ask));
          if (plan._tag === "Failure") {
            return { refused: `no branch could be established: ${String(plan.failure)}` };
          }
          return plan.success.refused
            ? { refused: plan.success.refused }
            : { branch: plan.success.branch };
        }).pipe(Effect.provideContext(bun), under);
      const startingCheckout = (row: RunRow) =>
        Effect.gen(function* () {
          const parent = row.parent === null ? null : yield* store.run(row.parent);
          if (parent === null) {
            return {};
          }
          const placed = placedOf(parent, {});
          if (placed.worktree === null) {
            return {};
          }
          const awaited = yield* runRecords.controlsOf(AWAITED, parent.run);
          return awaited.length === 1 && awaited[0]!.key === row.run
            ? { starting: { run: parent.run, cwd: placed.cwd } }
            : {};
        });
      const checkoutReviewed = (runId: string, opts?: { readonly inStarter?: boolean }) =>
        Effect.gen(function* () {
          const asked = yield* reviewing(runId);
          if (asked.refused !== undefined) {
            return { refused: asked.refused };
          }
          const { row, placed, herdr, env } = asked;
          if (placed.worktree !== null) {
            return { cwd: placed.cwd, branch: placed.branch ?? placed.worktree.branch };
          }
          const starting = opts?.inStarter === true ? yield* startingCheckout(row) : {};
          const made = yield* Effect.result(
            checkoutFor(herdr, {
              ...asked.ask,
              ...starting,
              stateDir: env.stateDir,
              workflow: row.workflow,
              checkout: "branch",
              recordedBy: recordedIn(store),
            }),
          );
          const refuse = (refused: string) =>
            fs
              .makeDirectory(runDir(dir, runId), { recursive: true })
              .pipe(
                Effect.andThen(
                  fs.writeFileString(checkoutRefusedFile(runDir(dir, runId)), `${refused}\n`),
                ),
                Effect.orDie,
                Effect.as({ refused }),
              );
          if (made._tag === "Failure") {
            return yield* refuse(`no checkout could be made: ${String(made.failure)}`);
          }
          const checkout = made.success;
          if (checkout.refused !== null) {
            return yield* refuse(checkout.refused);
          }
          if (checkout.note !== "") {
            yield* appendLog(runDir(dir, runId), checkout.note).pipe(Effect.orDie);
          }
          yield* store.place(runId, {
            checkout: encodePlaced({
              ...placed,
              cwd: checkout.cwd,
              branch: checkout.branch,
              worktree: checkout.worktree,
            }),
            task: null,
          });
          return { cwd: checkout.cwd, branch: checkout.branch ?? "" };
        }).pipe(Effect.provideContext(bun), under);
      const unstopped = (runId: string, what: string) =>
        Effect.flatMap(set(STOP, runId), (stopped) =>
          stopped
            ? Effect.fail(new WorkflowError({ reason: `${runId} is stopped, so it ${what}` }))
            : Effect.void,
        );
      const issueCheckout = Effect.fn("Host.issueCheckout")(function* (
        runId: string,
        on?: "collie",
      ) {
        if (on === "collie") {
          const { env } = yield* placing;
          const reading = yield* connectionOnMachine({ ...env, cwd: env.home }, "github");
          if (reading.state !== "ok") {
            return yield* new WorkflowError({
              reason: `${reading.detail}. Fix: ${reading.fix}`,
            });
          }
          return {
            ok: true as const,
            forge: FORGES.github,
            project: COLLIE_REPOSITORY,
            cwd: env.home,
            env,
            collie: true,
          };
        }
        const row = yield* store.run(runId);
        if (row === null) {
          return yield* new WorkflowError({ reason: `there is no Run ${runId}` });
        }
        const launch = yield* decodeStrings(row.options ?? "{}").pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowError({ reason: `issue checkout could not be read: ${String(cause)}` }),
          ),
        );
        const cwd = placedOf(row, launch).cwd;
        const { env } = yield* placing;
        const defaults = yield* loadDefaults(options.userDir ?? env.userDir).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowError({
                reason: `issue configuration could not be read: ${String(cause)}`,
              }),
          ),
        );
        const here = yield* forgeHere(cwd, runShell, defaults.gitlabHost);
        if (!here.ok) {
          return yield* new WorkflowError({ reason: here.reason });
        }
        const reading = yield* connectionOnMachine({ ...env, cwd }, here.forge.name);
        if (reading.state !== "ok") {
          return yield* new WorkflowError({
            reason: `${reading.detail}. Fix: ${reading.fix}`,
          });
        }
        return { ...here, cwd, env, collie: false };
      });
      const issuePrivacyBudget = Duration.fromInputUnsafe(options.issuePrivacyBudget ?? "1 minute");
      const walks = yield* Cache.makeWith(
        (root: string) =>
          Effect.gen(function* () {
            const { env } = yield* placing;
            const roots = [root];
            // WARNING: checkouts made before the setting stay where herdr put them, so both directories are searched.
            for (const dir of [yield* worktreesDirectory(env), `${env.home}/.herdr/worktrees`]) {
              if (yield* fs.exists(dir)) {
                roots.push(dir);
              }
            }
            return yield* publicationCheckouts(roots);
          }).pipe(Effect.provideContext(bun)),
        { capacity: 4, timeToLive: (exit) => (Exit.isSuccess(exit) ? "2 minutes" : 0) },
      );
      const remotesOf = (checkout: string) =>
        Effect.gen(function* () {
          const remotes = yield* runShell("git", ["remote", "-v"], checkout);
          if (remotes.code !== 0) {
            return yield* new WorkflowError({
              reason: `issue privacy check could not read remotes: ${checkout}`,
            });
          }
          return Arr.flatMap(Str.split(remotes.stdout, "\n"), (line) => {
            const name = remoteOf(
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(Str.split(line, "\t")[1]), (present__) =>
                  pipe(present__, Str.replace(/\s+\((?:fetch|push)\)$/, "")),
                ),
              ) ?? "",
            );
            return name === null ? [] : [name];
          });
        });
      const inventoryOf = (root: string) =>
        Effect.gen(function* () {
          const walked = yield* Cache.get(walks, root);
          const known = yield* publicationCheckouts(
            [],
            [
              ...new Set(
                Arr.filter(
                  Arr.flatMap(yield* store.runs, (row) => {
                    const placed = placedOf(row, {});
                    return [row.project, placed.cwd, placed.worktree?.path ?? ""];
                  }),
                  (dir) => pipe(dir, Str.startsWith("/")),
                ),
              ),
            ],
          );
          const checkouts = yield* Effect.forEach(
            [...new Set([...walked.checkouts, ...known.checkouts])].sort(),
            (checkout) =>
              Effect.gen(function* () {
                const gitDir = yield* gitDirOf(checkout);
                return {
                  checkout,
                  canonical: yield* fs.realPath(checkout),
                  repository: gitDir !== null,
                  names: gitDir === null ? [] : yield* remotesOf(checkout),
                };
              }),
            { concurrency: 8 },
          );
          return { aliases: [...walked.aliases, ...known.aliases], checkouts };
        }).pipe(
          Effect.timeoutOrElse({
            duration: issuePrivacyBudget,
            orElse: () =>
              Effect.fail(
                new WorkflowError({
                  reason: `issue privacy check did not finish within ${Duration.format(issuePrivacyBudget)}`,
                }),
              ),
          }),
          Effect.provideContext(bun),
        );
      const checkIssueText = Effect.fn("Host.checkIssueText")(
        function* (here: Effect.Success<ReturnType<typeof issueCheckout>>, text: string) {
          const root = yield* projectsRoot({
            ...here.env,
            userDir: options.userDir ?? here.env.userDir,
          });
          const inventory = yield* inventoryOf(root.path);
          const expanded = yield* Effect.try(() => throughAliases(text, inventory.aliases));
          let own: string | null = null;
          if (!here.collie) {
            const common = yield* runShell(
              "git",
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              here.cwd,
            );
            if (common.code !== 0) {
              return yield* new WorkflowError({
                reason: "issue checkout's Git identity could not be read",
              });
            }
            own = yield* fs.realPath(pipe(common.stdout, Str.replace(/\n$/, "")));
          }
          const ownRemote = Arr.join(Str.split(here.project, "/").slice(1), "/");
          for (const { checkout, canonical, repository, names } of inventory.checkouts) {
            if (
              !(
                pipe(text, Str.includes(checkout)) ||
                pipe(expanded, Str.includes(canonical)) ||
                Arr.some(
                  names,
                  (name) =>
                    (name.project !== here.project &&
                      (pipe(text, Str.includes(name.project)) ||
                        pipe(text, Str.includes(pipe(name.project, Str.replace("/", ":")))))) ||
                    (name.path !== ownRemote && pipe(text, Str.includes(name.path))),
                )
              )
            ) {
              continue;
            }
            if (!repository) {
              return yield* new WorkflowError({
                reason: `issue text names another checkout: ${checkout}`,
              });
            }
            const shared = yield* runShell(
              "git",
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              canonical,
            );
            if (shared.code !== 0) {
              return yield* new WorkflowError({
                reason: `issue privacy check could not identify checkout: ${checkout}`,
              });
            }
            if ((yield* fs.realPath(pipe(shared.stdout, Str.replace(/\n$/, "")))) === own) {
              continue;
            }
            return yield* new WorkflowError({
              reason: `issue text names another checkout: ${checkout}`,
            });
          }
        },
        Effect.mapError((cause) =>
          isWorkflowError(cause)
            ? cause
            : new WorkflowError({ reason: `issue privacy check failed: ${String(cause)}` }),
        ),
      );
      const waitOn = (
        runId: string,
        wait:
          | { readonly on: string; readonly who: string | null }
          | { readonly repair: string; readonly cause: ParkCause }
          | null,
      ) =>
        Effect.gen(function* () {
          const before = yield* Schema.decodeUnknownEffect(AwaitingJson)(
            yield* runRecords.control(AWAITING, runId),
          ).pipe(Effect.option);
          const parked = (yield* runRecords.control(PARKED, runId)) !== null;
          if (wait === null) {
            if (Option.isSome(before)) {
              yield* runRecords.setControl(AWAITING, runId, null);
            }
            if (parked) {
              yield* host.parked(runId, null);
            } else if (Option.isSome(before)) {
              yield* store.announce;
            }
            return;
          }
          if ("repair" in wait) {
            return yield* host.parked(runId, wait.repair, wait.cause);
          }
          const awaiting = {
            on: wait.on,
            who: wait.who,
            since: Option.isSome(before) ? before.value.since : yield* nowIso,
          };
          const overdue = overdueLine(awaiting, yield* Clock.currentTimeMillis);
          if (
            Option.isNone(before) ||
            before.value.on !== awaiting.on ||
            before.value.who !== awaiting.who
          ) {
            yield* runRecords.setControl(
              AWAITING,
              runId,
              yield* Schema.encodeEffect(AwaitingJson)(awaiting).pipe(Effect.orDie),
            );
            if (overdue === null && !parked) {
              yield* store.announce;
            }
          }
          if (overdue !== null || parked) {
            yield* host.parked(runId, overdue);
          }
        }).pipe(Effect.orDie);
      const reviewRead = (asked: {
        readonly runId: string;
        readonly cwd: string;
        readonly proved: string;
        readonly seen: ReadonlyArray<string>;
        readonly returnConflicts?: boolean;
        readonly returnFailedCi?: boolean;
      }) =>
        Effect.gen(function* () {
          const mr = yield* mergeRequestOf(asked.runId);
          const ref = mr === null ? null : mrRefOf(mr);
          if (mr === null || ref === null) {
            return yield* new WorkflowError({
              reason: "this Run has recorded no merge request to read the review of",
            });
          }
          const read = yield* under(forgeOf(ref).readReview(ref, asked.cwd, runShell));
          if (read.ok && read.pipeline.state === "failed") {
            yield* under(
              rememberFailedCi(runDir(dir, asked.runId), {
                head: read.head,
                name: read.pipeline.name,
                mr,
                cwd: asked.cwd,
              }),
            ).pipe(Effect.orDie);
          }
          return { mr, ref, read, standing: standingOf(read, asked) };
        });
      const unrecorded = "this Run recorded no merge request to read deployments of";
      const recordedRef = (runId: string) =>
        Effect.map(mergeRequestOf(runId), (mr) => (mr === null ? null : mrRefOf(mr)));
      const readable = (asked: { readonly runId: string; readonly cwd: string }) =>
        Effect.gen(function* () {
          const { mr, ref, read } = yield* reviewRead({ ...asked, proved: "", seen: [] });
          if (!read.ok) {
            return yield* new WorkflowError({ reason: `${mr} could not be read: ${read.reason}` });
          }
          return { mr, ref, read };
        });
      const landingOf = (mr: string, cwd: string) =>
        under(
          Effect.gen(function* () {
            const ref = mrRefOf(mr);
            if (ref === null) {
              const returned: MrLanding = { _tag: "Unreadable" };
              return returned;
            }
            const read = yield* forgeOf(ref).readReview(ref, cwd, runShell);
            if (!read.ok) {
              const returned: MrLanding = { _tag: "Unreadable" };
              return returned;
            }
            if (read.state === "open") {
              const returned: MrLanding = { _tag: "Open" };
              return returned;
            }
            if (read.state === "closed") {
              const returned: MrLanding = { _tag: "Closed" };
              return returned;
            }
            const sha = read.merged?.sha ?? "";
            const branch = yield* defaultBase(runShell, cwd);
            if (sha === "" || branch === null) {
              const returned: MrLanding = { _tag: "Merged", onDefault: false };
              return returned;
            }
            yield* runShell("git", ["fetch", "-q", "origin", branch], cwd);
            const carried = yield* runShell(
              "git",
              ["merge-base", "--is-ancestor", sha, `origin/${branch}`],
              cwd,
            );
            const returned: MrLanding = { _tag: "Merged", onDefault: carried.code === 0 };
            return returned;
          }),
        );
      const prerequisitesRead = (asked: {
        readonly runId: string;
        readonly cwd: string;
        readonly ticket: string;
      }) =>
        Effect.gen(function* () {
          const text = yield* fs.readFileString(asked.ticket).pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowError({
                  reason: `the ticket ${asked.ticket} could not be read: ${cause.message}`,
                }),
            ),
          );
          const prerequisites = prerequisitesOf(text);
          if (prerequisites === null) {
            return {
              _tag: "Never",
              why: `the **Needs merged:** line of ${asked.ticket} cannot be read, so nothing it names can be waited on`,
            } satisfies PrerequisiteStanding;
          }
          if (prerequisites.length === 0) {
            return { _tag: "Landed" } satisfies PrerequisiteStanding;
          }
          const rows = yield* store.runs;
          const optionsOf = (run: string) =>
            decodeStrings(
              Option.getOrUndefined(Arr.findFirst(rows, (row) => row.run === run))?.options ?? "{}",
            ).pipe(
              Effect.orElseSucceed(() => {
                const returned: Record<string, string> = {};
                return returned;
              }),
            );
          const details = new Map<string, RunDetail>();
          for (const run of Arr.dedupe(
            Arr.flatMap(prerequisites, (one) => [one.run, ...descendantsOf(rows, one.run)]),
          )) {
            const options = yield* optionsOf(run);
            details.set(run, {
              repo: options.repo || ".",
              change: options.change || null,
              ended: (yield* set(STOP, run)) || (yield* runRecords.fact(run, TERMINAL)) !== null,
              mr: yield* mergeRequestOf(run),
            });
          }
          const repo = (yield* optionsOf(asked.runId)).repo || ".";
          const landings = new Map<string, MrLanding>();
          for (const prerequisite of prerequisites) {
            const mr = mergeRequestFor(prerequisite, repo, rows, details);
            if (mr !== null && !landings.has(mr)) {
              landings.set(mr, yield* landingOf(mr, asked.cwd));
            }
          }
          return judgePrerequisites({
            asking: { run: asked.runId, repo },
            prerequisites,
            rows,
            details,
            landings,
          });
        });
      const host = Host.of({
        reviewFix: (runId, target) =>
          under(
            reviewFacts(store, dir, runId, target, (ref, cwd) =>
              Effect.gen(function* () {
                const forge = forgeOf(ref);
                const panel = yield* forge.details(ref, cwd, runShell);
                if (panel._tag !== "Details") {
                  return null;
                }
                return {
                  mr: { ...panel, head: panel.head ?? "" },
                  me: yield* forge.login(cwd, runShell, ref.project),
                };
              }),
            ).pipe(Effect.provideContext(bun)),
          ),
        dir,
        build: manifest.version,
        report: () =>
          Effect.fail(
            new WorkflowError({ reason: "Run reporting requires the host's workflow registry" }),
          ),
        issues: (runId, which, on) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(runId, on);
              const listed = yield* here.forge.issues(here.project, here.cwd, runShell, which);
              if (!listed.ok) {
                return yield* new WorkflowError({ reason: listed.reason });
              }
              return listed.issues;
            }),
          ),
        requests: (runId) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(runId);
              const listed = yield* here.forge.requests(here.project, here.cwd);
              if (!listed.ok) {
                return yield* new WorkflowError({ reason: listed.reason });
              }
              return listed.issues;
            }),
          ),
        releases: (runId) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(runId);
              const listed = yield* runShell(
                "git",
                [
                  "for-each-ref",
                  "--sort=-creatordate",
                  "--count=50",
                  "--format=%(refname:short) %(creatordate:iso-strict)",
                  "refs/tags",
                ],
                here.cwd,
              );
              if (listed.code !== 0) {
                return yield* new WorkflowError({ reason: Str.trim(listed.stderr ?? "") });
              }
              return Arr.getSomes(
                Arr.map(Str.split(Str.trim(listed.stdout), "\n"), (line) => {
                  const [tag, at] = Str.split(line, " ");
                  return tag === undefined || tag === "" || at === undefined
                    ? Option.none()
                    : Option.some({ tag, at: isoAt(epochMs(at)) });
                }),
              );
            }),
          ),
        fileIssue: (asked) =>
          under(
            Effect.gen(function* () {
              yield* unstopped(asked.runId, "files no issue");
              const here = yield* issueCheckout(asked.runId, asked.on);
              yield* checkIssueText(here, `${asked.title}\n${asked.body}`);
              const title = redact(asked.title);
              const body = redact(asked.body);
              const refused = yield* publicRefusal(
                `${title}\n${body}`,
                Effect.succeed(here.project),
              );
              if (refused !== null) {
                return yield* new WorkflowError({ reason: refused });
              }
              const filed = yield* here.forge.fileIssue(
                here.project,
                title,
                body,
                here.cwd,
                runShell,
              );
              if (!filed.ok) {
                return yield* new WorkflowError({ reason: filed.reason });
              }
              return { number: filed.number, url: filed.url };
            }),
          ),
        commentIssue: (asked) =>
          under(
            Effect.gen(function* () {
              yield* unstopped(asked.runId, "comments on no issue");
              const here = yield* issueCheckout(asked.runId, asked.on);
              yield* checkIssueText(here, asked.body);
              const body = redact(asked.body);
              const refused = yield* publicRefusal(body, Effect.succeed(here.project));
              if (refused !== null) {
                return yield* new WorkflowError({ reason: refused });
              }
              const commented = yield* here.forge.commentIssue(
                here.project,
                asked.number,
                body,
                here.cwd,
                runShell,
              );
              if (!commented.ok) {
                return yield* new WorkflowError({ reason: commented.reason });
              }
            }),
          ),
        usage: () => options.readings ?? Effect.succeed([]),
        skill: (name) =>
          unsafePathComponent(name) !== null
            ? Effect.succeed(null)
            : placing.pipe(
                Effect.flatMap(({ env }) => skillDirs(env)),
                Effect.flatMap((dirs) => skillFile(dirs, name)),
                Effect.orElseSucceed(() => null),
                Effect.provideContext(bun),
              ),
        place: (runId) =>
          under(
            Effect.zipWith(
              store.run(runId).pipe(
                Effect.flatMap((row) =>
                  row === null
                    ? Effect.succeed(null)
                    : decodeStrings(row.options ?? "{}").pipe(
                        Effect.orElseSucceed(() => {
                          const returned: Record<string, string> = {};
                          return returned;
                        }),
                        Effect.flatMap((admitted) => optionsNow(dir, runId, admitted)),
                        Effect.map((options) => ({
                          options,
                          task: row.task,
                          placed: placedOf(row, options),
                          started: Option.getOrUndefined(decodePlacing(row.placing ?? ""))?.started,
                        })),
                      ),
                ),
                // WARNING: a Run with no row has no checkout; asking about one never started must leave nothing behind.
                Effect.tap((admitted) =>
                  admitted === null
                    ? Effect.void
                    : fs.makeDirectory(handoffsDir(runDir(dir, runId)), { recursive: true }),
                ),
                Effect.map((admitted) => ({
                  cwd: admitted?.placed.cwd ?? dir,
                  branch: admitted?.placed.branch ?? null,
                  dir: runDir(dir, runId),
                  options: admitted?.options ?? {},
                  task: admitted?.task ?? null,
                  workspace: admitted?.placed.workspace ?? null,
                  authority: authorityOf(admitted?.placed.worktree ?? null, admitted?.started),
                })),
                Effect.orElseSucceed(() => ({
                  cwd: dir,
                  branch: null,
                  dir: runDir(dir, runId),
                  options: {},
                  task: null,
                  workspace: null,
                  authority: authorityOf(null, undefined),
                })),
              ),
              Effect.zip(lineageOf(runId), featuresOf(runId)),
              (at, [lineage, features]) => ({ ...at, lineage, features }),
            ),
          ),
        reviewScope: (runId, source, outcome, risks) =>
          under(
            Effect.flatMap(store.run(runId), (row) =>
              reviewScope(
                row === null ? dir : workingPlace(row).cwd,
                runDir(dir, runId),
                source,
                outcome,
                risks,
              ),
            ),
          ),
        recordReview: (runId, scope, base, review) =>
          under(
            Effect.flatMap(store.run(runId), (row) =>
              recordReview(
                row === null ? dir : workingPlace(row).cwd,
                runDir(dir, runId),
                scope,
                base,
                review,
              ),
            ),
          ).pipe(Effect.orDie, Effect.andThen(store.announce)),
        recovery: (runId, parent, source) =>
          under(
            Effect.gen(function* () {
              const row = yield* store.run(runId);
              const why = yield* takePushed(row === null ? dir : workingPlace(row).cwd);
              if (why !== null) {
                return yield* new WorkflowError({ reason: why });
              }
              const facts = yield* recoveryFor(store, dir, runId, parent, source);
              const id = Str.split(parent, "/").at(-1) ?? parent;
              const from = yield* store.run(id);
              if (
                facts.implementation &&
                row !== null &&
                from !== null &&
                (row.parent === id || (row.task !== null && row.task === from.task))
              ) {
                yield* runRecords.put(runId, RECOVERY_PARENT, id);
              }
              return { ...facts, lineage: Arr.reverse(yield* recoveryLineage(id)) };
            }),
          ),
        reviewedBranch,
        checkoutReviewed,
        reviewedRefusal: (runId, failed, target) =>
          Effect.gen(function* () {
            if (!(yield* fs.exists(checkoutRefusedFile(runDir(dir, failed))).pipe(Effect.orDie))) {
              return null;
            }
            const starter = yield* store.run(runId);
            if (starter === null) {
              return `there is no Run ${runId}`;
            }
            const ref = readMrRef(target);
            return yield* refusedCheckout({
              dir,
              store,
              placing: yield* placing,
              starter,
              target: ref === null ? target : mrWords(ref).target,
              awaits: true,
            });
          }).pipe(Effect.provideContext(bun), under),
        held: (runId) => set(HOLD, runId),
        stopRequested: (runId) => set(STOP, runId),
        usageWait: (runId, wait) =>
          runRecords
            .setControl(
              USAGE,
              runId,
              wait === null
                ? null
                : flow(Schema.encodeResult(UsageWaitJson), Result.getOrThrow)(wait),
            )
            .pipe(Effect.andThen(store.announce)),
        step: (runId, note) =>
          Effect.gen(function* () {
            const where = runDir(dir, runId);
            if (note.kind === "enter") {
              if (
                Arr.some(
                  yield* readStepLines(where),
                  (one) => one.kind === "enter" && one.key === note.key,
                )
              ) {
                return;
              }
              const place =
                note.place === null
                  ? null
                  : "item" in note.place
                    ? note.place.item
                    : `Round ${note.place.round}`;
              const log = yield* appendLogLine(
                where,
                `── ${note.step.title}${place === null ? "" : ` · ${place}`} ──`,
              ).pipe(Effect.orDie);
              yield* noteStep(where, { ...note, log });
              if (note.place !== null && "round" in note.place && note.step.produces === "review") {
                yield* noteRound(
                  evidenceDir(dir, runId),
                  yield* nowIso,
                  note.key,
                  note.place.round,
                );
              }
              const pause = yield* reachPause(where, note.step.id);
              if (pause !== null) {
                yield* runRecords.setControl(
                  HOLD,
                  runId,
                  `Paused before ${note.step.title}, as ${pause.by} asked`,
                );
                yield* store.announce;
              }
              return;
            }
            const first =
              note.kind === "entry" &&
              note.cause === "restarted" &&
              !Arr.some(yield* readStepLines(where), (line) => line.kind === "entry");
            yield* noteStep(where, first ? { kind: "entry", cause: null } : note);
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(RunRecords, runRecords),
          ),
        checkpoint: (runId, checkpoint) =>
          Effect.flatMap(nowIso, (at) =>
            writeCheckpoint(runDir(dir, runId), { ...checkpoint, at }).pipe(
              Effect.andThen(
                noteSlice(evidenceDir(dir, runId), at, checkpoint.ticket, checkpoint.status),
              ),
            ),
          ).pipe(Effect.provideService(RunRecords, runRecords)),
        record: (runId, event) =>
          // WARNING: a replay writes its log again; the log records each run, not a deduplicated story.
          appendLog(runDir(dir, runId), event).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(RunRecords, runRecords),
            Effect.orDie,
          ),
        parked: (runId, why, cause = "unknown") => {
          const put = (control: string, text: string | null) =>
            runRecords.setControl(control, runId, text);
          return (
            why === null
              ? put(PARKED, null)
              : Effect.gen(function* () {
                  const before = Option.fromNullishOr(yield* runRecords.control(PARKED, runId));
                  const causeBefore = parkCauseOf(yield* runRecords.control(PARK_CAUSE, runId));
                  let info = yield* parkInfoOf(yield* runRecords.control(PARK_INFO, runId));
                  const legacy =
                    info?.cause === cause &&
                    info.id !== undefined &&
                    !Str.startsWith(`${cause}-`)(info.id)
                      ? [info.id]
                      : [];
                  if (Option.isNone(before) || causeBefore !== cause || info === null) {
                    const tree = yield* treeOf(yield* store.run(runId), runId, dir);
                    const id = parkIdentity(
                      runId,
                      cause,
                      yield* under(parkEvidence(dir, runId, tree.cwd, cause, why)).pipe(
                        Effect.provideContext(bun),
                      ),
                    );
                    info = { ...parkOf(cause), id, since: yield* nowIso };
                    yield* put(
                      PARK_INFO,
                      yield* Schema.encodeEffect(ParkJson)(info).pipe(Effect.orDie),
                    );
                  }
                  if (Option.getOrNull(before) === why && causeBefore === cause) {
                    yield* put(PARK_CAUSE, cause);
                    yield* put(PARKED, why);
                    return;
                  }
                  // WARNING: decided before the park shows; a resume arriving mid-call would be lost.
                  const recoveries = recoveriesIn(
                    yield* readMetrics(evidenceDir(dir, runId)).pipe(Effect.provideContext(bun)),
                  );
                  const park = parkWithRecovery(info, recoveries);
                  const healing = Arr.findFirst(recoveries, healInFlight);
                  const claims =
                    park.kind !== "rechecks" &&
                    healOwed([park.id!, ...legacy], recoveries) &&
                    // WARNING: a park its Heal caused again is that Heal's to settle.
                    !(healing._tag === "Some" && healing.value.cause === cause);
                  const passed = claims ? yield* passedOverHere(runId, cause, recoveries) : null;
                  yield* put(PARK_CAUSE, cause);
                  yield* put(PARKED, why);
                  yield* under(
                    Effect.gen(function* () {
                      yield* appendMetric(evidenceDir(dir, runId), {
                        at: yield* nowIso,
                        kind: "halt",
                        subject: "",
                        value: 0,
                        note: why,
                        cause,
                        build: manifest.version,
                        park: info.id,
                        since: info.since,
                      });
                    }),
                  );
                  if (!claims) {
                    return;
                  }
                  yield* under(
                    appendMetric(evidenceDir(dir, runId), {
                      at: yield* nowIso,
                      kind: "recovery",
                      subject: runId,
                      value: 0,
                      note: passed ?? why,
                      cause,
                      build: manifest.version,
                      action: "healed",
                      outcome: passed === null ? "claimed" : "skipped",
                      recoveryId: healRequest(runId, park.id!, healNth(park.id!, recoveries)),
                      park: park.id,
                      since: park.since,
                    }),
                  );
                  if (passed === null) {
                    return;
                  }
                  yield* notify(
                    runId,
                    "needs-you",
                    Arr.join([why, ...(park.history ?? [])], "\n"),
                    { key: `parked:${cause}` },
                  );
                })
          ).pipe(Effect.andThen(store.announce));
        },
        asking: (runId, question, asker) =>
          store
            .asking({
              run: runId,
              decision: question.name,
              prompt: question.prompt,
              options: question.options,
              asker,
              shortfall: question.shortfall,
              shipping: question.shipping,
            })
            .pipe(
              Effect.andThen(
                notify(runId, "needs-you", `${question.name}: ${question.prompt}`, {
                  key: `ask:${question.name}`,
                }),
              ),
            ),
        asked: (runId) =>
          Effect.gen(function* () {
            const rows = yield* store.asked(runId);
            const audit = yield* under(readAudit(runDir(dir, runId))).pipe(
              Effect.orElseSucceed(() => []),
            );
            return yield* askedQuestions(rows, audit);
          }),
        close: (runId, decision, value) =>
          store
            .settle({ run: runId, decision, value, request: `${runId}-${decision}-closed` })
            .pipe(Effect.asVoid),
        evidence: (runId, cwd) =>
          under(
            Effect.gen(function* () {
              const own = yield* treeOf(yield* store.run(runId), runId, dir);
              const lineage = yield* recoveryLineage(runId);
              const inherited = yield* inheritedEvidence(lineage, cwd, new Set(lineage));
              return yield* Effect.all({
                verifications: Effect.forEach(lineage, (from) =>
                  readVerifications(evidenceDir(dir, from)).pipe(
                    Effect.orElseSucceed(() => {
                      const returned: ReadonlyArray<Verification> = [];
                      return returned;
                    }),
                  ),
                ).pipe(
                  Effect.map((lines) =>
                    Arr.dedupeWith([...inherited, ...Arr.flatten(lines)], (a, b) => a.id === b.id),
                  ),
                ),
                final: fingerprint(cwd),
                commands: Effect.forEach(yield* approvedOf(dir, runId), (spec) =>
                  commandOf({ ...own, cwd }, spec),
                ),
                measurements: readMeasurements(evidenceDir(dir, runId)).pipe(
                  Effect.orElseSucceed(() => {
                    const returned: ReadonlyArray<Measurement> = [];
                    return returned;
                  }),
                ),
                mergeBase: Effect.map(defaultMergeBase(cwd), (found) =>
                  found.found ? found.base : null,
                ),
                content: contentOf(cwd),
              });
            }),
          ).pipe(Effect.orDie),
        verify: (asked) =>
          Effect.gen(function* () {
            const at = yield* CurrentStep;
            if (at !== null) {
              yield* noteStep(runDir(dir, asked.runId), {
                kind: "check",
                key: at.key,
                name: asked.name,
              }).pipe(Effect.provideService(RunRecords, runRecords));
            }
            return yield* check(asked, passAsked(asked));
          }),
        approved: (runId) => under(approvedOf(dir, runId)),
        config: (dotted) =>
          under(
            readConfig(options.userDir ?? dir).pipe(
              Effect.map((raw) => {
                const value = configValue(raw, dotted);
                return Schema.is(Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]))(
                  value,
                )
                  ? String(value)
                  : "";
              }),
              Effect.orElseSucceed(() => ""),
            ),
          ),
        connection: (id) =>
          Effect.gen(function* () {
            const { env } = yield* placing;
            const run = yield* Effect.serviceOption(Run);
            const cwd = Option.isSome(run) ? (yield* host.place(run.value.id)).cwd : env.cwd;
            return yield* under(connectionOnMachine({ ...env, cwd }, id, options.slack));
          }),
        shareForApproval: (asked) =>
          under(
            Effect.gen(function* () {
              const mr = yield* mergeRequestOf(asked.runId);
              const ref = mr === null ? null : mrRefOf(mr);
              if (mr === null || ref === null) {
                return { posted: false, why: "this Run recorded no merge request to share" };
              }
              const details = yield* forgeOf(ref).details(ref, asked.cwd, runShell);
              if (details._tag !== "Details") {
                return { posted: false, why: details.reason };
              }
              const title = redact(details.title);
              const refused = yield* publicRefusal(title, Effect.succeed(ref.project));
              if (refused !== null) {
                return { posted: false, why: refused };
              }
              const { env } = yield* placing;
              const slack = options.slack ?? slackApi;
              const api = slack(yield* slackUserToken(env, slack));
              const posted = yield* api.post(asked.channel, `<${mr}|${slackText(title)}>`);
              const link = yield* api.permalink(posted.channel, posted.ts).pipe(Effect.result);
              return link._tag === "Success"
                ? { posted: true, link: link.success }
                : { posted: true, why: `permalink missing: ${link.failure}` };
            }).pipe(
              Effect.orElseSucceed((reason) => ({
                posted: false,
                why: isText(reason) ? reason : "Slack approval post could not be completed",
              })),
            ),
          ),
        mr: (asked) =>
          under(
            Effect.gen(function* () {
              const { env } = yield* placing;
              const gitlabHost = (yield* loadDefaults(options.userDir ?? dir)).gitlabHost;
              const ref = asked.target === undefined ? null : parseMrTarget(asked.target);
              const here = yield* forgeHere(asked.cwd, runShell, gitlabHost);
              const provider =
                ref?.project != null ? forgeOfRef(ref) : here.ok ? here.forge.name : null;
              if (provider !== null) {
                const reading = yield* connectionOnMachine({ ...env, cwd: asked.cwd }, provider);
                if (reading.state !== "ok") {
                  return {
                    ok: false,
                    provider,
                    cause:
                      reading.state === "absent"
                        ? ("login-missing" as const)
                        : ("forge-unavailable" as const),
                    reason: `${reading.detail}. Fix: ${reading.fix}`,
                    assignee: "",
                    template: "",
                    issues: [],
                  };
                }
              }
              return yield* prepareMergeRequest(
                {
                  ...asked,
                  assignees: {
                    gitlab: configValue(
                      yield* readConfig(options.userDir ?? dir),
                      "gitlab.assignee",
                    ),
                    github: configValue(
                      yield* readConfig(options.userDir ?? dir),
                      "github.assignee",
                    ),
                  },
                  gitlabHost,
                },
                runShell,
              );
            }).pipe(
              Effect.orElseSucceed(() => ({
                ok: false,
                reason: "this checkout could not be read",
                assignee: "",
                template: "",
                issues: [],
              })),
            ),
          ),
        autoMerging: (cwd) =>
          under(
            Effect.gen(function* () {
              const { gitlabHost } = yield* loadDefaults(options.userDir ?? dir).pipe(
                Effect.mapError((cause) => `the configuration could not be read: ${cause.message}`),
              );
              return yield* autoMergingHere(cwd, runShell, gitlabHost);
            }).pipe(Effect.mapError((reason) => new WorkflowError({ reason }))),
          ),
        ciJob: (asked) =>
          under(
            Effect.gen(function* () {
              const spec = Option.getOrUndefined(
                Arr.findFirst(
                  yield* approvedOf(dir, asked.runId),
                  (one) => one.name === asked.name,
                ),
              );
              if (spec?.ci === undefined) {
                return {
                  unproved: `"${asked.name}" is not one of this Run's checks left to CI`,
                  state: null,
                  url: null,
                  log: null,
                };
              }
              const own = yield* treeOf(yield* store.run(asked.runId), asked.runId, dir);
              const stopped = untilStopped(asked.runId).pipe(
                Effect.as({
                  unproved: `${spec.name} is left to CI and unproved: the Run was stopped while job ${spec.ci} was read`,
                  state: null,
                  url: null,
                  log: null,
                }),
              );
              return yield* Effect.raceFirst(
                ciJob({
                  runId: asked.runId,
                  runDir: runDir(dir, asked.runId),
                  journal: evidenceDir(dir, asked.runId),
                  cwd: asked.cwd,
                  spec,
                  command: yield* commandOf({ ...own, cwd: asked.cwd }, spec),
                  mr: yield* mergeRequestOf(asked.runId),
                  wait: asked.wait ?? false,
                  settle: asked.settle ?? false,
                  verifying: controlOf(runRecords, VERIFYING, asked.runId),
                  run: runShell,
                }),
                stopped,
              );
            }),
          ).pipe(Effect.orDie),
        targetFailure: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = mrRefOf(yield* mergeRequestOf(asked.runId));
              if (ref === null) {
                return null;
              }
              return yield* sharedFailure(
                ref,
                yield* ciJobsOfIn(dir, asked.runId),
                asked.cwd,
                runShell,
              );
            }),
          ).pipe(Effect.orDie),
        takeTarget: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = mrRefOf(yield* mergeRequestOf(asked.runId));
              if (ref === null) {
                return { _tag: "Take" } as const;
              }
              return yield* takeTarget(
                ref,
                yield* ciJobsOfIn(dir, asked.runId),
                asked.head,
                asked.cwd,
                runShell,
              );
            }),
          ).pipe(Effect.orDie),
        startPipeline: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = mrRefOf(yield* mergeRequestOf(asked.runId));
              if (ref === null) {
                return { _tag: "Failed", reason: "this Run has no merge request" } as const;
              }
              const head = (yield* fingerprint(asked.cwd)).head_sha;
              if (head === "") {
                return { _tag: "Failed", reason: `${asked.cwd}'s HEAD could not be read` } as const;
              }
              return yield* forgeOf(ref).startPipeline(ref, head, asked.cwd, runShell);
            }),
          ).pipe(Effect.orDie),
        publish: (asked) =>
          under(
            Effect.gen(function* () {
              const place = yield* host.place(asked.runId);
              const cwd = place.cwd;
              const ready = yield* host.mr({ cwd, onto: asked.onto });
              const fail = (reason: string) => new WorkflowError({ reason });
              if (asked.skipCi && !asked.pushOnly) {
                return yield* fail("--skip-ci requires --push-only");
              }
              if (!asked.pushOnly && !asked.file) {
                return yield* fail("a merge request needs --file");
              }
              if (!ready.ok) {
                return yield* fail(ready.reason);
              }
              if (!ready.branch) {
                return yield* fail("a detached checkout cannot be published");
              }
              if (ready.autoMerge) {
                return yield* fail(
                  "this branch's merge request merges automatically; turn off auto-merge before publishing",
                );
              }
              const here = yield* forgeHere(
                cwd,
                runShell,
                (yield* loadDefaults(options.userDir ?? dir)).gitlabHost,
              );
              if (!here.ok) {
                return yield* fail(here.reason);
              }
              const path = yield* Path.Path;
              const file = asked.pushOnly
                ? ""
                : yield* fs
                    .readFileString(path.resolve(cwd, asked.file))
                    .pipe(Effect.mapError(() => fail(`there is no ${asked.file} to publish`)));
              const title = redact(asked.title);
              const body = redact(file);
              const existing = ready.existing ? mrRefOf(ready.existing) : null;
              const panel =
                existing === null ? null : yield* here.forge.details(existing, cwd, runShell);
              if (
                ready.existing &&
                (panel === null || panel._tag !== "Details" || !panel.targetBranch)
              ) {
                return yield* fail("the existing merge request's target branch could not be read");
              }
              const target =
                (panel?._tag === "Details" ? panel.targetBranch : asked.onto) ??
                Str.trim(
                  (yield* runShell(
                    "git",
                    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
                    cwd,
                  )).stdout,
                );
              if (!target) {
                return yield* fail("origin's default branch could not be read; name --onto");
              }
              const remote = `refs/remotes/origin/${target}`;
              const tracked = yield* runShell("git", ["rev-parse", "--verify", remote], cwd);
              const base = yield* runShell(
                "git",
                ["merge-base", "--", tracked.code === 0 ? remote : target, "HEAD"],
                cwd,
              );
              if (base.code !== 0 || !Str.trim(base.stdout)) {
                return yield* fail(whatItSaid(base) || `cannot find the merge base with ${target}`);
              }
              const commits = yield* runShell(
                "git",
                ["log", "--format=%h%x00%s%x00%B%x00", `${Str.trim(base.stdout)}..HEAD`],
                cwd,
              );
              if (commits.code !== 0) {
                return yield* fail(whatItSaid(commits));
              }
              const texts = [
                { where: "title", text: title },
                { where: ready.existing ? "note" : "description", text: body },
              ];
              const parts = Str.split(commits.stdout, "\0");
              for (let i = 0; i + 2 < parts.length; i += 3) {
                texts.push({
                  where: `commit ${Str.trim(parts[i]!)} ${parts[i + 1]}`,
                  text: parts[i + 2]!,
                });
              }
              const refused: Array<string> = [];
              for (const one of texts) {
                const reason = yield* publicRefusal(one.text, Effect.succeed(here.project));
                if (reason !== null) {
                  refused.push(`${one.where}: ${reason}`);
                }
              }
              if (refused.length) {
                return yield* fail(Arr.join(refused, "\n"));
              }
              if (!asked.pushOnly && !ready.existing && !Str.trim(title)) {
                return yield* fail("a new merge request needs --title");
              }
              const pushed = yield* runShell(
                "git",
                [
                  "push",
                  "-u",
                  "origin",
                  "HEAD",
                  ...(asked.skipCi && here.forge.name === "gitlab" ? ["-o", "ci.skip"] : []),
                ],
                cwd,
              );
              if (pushed.code !== 0) {
                return yield* fail(whatItSaid(pushed));
              }
              if (asked.pushOnly) {
                return { url: ready.existing ?? "" };
              }
              const marked = `${body}\n\n${marker(asked.runId)}`;
              if (ready.existing) {
                const ref = mrRefOf(ready.existing);
                if (ref === null) {
                  return yield* fail(`cannot read ${ready.existing}`);
                }
                const posted = yield* here.forge.post(ref, marked, cwd, runShell);
                if (!posted.ok) {
                  return yield* fail(posted.message);
                }
                return { url: ready.existing };
              }
              const opened = yield* here.forge.create(
                {
                  project: here.project,
                  branch: ready.branch,
                  title,
                  body: marked,
                  assignee: ready.assignee,
                  onto: asked.onto,
                },
                cwd,
                runShell,
              );
              if (!opened.ok) {
                return yield* fail(opened.reason);
              }
              return { url: opened.url };
            }).pipe(
              Effect.mapError((error) =>
                Schema.is(WorkflowError)(error)
                  ? error
                  : new WorkflowError({ reason: String(error) }),
              ),
            ),
          ),
        note: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = mrRefOf(yield* mergeRequestOf(asked.runId));
              if (ref === null) {
                return { ok: false, message: "this Run has no merge request" };
              }
              const body = redact(asked.body);
              const refused = yield* publicRefusal(body, Effect.succeed(ref.project));
              if (refused !== null) {
                return { ok: false, message: refused };
              }
              return yield* forgeOf(ref).post(ref, body, asked.cwd, runShell);
            }),
          ).pipe(Effect.orDie),
        claim: <E, R>(asked: {
          readonly runId: string;
          readonly cwd: string;
          readonly adopting: Effect.Effect<boolean, E, R>;
          readonly say: (line: string) => Effect.Effect<void, E, R>;
          readonly deploys?: {
            readonly applications: ReadonlyArray<string>;
            readonly jobs: ReadonlyArray<string>;
          };
          readonly free?: boolean;
        }) => {
          const returned: Effect.Effect<Sdk.Claimed, WorkflowError | E, R> = Effect.gen(
            function* () {
              const file = claimPath(dir, asked.runId);
              const held = yield* waitForHelle({
                ...(yield* helleWhere(asked.cwd, asked.deploys)),
                free: asked.free ?? false,
                claimed: yield* recordedClaims(file),
                record: (claim) =>
                  Effect.gen(function* () {
                    if (claim.claim === "adopted") {
                      const agents = yield* Effect.serviceOption(Agents);
                      const executions = yield* Effect.serviceOption(Executions);
                      const from = yield* handOverClaim({
                        dir,
                        slug: claim.slug,
                        to: asked.runId,
                        runs: Arr.map(yield* store.runs, (row) => row.run),
                        stop: (runId) =>
                          Option.isSome(executions)
                            ? executions.value.stop(runId)
                            : Effect.succeed({ runs: [runId], left: ["nothing here can stop it"] }),
                        halt: (runId) =>
                          Option.isSome(agents)
                            ? agents.value.halt(runId)
                            : Effect.succeed({
                                stopped: [],
                                left: ["nothing here can close them"],
                              }),
                        stopped: (runId) =>
                          Option.isSome(executions)
                            ? executions.value.stopped(runId)
                            : Effect.succeed(false),
                      });
                      for (const runId of from) {
                        yield* asked.say(`took the claim on ${claim.slug} over from ${runId}`);
                      }
                    }
                    yield* fs
                      .makeDirectory(runDir(dir, asked.runId), { recursive: true })
                      .pipe(
                        Effect.andThen(
                          updateClaims(file, (before) => [
                            ...Arr.filter(before, (one) => one.slug !== claim.slug),
                            claim,
                          ]),
                        ),
                        Effect.orDie,
                      );
                  }),
                forget: (slug) =>
                  updateClaims(file, (before) =>
                    Arr.filter(before, (one) => one.slug !== slug),
                  ).pipe(Effect.orDie),
                out: asked.say,
                ask: () => asked.adopting.pipe(Effect.map((yes) => (yes ? "yes" : null))),
                queued: (slug, position) =>
                  waitOn(asked.runId, {
                    on: `its turn for the Helle claim on ${slug}, at ${position} in its queue`,
                    who: "whoever holds it",
                  }),
                ended: () => waitOn(asked.runId, null),
              });
              if (held._tag === "None") {
                return { none: held.why };
              }
              if (held._tag === "Unresolved") {
                return { unresolved: held.why };
              }
              return held.left === undefined
                ? { slugs: held.slugs }
                : { slugs: held.slugs, left: held.left };
            },
          ).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideContext(services),
            // WARNING: a refusal by Helle means this Run cannot take the claim; the author's own failures pass through.
            Effect.mapError((cause: HelleError | E) =>
              cause instanceof HelleError ? new WorkflowError({ reason: cause.message }) : cause,
            ),
          );
          return returned;
        },
        holders: (asked) =>
          Effect.gen(function* () {
            return yield* helleHolders(yield* helleWhere(asked.cwd, asked.deploys));
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideContext(services),
            Effect.mapError((cause) => new WorkflowError({ reason: cause.message })),
          ),
        release: (runId) =>
          Effect.gen(function* () {
            const env = yield* currentEnv.pipe(Effect.orDie);
            const file = claimPath(dir, runId);
            const held = yield* recordedClaims(file);
            if (held.length === 0) {
              return [];
            }
            const creds = yield* credentials({
              home: env.home,
              envFile: env.raw.HELLE_ENV_FILE ?? null,
              url: helleUrlOf(env.raw),
            });
            // WARNING: a claim Helle refuses to give back stays recorded, for a later release to retry.
            const given = new Set<string>();
            for (const one of held) {
              const released = yield* releaseClaim(creds, one.slug).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.result,
              );
              if (released._tag === "Success") {
                given.add(one.slug);
              }
            }
            yield* updateClaims(file, (now) => Arr.filter(now, (one) => !given.has(one.slug)));
            return Arr.map(
              Arr.filter(held, (one) => !given.has(one.slug)),
              (one) => one.slug,
            );
          }).pipe(
            Effect.provideContext(services),
            Effect.catch(() =>
              recordedClaims(claimPath(dir, runId)).pipe(
                Effect.map((held) => Arr.map(held, (one) => one.slug)),
                Effect.provideContext(services),
              ),
            ),
          ),
        measure: (asked) =>
          under(
            Effect.gen(function* () {
              const own = yield* treeOf(yield* store.run(asked.runId), asked.runId, dir);
              if (!(yield* insideRun(asked.cwd, own))) {
                return yield* new WorkflowError({
                  reason: `"${asked.cwd}" is not inside run ${asked.runId}`,
                });
              }
              const env = yield* currentEnv.pipe(Effect.option);
              const answered = yield* measure({
                stateDir: dir,
                env: Option.isSome(env)
                  ? { ...env.value, userDir: options.userDir ?? env.value.userDir }
                  : null,
                ask: asked,
                evidence: evidenceDir(dir, asked.runId),
                awaiting: controlOf(runRecords, AWAITING, asked.runId),
                stopped: set(STOP, asked.runId),
              }).pipe(Effect.mapError((cause) => new WorkflowError({ reason: cause.why })));
              if (answered !== "stopped") {
                return answered;
              }
              const instance = yield* Effect.serviceOption(WorkflowEngine.WorkflowInstance);
              if (Option.isSome(instance)) {
                return yield* Workflow.suspend(instance.value);
              }
              return yield* new WorkflowError({
                reason: "the Measurement did not finish: the Run was stopped while it ran",
              });
            }),
          ),
        integrate: (runId, cwd) =>
          under(
            integrateDefault(runShell, cwd).pipe(
              Effect.tap((done) => {
                const line = integratedLine(done);
                return line === null ? Effect.void : appendLog(runDir(dir, runId), line);
              }),
              Effect.orDie,
            ),
          ),
        defaultHead: (cwd) =>
          under(runShell("git", ["ls-remote", "origin", "HEAD"], cwd)).pipe(
            Effect.flatMap((said) => {
              const sha = said.code === 0 ? (Str.split(Str.trim(said.stdout), /\s/)[0] ?? "") : "";
              return sha === ""
                ? Effect.fail(
                    new WorkflowError({
                      reason: `origin's default branch could not be read from ${cwd}: ${Str.trim(said.stderr ?? "")}`,
                    }),
                  )
                : Effect.succeed(sha);
            }),
          ),
        nothingToLand: (runId, cwd) =>
          under(
            Effect.gen(function* () {
              const git = (...args: Array<string>) => runShell("git", args, cwd);
              const found = yield* defaultMergeBase(cwd);
              if (!found.found) {
                return null;
              }
              const ahead = yield* git("rev-list", "--count", `${found.base}..HEAD`);
              if (ahead.code !== 0 || Str.trim(ahead.stdout) !== "0") {
                return null;
              }
              const status = yield* git("status", "--porcelain");
              if (status.code !== 0 || Str.trim(status.stdout) !== "") {
                return null;
              }
              const why = `nothing to land: no commits over ${pipe(found.base, Str.slice(0, 12))}, where this branch leaves ${found.branch}, and nothing uncommitted`;
              yield* runRecords.put(runId, NOTHING_TO_LAND, `${why}\n`);
              yield* appendLog(runDir(dir, runId), why);
              return why;
            }),
          ).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.orDie),
        findingStatuses: (where) =>
          under(
            Effect.map(findingsWithStatus(where), (ones) =>
              Arr.map(ones, (one) => ({ id: one.id, status: one.status, run: one.run })),
            ),
          ),
        merge: (asked) =>
          Effect.gen(function* () {
            return yield* land({
              runDir: runDir(dir, asked.runId),
              mr: yield* mergeRequestOf(asked.runId),
              head: asked.head,
              cwd: asked.cwd,
              run: runShell,
            });
          }).pipe(
            Effect.catchTag("PlatformError", (cause) => Effect.die(cause)),
            Effect.provideContext(services),
          ),
        review: (asked) => reviewRead(asked).pipe(Effect.map(({ standing }) => standing)),
        awaitReview: (asked) =>
          Effect.gen(function* () {
            const controlled = untilSet(asked.runId, HOLD, STOP).pipe(
              Effect.as({ _tag: "Held" } satisfies ReviewStanding),
            );
            const polled = Effect.gen(function* () {
              for (;;) {
                const { mr, read, standing } = yield* reviewRead(asked);
                const wait = reviewWaitOf(mr, read);
                if (standing._tag === "Conflicting" || standing._tag === "FailedCi") {
                  return standing;
                }
                if (asked.whileConflicting === true) {
                  const conflicting =
                    read.ok && read.state === "open" && conflictsWithTarget(read.mergeable);
                  if (!conflicting && standing._tag !== "Unreadable") {
                    return standing;
                  }
                } else {
                  if (standing._tag !== "Waiting" && standing._tag !== "Unreadable") {
                    return standing;
                  }
                  if (wait._tag === "Blocked" && asked.untilBlocked === true) {
                    return standing;
                  }
                }
                yield* waitOn(
                  asked.runId,
                  wait._tag === "Awaiting"
                    ? wait
                    : { repair: blockedLine(mr, wait.why), cause: wait.cause },
                );
                yield* Effect.sleep(options.reviewPoll ?? "5 minutes");
              }
            });
            const standing = yield* Effect.raceFirst(controlled, polled);
            yield* waitOn(asked.runId, null);
            return standing;
          }),
        watching: (asked) =>
          Effect.gen(function* () {
            const mr = mrId(asked.target);
            if (mr === null) {
              return yield* new WorkflowError({
                reason: `${asked.target} names no merge request the merge watch can read`,
              });
            }
            yield* store.watch({ run: asked.runId, mr, name: asked.name, cursor: asked.cursor });
            if (asked.asking === true) {
              return;
            }
            const slack = yield* reviewSlackTrouble(
              `${runDir(dir, asked.runId)}/${REVIEW_SLACK}`,
            ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
            yield* waitOn(asked.runId, {
              on: `${asked.author ?? THE_AUTHOR} to change ${mrLabel(asked.target)}${asked.approved === undefined ? "" : `, approved at ${Str.slice(0, 7)(asked.approved)}`}${slack === undefined ? "" : `. ${slack}`}`,
              who: THE_AUTHOR,
            });
          }),
        mrReading: (asked) =>
          Effect.gen(function* () {
            const ref = mrRefOf(asked.target);
            if (ref === null) {
              return yield* new WorkflowError({ reason: `${asked.target} is not a merge request` });
            }
            const panel = yield* reviewForge(forgeOf(ref).details(ref, asked.cwd, runShell));
            if (panel._tag !== "Details") {
              return yield* new WorkflowError({
                reason: `could not read ${mrLabel(asked.target)}: ${panel.reason}`,
              });
            }
            const read = readingOf(panel);
            const discussion = asked.replies
              ? yield* reviewForge(forgeOf(ref).readReview(ref, asked.cwd, runShell))
              : null;
            if (discussion !== null && !discussion.ok) {
              return yield* new WorkflowError({ reason: discussion.reason });
            }
            const replies = discussion?.ok
              ? Arr.map(
                  Arr.filter(discussion.comments, (one) => one.kind !== "system"),
                  (one) => ({
                    id: one.id,
                    author: one.author,
                    thread: one.thread,
                    body: one.body,
                    run: collieRunOf(one.body),
                  }),
                )
              : undefined;
            const reading = {
              state: discussion?.ok ? discussion.state : read.state,
              head: discussion?.ok ? discussion.head : read.head,
              author: panel.author,
              pipeline: read.pipeline,
              comments: Arr.map(replies ?? read.comments, (one) => one.id),
            };
            return replies === undefined ? reading : { ...reading, replies };
          }),
        approvedAt: (asked) =>
          Effect.gen(function* () {
            const ref = mrRefOf(asked.target);
            if (ref === null) {
              return yield* new WorkflowError({ reason: `${asked.target} is not a merge request` });
            }
            const forge = forgeOf(ref);
            const me = yield* reviewForge(forge.login(asked.cwd, runShell, ref.project));
            if (me === null) {
              return yield* new WorkflowError({
                reason: `the forge did not say who is logged in to read ${mrLabel(asked.target)}'s approval`,
              });
            }
            const read = yield* reviewForge(
              forge.approvedAt(ref, me, asked.head, asked.cwd, runShell),
            );
            if (!read.ok) {
              return yield* new WorkflowError({
                reason: `could not read ${mrLabel(asked.target)}'s approval: ${read.reason}`,
              });
            }
            return read.value;
          }),
        pinHead: (asked) =>
          Effect.gen(function* () {
            const ref = mrRefOf(asked.target);
            const row = yield* store.run(asked.runId);
            if (ref === null || row === null) {
              return { refused: `${asked.target} is not a merge request of a Run here` };
            }
            const { env } = yield* placing;
            const pinned = yield* pinnedCheckout({
              repo: row.project,
              worktrees: yield* worktreesDirectory(env),
              runId: asked.runId,
              forge: forgeOf(ref).name,
              project: ref.project,
              iid: ref.iid,
              head: asked.head,
              run: runShell,
            });
            if (pinned.refused !== undefined) {
              return { refused: pinned.refused };
            }
            if (pinned.moved !== undefined) {
              return { moved: pinned.moved };
            }
            const launch = yield* decodeStrings(row.options ?? "{}").pipe(
              Effect.orElseSucceed(() => {
                const returned: Record<string, string> = {};
                return returned;
              }),
            );
            const placed = placedOf(row, launch);
            yield* store.place(asked.runId, {
              checkout: encodePlaced({
                ...placed,
                cwd: pinned.cwd,
                branch: null,
                worktree: pinned.worktree,
              }),
              task: null,
            });
            return { cwd: pinned.cwd };
          }).pipe(Effect.provideContext(bun)),
        descends: (asked) =>
          Effect.gen(function* () {
            const ref = mrRefOf(asked.target);
            if (ref === null) {
              return yield* new WorkflowError({ reason: `${asked.target} is not a merge request` });
            }
            const read = yield* reviewForge(
              forgeOf(ref).descends(ref, asked.previous, asked.head, asked.cwd, runShell),
            );
            if (!read.ok) {
              return yield* new WorkflowError({
                reason: `could not read whether ${asked.head} descends from ${asked.previous}: ${read.reason}`,
              });
            }
            return read.value;
          }),
        prerequisites: prerequisitesRead,
        awaitPrerequisites: (asked) =>
          Effect.gen(function* () {
            const controlled = untilSet(asked.runId, HOLD, STOP).pipe(
              Effect.as({ _tag: "Held" } satisfies PrerequisiteStanding),
            );
            const polled = Effect.gen(function* () {
              for (;;) {
                const standing = yield* prerequisitesRead(asked);
                if (standing._tag !== "Waiting") {
                  return standing;
                }
                yield* waitOn(asked.runId, standing);
                yield* Effect.sleep(options.reviewPoll ?? "5 minutes");
              }
            });
            const standing: PrerequisiteStanding = yield* Effect.raceFirst(controlled, polled);
            yield* waitOn(asked.runId, null);
            return standing;
          }),
        reply: (asked) =>
          Effect.gen(function* () {
            const { mr, ref, read } = yield* readable(asked);
            const comment = Option.getOrUndefined(
              Arr.findFirst(read.comments, (one) => one.id === asked.comment),
            );
            if (comment === undefined) {
              return yield* new WorkflowError({
                reason: `${mr} has no comment ${asked.comment} to reply to`,
              });
            }
            const signature = marker(asked.runId);
            const record = (body: string, at: string) =>
              under(
                recordReply(runDir(dir, asked.runId), {
                  at,
                  mr,
                  comment: comment.url,
                  ...(asked.kind !== undefined && { kind: asked.kind }),
                  body,
                }),
              ).pipe(Effect.orDie);
            if (comment.answered) {
              const others = Arr.filter(read.comments, (one) => one !== comment);
              const posted = Option.getOrUndefined(
                Arr.findFirst(
                  read.comments.slice(read.comments.indexOf(comment) + 1),
                  (one) =>
                    one.author === read.login &&
                    pipe(one.body, Str.includes(signature)) &&
                    (links(one.body, comment.url) ||
                      (comment.thread !== null &&
                        one.thread === comment.thread &&
                        !Arr.some(others, (other) => links(one.body, other.url)))),
                ),
              );
              const recorded = yield* under(readReplies(runDir(dir, asked.runId))).pipe(
                Effect.orDie,
              );
              if (
                posted !== undefined &&
                !Arr.some(recorded, (one) => one.comment === comment.url)
              ) {
                yield* record(posted.body, posted.at);
              }
              return "already" as const;
            }
            const said = redact(asked.body);
            const refused = yield* publicRefusal(said, Effect.succeed(ref.project));
            if (refused !== null) {
              return yield* new WorkflowError({ reason: refused });
            }
            const body = `${said}\n\n${signature}`;
            const replied = yield* under(
              forgeOf(ref).reply(ref, comment, body, asked.cwd, runShell),
            );
            if (!replied.ok) {
              return yield* new WorkflowError({
                reason: `the forge refused the reply to ${comment.url}: ${replied.reason}`,
              });
            }
            yield* record(body, yield* nowIso);
            return "posted" as const;
          }),
        reviewHead: (asked) =>
          Effect.gen(function* () {
            const { read } = yield* readable(asked);
            const carries = yield* under(
              carried({ cwd: asked.cwd, head: read.head, commits: asked.commits, run: runShell }),
            );
            return {
              head: read.head,
              carries,
              open: Arr.map(
                Arr.filter(read.comments, (one) => one.external && !one.answered),
                (one) => one.id,
              ),
            };
          }),
        fastForward: (asked) =>
          Effect.gen(function* () {
            if ((yield* waitingForAgents(asked.runId, asked.cwd)) === "stopped") {
              return yield* new WorkflowError({
                reason: `the checkout at ${asked.cwd} was not read: the Run was stopped while its agent was working there`,
              });
            }
            return yield* under(
              fastForward({
                runDir: runDir(dir, asked.runId),
                cwd: asked.cwd,
                head: asked.head,
                branch: asked.branch,
                createdByCollie: yield* madeByCollie(asked.cwd),
                run: runShell,
              }),
            );
          }).pipe(Effect.orDie),
        readTag: (asked) =>
          Effect.gen(function* () {
            const read = yield* under(
              readTag({
                cwd: asked.cwd,
                tag: asked.tag,
                merged: asked.merged,
                pipeline: asked.pipeline,
                proves: asked.proves,
                ref: yield* recordedRef(asked.runId),
                stage: asked.stage ?? [],
                production: asked.production ?? [],
                run: runShell,
              }),
            );
            if (asked.proves === "staged") {
              yield* under(
                writeStageProof(runDir(dir, asked.runId), {
                  head: asked.merged,
                  tag: asked.tag,
                  proved: read._tag === "Proved" || read._tag === "InProduction",
                  why: "why" in read ? read.why : null,
                }),
              );
            }
            return read;
          }),
        readMergeRequest: (asked) => {
          const ref = readMrRef(asked.mr);
          return ref === null
            ? Effect.succeed({
                _tag: "Unreadable",
                why: `${asked.mr} is not a merge request`,
              } satisfies MergeRequestRead)
            : Effect.gen(function* () {
                let read: MergeRequestRead = yield* under(
                  readMergeRequest({ ref, cwd: asked.cwd, run: runShell }),
                );
                if (
                  read._tag === "Read" &&
                  asked.checkout === true &&
                  ref.project !== null &&
                  (yield* under(projectHere(asked.cwd, runShell))) !== ref.project
                ) {
                  const { env } = yield* placing;
                  const found = yield* under(
                    repositoryCheckout({ ...env, cwd: asked.cwd }, `https://${ref.project}`),
                  ).pipe(Effect.orDie);
                  if (found !== null && "path" in found) {
                    read = { ...read, checkout: found.path };
                  }
                }
                const id = mrId(asked.mr);
                const wave =
                  read._tag === "Read" && id !== null ? yield* planWaveOf(id) : undefined;
                return wave === undefined ? read : { ...read, wave };
              });
        },
        readProduction: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            if (ref === null) {
              return { _tag: "Unproved", why: unrecorded } satisfies ProductionRead;
            }
            return yield* under(readProduction({ ...asked, ref, run: runShell }));
          }),
        readStage: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            const read: StageRead =
              ref === null
                ? { _tag: "Failed", why: unrecorded }
                : yield* under(readStage({ ...asked, ref, run: runShell }));
            yield* under(
              writeStageProof(runDir(dir, asked.runId), {
                head: asked.head,
                tag: null,
                proved: read._tag === "Staged",
                why: "why" in read ? read.why : read._tag === "Moved" ? "stage head moved" : null,
              }),
            );
            return read;
          }),
        readRollback: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            if (ref === null) {
              return { _tag: "Unshown", why: unrecorded } satisfies RollbackRead;
            }
            return yield* under(readRollback({ ...asked, ref, run: runShell }));
          }),
        takeOverLanding: () =>
          Effect.fail(
            new WorkflowError({
              reason: "Taking a landing over requires the host's workflow registry",
            }),
          ),
        awaitProduction: (asked) =>
          Effect.gen(function* () {
            const short = pipe(asked.sha, Str.slice(0, 8));
            const plays = Arr.map(
              asked.jobs,
              (job) => `\`${job.name}\` at ${job.url ?? asked.url}`,
            );
            const held = asked.slug === undefined ? null : `The claim on \`${asked.slug}\` is held`;
            const awaited =
              plays.length > 0 && asked.played !== true
                ? null
                : waitOn(asked.runId, {
                    on: `production to carry \`${short}\` of ${asked.url}${plays.length === 0 ? "" : `, from ${Arr.join(plays, ", ")}`}${asked.slug === undefined ? "" : `, holding the claim on \`${asked.slug}\``}`,
                    who: null,
                  });
            yield* (
              awaited ??
                host.parked(
                  asked.runId,
                  `Waiting for production: play ${Arr.join(plays, ", ")}. ${held ?? "The Run waits"} until the forge shows production carries \`${short}\`.`,
                )
            );
            const { gitlabHost } = yield* loadDefaults(options.userDir ?? dir).pipe(
              Effect.orElseSucceed(() => ({ gitlabHost: undefined })),
            );
            const controlled = untilSet(asked.runId, HOLD, STOP).pipe(Effect.as(false));
            const carried = Effect.gen(function* () {
              while (!(yield* productionCarries(asked.cwd, asked.sha, runShell, gitlabHost))) {
                if (awaited !== null) {
                  yield* awaited;
                }
                yield* Effect.sleep(options.productionPoll ?? "5 minutes");
              }
              return true;
            });
            const carries = yield* Effect.raceFirst(controlled, carried);
            yield* waitOn(asked.runId, null);
            return carries;
          }).pipe(Effect.provideContext(services)),
        mergeRequest: (runId, url) =>
          runRecords.put(runId, MERGE_REQUEST, `${url}\n`).pipe(
            Effect.andThen(store.announce),
            Effect.orDie,
            Effect.andThen(
              notify(runId, "mr-opened", url, {
                key: url,
                subject: openedSubject(url),
              }),
            ),
          ),
        post: (asked) =>
          reviewForge(
            fs.readFileString(asked.file).pipe(
              Effect.map(redact),
              Effect.flatMap((body) =>
                Effect.flatMap(loadDefaults(options.userDir ?? dir), (defaults) =>
                  Effect.gen(function* () {
                    const refused = yield* publicRefusal(
                      body,
                      Effect.suspend(() => {
                        const project = parseMrTarget(asked.target)?.project ?? null;
                        return project !== null
                          ? Effect.succeed(project)
                          : Effect.map(
                              forgeHere(asked.cwd, runShell, defaults.gitlabHost),
                              (here) => (here.ok ? here.project : null),
                            );
                      }),
                    );
                    if (refused !== null) {
                      return { ok: false, message: refused };
                    }
                    return yield* postNote(
                      {
                        target: asked.target,
                        cwd: asked.cwd,
                        body,
                        review: { runId: asked.runId, head: asked.head, round: asked.round },
                        gitlabHost: defaults.gitlabHost,
                      },
                      runShell,
                    );
                  }),
                ),
              ),
              Effect.orElseSucceed(() => ({
                ok: false,
                message: `there is no ${asked.file} to post`,
              })),
            ),
          ),
        slackTarget: (link, target) =>
          under(
            Effect.gen(function* () {
              const { env } = yield* placing;
              const slack = options.slack ?? slackApi;
              const api = slack(yield* slackUserToken(env, slack));
              return yield* targetFromSlack(link, api, target);
            }),
          ).pipe(Effect.mapError((reason) => new WorkflowError({ reason }))),
        reviewSlack: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = readMrRef(asked.target);
              if (ref?.project == null) {
                return "no Slack message found";
              }
              const forge = forgeOf(ref);
              const details = yield* forge.details(ref, asked.cwd, runShell);
              if (details._tag !== "Details") {
                return `Slack reactions deferred: ${details.reason}`;
              }
              if (!["open", "opened", "draft"].includes(details.state)) {
                return `no Slack reactions: merge request is ${details.state}`;
              }
              const { env } = yield* placing;
              const slack = options.slack ?? slackApi;
              const file = `${runDir(dir, asked.runId)}/${REVIEW_SLACK}`;
              const project = ref.project;
              const created = under(
                Effect.gen(function* () {
                  const branches = yield* forge.fromBranch(
                    project,
                    details.sourceBranch,
                    asked.cwd,
                    runShell,
                  );
                  if (!branches.ok) {
                    return yield* Effect.fail(branches.reason);
                  }
                  const created = Option.getOrUndefined(
                    Arr.findFirst(branches.mrs, (one) => one.iid === ref.iid),
                  )?.created;
                  if (!created || epochMs(created) <= 0) {
                    return yield* Effect.fail(
                      "the forge did not report when this merge request was created",
                    );
                  }
                  return created;
                }),
              );
              return yield* reconcileReviewSlack({
                file,
                url: details.url,
                created,
                permalink: asked.permalink,
                wanted: asked.wanted,
                api: slackUserToken(env, slack).pipe(Effect.map(slack)),
              });
            }),
          ),
        reviewedHead: (asked) =>
          reviewForge(
            Effect.gen(function* () {
              const ref = parseMrTarget(asked.target);
              if (ref === null) {
                return yield* localHead(asked.target, asked.cwd);
              }
              const details = yield* forgeOf(ref).details(ref, asked.cwd, runShell);
              return details._tag === "Details" ? (details.head ?? "") : "";
            }),
          ),
        reviewChanges: (asked) =>
          reviewForge(
            Effect.gen(function* () {
              const ref = parseMrTarget(asked.target);
              if (ref === null) {
                return yield* localChanges(asked.cwd, asked.previous, asked.head, asked.base ?? "");
              }
              const changes = yield* forgeOf(ref).reviewChanges(
                ref,
                asked.previous,
                asked.head,
                asked.cwd,
                runShell,
              );
              if (!changes.ok) {
                return yield* new WorkflowError({ reason: changes.reason });
              }
              return changes.value;
            }),
          ),
        approveReview: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = parseMrTarget(asked.target);
              if (ref === null) {
                return { ok: false, message: `${asked.target} is not a merge request` };
              }
              const marker = `${runDir(dir, asked.runId)}/approval-${asked.attempt}.attempt`;
              const claimed = yield* fs
                .writeFileString(marker, `${asked.target}\n${asked.head}\n`, { flag: "wx" })
                .pipe(
                  Effect.as(true),
                  Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
                  Effect.orDie,
                );
              if (!claimed) {
                return {
                  ok: false,
                  message: `approval outcome is uncertain for ${asked.target} at ${asked.head}: an earlier attempt exists for ${asked.attempt}; approval or dismissal may already have applied; inspect the forge before starting another review`,
                };
              }
              const approved = yield* forgeOf(ref).approve(ref, asked.head, asked.cwd, runShell);
              if (approved.retryable) {
                yield* fs.remove(marker).pipe(Effect.orDie);
                yield* parkReview(approved.message);
              }
              return approved;
            }),
          ),
      });
      let herdSocket = options.herd?.socketPath ?? null;
      let locatedAt = Number.NEGATIVE_INFINITY;
      const hostHerd = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (
          herdSocket === null &&
          options.herd?.locate !== undefined &&
          now - locatedAt >= 60_000
        ) {
          locatedAt = now;
          herdSocket = yield* options.herd.locate.pipe(Effect.provideContext(bun));
        }
        return yield* herdOf(herdSocket).pipe(
          Effect.provideContext(bun),
          Effect.orElseSucceed(() => null),
        );
      });
      const checkoutOf = (row: RunRow | null) =>
        Effect.gen(function* () {
          const placed =
            row === null
              ? null
              : placedOf(
                  row,
                  yield* decodeStrings(row.options ?? "{}").pipe(
                    Effect.orElseSucceed(() => {
                      const returned: Record<string, string> = {};
                      return returned;
                    }),
                  ),
                );
          const worktree = placed?.worktree?.path ?? null;
          return { worktree, cwd: worktree ?? placed?.cwd ?? dir };
        });
      const planWaveOf = (id: string) =>
        Effect.gen(function* () {
          const rows = yield* store.runs;
          for (const row of rows) {
            if (row.parent === null) {
              continue;
            }
            const opened = yield* mergeRequestOf(row.run);
            if (opened === null || mrId(opened) !== id) {
              continue;
            }
            const options = yield* decodeStrings(row.options ?? "{}").pipe(
              Effect.orElseSucceed(() => {
                const returned: Record<string, string> = {};
                return returned;
              }),
            );
            const parent = Arr.findFirst(rows, (one) => one.run === row.parent);
            if ((options.repo ?? "") === "" || Option.isNone(parent)) {
              return undefined;
            }
            const given = yield* decodeInput(parent.value.input).pipe(
              Effect.orElseSucceed(() => {
                const returned: Readonly<Record<string, Schema.Json>> = {};
                return returned;
              }),
            );
            const root = (yield* checkoutOf(parent.value)).cwd;
            for (const value of Rec.values(given)) {
              if (!isText(value)) {
                continue;
              }
              const source = yield* classifyWorkSource(value).pipe(
                Effect.orElseSucceed(() => null),
              );
              if (source?.kind !== "plan-dir") {
                continue;
              }
              const plan = yield* planReposOf(source.value, root).pipe(
                Effect.orElseSucceed(() => null),
              );
              const key = changeKey({ path: options.repo!, change: options.change });
              const at =
                plan === null || plan.refusal !== null
                  ? -1
                  : Arr.findFirstIndex(plan.waves, (wave) => wave.includes(key)).pipe(
                      Option.getOrElse(() => -1),
                    );
              return at < 0 ? undefined : { plan: parent.value.run, at };
            }
            return undefined;
          }
          return undefined;
        }).pipe(Effect.provideContext(bun));
      const watched = (runId: string) => {
        const returned: Effect.Effect<Watched> = Effect.gen(function* () {
          const row = yield* store.run(runId);
          const task =
            row?.task == null
              ? null
              : yield* readTask(row.task).pipe(
                  Effect.provideContext(bun),
                  Effect.orElseSucceed(() => null),
                );
          const { worktree, cwd } = yield* checkoutOf(row);
          return {
            runId,
            stateDir: dir,
            runDir: runDir(dir, runId),
            evidenceDir: evidenceDir(dir, runId),
            agentsDir: `${dir}/agents/${runId}`,
            cwd,
            worktree,
            mr: yield* mergeRequestOf(runId),
            asking: Arr.some(yield* store.asked(runId), isUnanswered),
            held: yield* set(HOLD, runId),
            family:
              row === null
                ? [runId]
                : yield* familyOf(yield* store.runs, row, (id) => runDir(dir, id)).pipe(
                    Effect.provideContext(bun),
                  ),
            dirOf: (id: string) => runDir(dir, id),
            cwdOf: (id: string) =>
              store.run(id).pipe(
                Effect.flatMap(checkoutOf),
                Effect.map((one) => one.cwd),
              ),
            herd: task?.herd ?? (yield* hostHerd),
          };
        });
        return returned;
      };
      const told = (runId: string, cards: ReadonlyArray<Card>) =>
        Effect.forEach(cards, (card) =>
          card.significance === "try-it"
            ? notify(runId, "slice-ready", card.readiness, { key: card.id })
            : Effect.void,
        );
      const judging = (at: Watched) =>
        Effect.gen(function* () {
          if (options.herd === undefined || at.herd === null) {
            return null;
          }
          const built = yield* evaluationDeps({ ...options.herd, herdKey: at.herd });
          return {
            evaluator: built.evaluator,
            budgetFile: yield* budgetPath(dir, built.herdKey),
            limits: built.limits,
            newId: SecureRandom.SecureRandom.pipe(Effect.flatMap((one) => one.uuidV4())),
            log: (line: string) => said(at, line).pipe(Effect.provideContext(services)),
          } satisfies JudgementDeps;
        }).pipe(Effect.orElseSucceed(() => null));
      const drift: Oversight["Service"]["drift"] = (runId, where, judged) =>
        Effect.gen(function* () {
          const at = yield* watched(runId);
          const deps =
            judged === "none" ? null : yield* judging(at).pipe(Effect.provideContext(bun));
          // WARNING: corrections go through the caller's own agents, never at the finish, where no next work exists.
          const agents = yield* Effect.serviceOption(Agents);
          const atWork =
            Option.isNone(agents) || judged === "finish" ? null : yield* agents.value.atWork(runId);
          const to =
            Option.isNone(agents) || atWork === null
              ? null
              : {
                  agent: atWork,
                  send: (correction: Parameters<Correcting["send"]>[0]) =>
                    agents.value.correct(runId, correction),
                };
          const done = yield* checkDrift(at, where, judged, deps, to).pipe(
            Effect.provideContext(bun),
          );
          // WARNING: the finish stands the cross-run check, writing an unanswered one down as owed.
          if (judged !== "none") {
            yield* standForElection(at, where, judged === "finish", deps).pipe(
              Effect.provideContext(bun),
            );
          }
          for (const constraint of done.sent) {
            yield* notify(runId, "correction-sent", constraint, {
              key: `correction:${constraint}`,
              subject: constraint,
            });
          }
          for (const constraint of done.escalated) {
            yield* notify(runId, "drift-unresolved", constraint, {
              key: `escalated:${constraint}`,
              subject: constraint,
            });
          }
        }).pipe(Effect.ignore({ log: "Unhandled" }));
      const oversight = Oversight.of({
        card: (runId, what) =>
          watched(runId).pipe(
            Effect.flatMap((at) => under(writeCard(at, what))),
            Effect.flatMap((card) => told(runId, [card])),
            Effect.ignore({ log: "Unhandled" }),
          ),
        checkpoints: (runId, step) =>
          watched(runId).pipe(
            Effect.flatMap((at) => under(cardCheckpoints(at, step))),
            Effect.flatMap((cards) => told(runId, cards)),
            Effect.ignore({ log: "Unhandled" }),
          ),
        drift,
        finish: (runId) =>
          Effect.gen(function* () {
            const at = yield* watched(runId);
            // WARNING: bounded, or a hung approved command holds the Run's ending forever.
            for (const name of yield* under(grantedToRun(at))) {
              const outcome = yield* check({ runId, name, cwd: at.cwd }, { pass: "finish" }).pipe(
                Effect.map((one) => `${one.result} (exit ${one.exit})`),
                Effect.catch((cause) => Effect.succeed(`refused — ${cause.reason}`)),
                Effect.timeoutOption(Duration.minutes(10)),
              );
              yield* under(
                said(
                  at,
                  `verification ${name}: ${Option.getOrElse(outcome, () => "gave up after 10 minutes")}`,
                ),
              );
            }
            yield* drift(runId, "finish", "finish");
            const settled = yield* watched(runId);
            const proposed = yield* settleAtFinish(settled).pipe(Effect.provideContext(bun));
            if (proposed !== null) {
              yield* notify(runId, "proposal-pending", `a follow-up for what is still blocking`, {
                key: proposed,
              });
            }
            const card = yield* under(
              writeCard(settled, { kind: "final", step: "finish", claims: [] }),
            );
            yield* told(runId, [card]);
            // WARNING: at the finish only, the last moment an owed cross-run check can be reported.
            if (card.cross_run === "pending") {
              yield* notify(runId, "drift-unresolved", "cross_run_pending", { key: "cross_run" });
            }
          }).pipe(Effect.ignore({ log: "Unhandled" })),
      });
      const relied: Reliance["Service"]["relied"] = (runId, command) =>
        under(
          Effect.gen(function* () {
            const own = yield* treeOf(yield* store.run(runId), runId, dir);
            const executable = yield* resolveExecutable(command.executable, command.cwd);
            if (executable === null) {
              return null;
            }
            for (const spec of yield* approvedOf(dir, runId)) {
              if (!ranCommand({ ...command, executable }, yield* commandOf(own, spec))) {
                continue;
              }
              const found = yield* recordFor(evidenceDir(dir, runId), own, spec, hostStarted);
              yield* appendLog(
                runDir(dir, runId),
                found.record === null
                  ? `check: ${spec.name} not answered: ${missSaid(found.miss)}`
                  : `check: ${spec.name} answered by verification ${found.record.id}`,
              ).pipe(Effect.orDie);
              return { check: spec.name, ...found };
            }
            return null;
          }),
        ).pipe(Effect.orElseSucceed(() => null));
      const missed: Reuse = { record: null, miss: { reason: "none" } };
      const recorded: Reliance["Service"]["recorded"] = (runId, command) =>
        under(
          Effect.gen(function* () {
            const executable = yield* resolveExecutable(command.executable, command.cwd);
            if (executable === null) {
              return missed;
            }
            const found = yield* recordedFor(
              evidenceDir(dir, runId),
              { ...command, executable },
              hostStarted,
            );
            yield* appendLog(
              runDir(dir, runId),
              found.record === null
                ? `verify: ${command.name} runs: ${missSaid(found.miss)}`
                : `verify: ${command.name} answered by verification ${found.record.id}`,
            ).pipe(Effect.orDie);
            return found;
          }),
        ).pipe(Effect.orElseSucceed(() => missed));
      return Context.make(Host, host).pipe(
        Context.add(Notifier, Notifier.of({ notify })),
        Context.add(Oversight, oversight),
        Context.add(Reliance, Reliance.of({ relied, recorded })),
      );
    }),
  );

export type Toast = (
  title: string,
  body: string,
  sound: Sound,
  runId: string,
) => Effect.Effect<void>;

export interface Herd {
  readonly socketPath: string | null;
  readonly pluginRoot: string;
  readonly locate?: Effect.Effect<string | null, never, PlatformServices>;
}

// WARNING: each load mints a new name, so a Run recovers under the name it started on.
export const nextRegistrationName: (
  known: ReadonlyArray<{ readonly workflow: string }>,
  id: string,
) => string = (known, id) =>
  `${id}@${Arr.filter(known, (entry) => entry.workflow === id).length + 1}`;

const untilStopped = (registration: Registration, executionId: string) =>
  WorkflowEngine.WorkflowEngine.pipe(
    Effect.flatMap((engine) => engine.poll(registration.workflow, executionId)),
    Effect.repeat({ until: Option.isSome, schedule: Schedule.spaced(WAKE_INTERVAL) }),
    Effect.asVoid,
  );

const wokeText = flow(Schema.encodeResult(Schema.fromJsonString(Woke)), Result.getOrThrow);

// WARNING: a Run may wake before reading its answer; the wake resumes whatever park it reaches next.
export const answerDecision: (
  registration: Registration,
  options: { readonly name: string; readonly executionId: string; readonly value: string },
) => Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> = (registration, options) => {
  const decision = DurableDeferred.make(options.name, { success: Schema.String });
  const token = DurableDeferred.tokenFromExecutionId(decision, {
    workflow: registration.workflow,
    executionId: options.executionId,
  });
  return untilStopped(registration, options.executionId).pipe(
    Effect.andThen(DurableDeferred.done(decision, { token, exit: Exit.succeed(options.value) })),
  );
};

// WARNING: a failure carries its module file, since a missing service shows only when the body asks for it.
export const RunStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "suspended"]) }),
  Schema.Struct({ status: Schema.Literal("ended"), at: Schema.String }),
  Schema.Struct({ status: Schema.Literal("complete"), value: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.String,
    entry: Schema.String,
    error: Schema.optionalKey(Schema.Json),
  }),
]);

export const terminalStatus: (status: typeof RunStatus.Type) => boolean = (status) =>
  status.status === "complete" || status.status === "failed" || status.status === "ended";

export const pollStatus: (
  result: Option.Option<Workflow.Result<unknown, unknown>>,
  entry: string,
  success?: Schema.Codec<unknown, unknown, never, never>,
  error?: Schema.Codec<unknown, unknown, never, never>,
) => typeof RunStatus.Type = (result, entry, success?, error?) => {
  if (Option.isNone(result)) {
    return { status: "pending" };
  }
  const value = result.value;
  if (value._tag === "Suspended") {
    return { status: "suspended" };
  }
  return exitStatus(value.exit, entry, success, error);
};

const exitStatus: (
  exit: Exit.Exit<unknown, unknown>,
  entry: string,
  success?: Schema.Codec<unknown, unknown, never, never>,
  error?: Schema.Codec<unknown, unknown, never, never>,
) => typeof RunStatus.Type = (exit, entry, success?, error?) => {
  if (Exit.isSuccess(exit)) {
    const result = exit.value;
    const encoded =
      success === undefined
        ? Option.none()
        : Schema.encodeUnknownOption(Schema.toCodecJson(success))(result);
    if (Option.isSome(encoded) && isJson(encoded.value)) {
      return { status: "complete", value: encoded.value };
    }
    return { status: "complete", value: isJson(result) ? result : Formatter.format(result) };
  }
  // WARNING: a workflow's own failure is in the words its schema writes.
  const failure = Cause.findErrorOption(exit.cause);
  const written =
    error === undefined || Option.isNone(failure) || isWorkflowError(failure.value)
      ? Option.none()
      : Schema.encodeUnknownOption(Schema.toCodecJson(error))(failure.value);
  if (Option.isSome(written) && isJson(written.value)) {
    return { status: "failed", reason: asJsonText(written.value), entry, error: written.value };
  }
  return { status: "failed", reason: reasonOf(exit.cause), entry };
};

const isJson = Schema.is(Schema.Json);

const isWorkflowError = Schema.is(WorkflowError);

const reasonOf: (cause: Cause.Cause<unknown>) => string = (cause) => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && isWorkflowError(failure.value)) {
    return failure.value.reason;
  }
  const [reason] = Str.split(Cause.pretty(cause), "\n");
  return reason;
};

// WARNING: the field's name is the author's; read it by strategy, never by name.
const pointedAt: (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
) => string | null = (generation, input) => {
  const field = Option.getOrUndefined(
    Arr.findFirst(Rec.toEntries(generation.hints), ([, hint]) => hint === "diff-target"),
  )?.[0];
  const value = field === undefined ? undefined : input[field];
  return isText(value) && value !== "" ? value : null;
};

const isText = Schema.is(Schema.String);

const mrIdOf = (said: string | null, cwd: string) =>
  said === null ? Effect.succeed(null) : mrIdIn(mrRefsIn(said)[0] ?? "", cwd, runShell);

const fieldWith = (hints: Readonly<Record<string, InputStrategy>>, strategy: InputStrategy) =>
  Option.getOrUndefined(Arr.findFirst(Rec.toEntries(hints), ([, hint]) => hint === strategy))?.[0];

const REVIEWED = "reviewed";

const decodeInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const decodeStrings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

export interface Given {
  readonly json: Readonly<Record<string, Schema.Json>>;
  readonly text: Readonly<Record<string, string>>;
  readonly inferred?: ReadonlyArray<string>;
}

export const GIVEN = "given";
export const TYPED = "typed";
export const INFERRED = "inferred";

// WARNING: text is tried as a string before JSON, so a string-or-number union keeps 12 as text.
export const settleInput: (
  fields: InputFields,
  given: Given,
) => Effect.Effect<Settled, HostRefused> = (fields, given) => {
  const undeclared = Arr.filter(
    [...Struct.keys(given.json), ...Struct.keys(given.text)],
    (name) => !(name in fields),
  ).sort();
  if (undeclared.length > 0) {
    const names = Arr.join(
      Arr.map(undeclared, (name) => `"${name}"`),
      ", ",
    );
    return refusedInput(
      `${names} ${undeclared.length === 1 ? "is not an input" : "are not inputs"}`,
    );
  }
  const input: Record<string, Schema.Json> = {};
  const provenance: Record<string, string> = {};
  for (const [name, field] of Rec.toEntries(fields)) {
    const typed = given.json[name];
    if (typed !== undefined) {
      input[name] = typed;
      provenance[name] = GIVEN;
      continue;
    }
    const text = given.text[name];
    if (text === undefined) {
      continue;
    }
    const settled = asText(field, text);
    if (settled === undefined) {
      return refusedInput(`"${name}" is not ${describe(field)}: ${text}`);
    }
    input[name] = settled.value;
    provenance[name] = given.inferred?.includes(name) ? INFERRED : TYPED;
  }
  return Effect.succeed({ input, provenance });
};

// WARNING: held encoded so the row stores exactly the admitted JSON.
export interface Settled {
  readonly input: Record<string, Schema.Json>;
  readonly provenance: Record<string, string>;
}

const asParsedJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));
const asJsonText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

const asText = (field: InputField, text: string) => {
  const decode = Schema.decodeUnknownResult(field);
  if (decode(text)._tag === "Success") {
    return { value: text };
  }
  if (Str.trim(text) === "") {
    // WARNING: an empty Input of a list is the empty list, so a documented start can leave it blank.
    const empty = decode([]);
    if (empty._tag === "Success") {
      return { value: [] };
    }
  }
  const parsed = asParsedJson(text);
  if (parsed._tag === "Failure") {
    return undefined;
  }
  return decode(parsed.success)._tag === "Success" ? { value: parsed.success } : undefined;
};

const describe: (field: InputField) => string = (field) => {
  const drawn = jsonSchemaFor(field).document;
  if (!isDrawn(drawn)) {
    return "what this input takes";
  }
  const options = drawn.enum;
  if (Arr.isArray<typeof options>(options)) {
    return `one of ${Arr.join(Arr.map(options, asWord), ", ")}`;
  }
  const kind = drawn.type;
  return isWord(kind)
    ? `${kind === "array" || kind === "object" ? "an" : "a"} ${kind}`
    : "what this input takes";
};

const isWord = Schema.is(Schema.String);
const asWord = (value: Schema.Json) => (isWord(value) ? value : asJsonText(value));

const isDrawn = Schema.is(Schema.Record(Schema.String, Schema.Json));

const refusedInput = (reason: string) =>
  Effect.fail(new HostRefused({ reason: `${REFUSED_INPUT}: ${reason}` }));

// WARNING: a fixed outcome cannot be overridden by the caller.
const refuseOptions: (
  generation: Generation,
  options: Readonly<Record<string, string>>,
) => Effect.Effect<void, HostRefused> = (generation, options) => {
  const strange = Arr.filter(
    Struct.keys(options),
    (name) => name !== "claudeSubagents" && !(name in RESERVED_INPUTS),
  );
  if (strange.length > 0) {
    return refusedInput(
      `no host option is called ${Arr.join(
        Arr.map(strange, (name) => `"${name}"`),
        ", ",
      )}: ` + `the host's own are ${Arr.join(Struct.keys(RESERVED_INPUTS), ", ")}`,
    );
  }
  const asked = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(options.outcome), (present___) => Str.trim(present___)),
  );
  if (asked === undefined || asked === "") {
    return Effect.void;
  }
  const fixed = generation.fixedOutcome;
  if (fixed !== null && fixed !== asked) {
    return refusedInput(
      `"${generation.id}" always proves ${fixed}, so it cannot be asked for ${asked}`,
    );
  }
  if (fixed === null && asked !== UNSPECIFIED && !REQUESTABLE.includes(asked)) {
    return refusedInput(
      `"${asked}" is not an outcome a Run can be asked for; one of ${Arr.join(REQUESTABLE, ", ")}`,
    );
  }
  return Effect.void;
};

type CheckoutRequest =
  | { readonly kind: "declared" }
  | { readonly kind: "separate" }
  | { readonly kind: "existing"; readonly path: string };

const isSeparate = Schema.is(Schema.Literal("new"));

const checkoutRequest = Effect.fn("Engine.checkoutRequest")(function* (
  generation: Generation,
  asked: Readonly<Record<string, string>>,
  root: string | null,
) {
  const given =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(asked.workspace), (present____) => Str.trim(present____)),
    ) ?? "";
  if (given === "") {
    return { kind: "declared" } satisfies CheckoutRequest;
  }
  if (isSeparate(given)) {
    if (generation.checkout === "none") {
      return yield* refusedInput(
        `workspace: "new" asks for a worktree workspace, and "${generation.id}" makes no checkout: it works where it was started`,
      );
    }
    return { kind: "separate" } satisfies CheckoutRequest;
  }
  if (given === PROJECTS_ROOT_OPTION && root === null) {
    return yield* refusedInput(
      `workspace: "${PROJECTS_ROOT_OPTION}" came without the Projects root it names`,
    );
  }
  const path = given === PROJECTS_ROOT_OPTION ? (root ?? "") : given;
  if (!pipe(path, Str.startsWith("/"))) {
    return yield* refusedInput(
      `workspace: "${given}" is neither "new", "${PROJECTS_ROOT_OPTION}" nor the absolute path of a checkout`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const found = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(found) || found.value.type !== "Directory") {
    return yield* refusedInput(`workspace: ${path} is not a directory`);
  }
  return { kind: "existing", path } satisfies CheckoutRequest;
});

const Placed = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  worktree: Schema.NullOr(WorktreeRecordSchema),
});
type Placed = typeof Placed.Type;
const PlacedJson = Schema.fromJsonString(Placed);
const decodePlaced = Schema.decodeUnknownOption(PlacedJson);
const encodePlaced = flow(Schema.encodeResult(PlacedJson), Result.getOrThrow);

const CLAIM_STRIPES = 16;
const stripeOf = (key: string) => {
  let hash = 0;
  for (const char of key) {
    hash = (hash * 31 + Option.getOrElse(Str.charCodeAt(char, 0), () => Number.NaN)) >>> 0;
  }
  return hash % CLAIM_STRIPES;
};

const Cut = Schema.Struct({
  placed: Placed,
  opened: Schema.NullOr(Schema.Struct({ id: Schema.String, label: Schema.NullOr(Schema.String) })),
});
type Cut = typeof Cut.Type;

const NamedInvocation = Schema.fromJsonString(Schema.Struct({ offer: Schema.String }));

const Placing = Schema.Struct({
  requestedBy: Schema.optional(RequestedBy),
  heals: Schema.optionalKey(Schema.String),
  started: Schema.optional(StartedSchema),
  branchBase: Schema.optional(Schema.String),
  closes: Schema.optional(Schema.Literal("reported")),
  from: Schema.String,
  taskLabel: Schema.NullOr(Schema.String),
  root: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspace: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkout: Schema.optionalKey(Schema.NullOr(Cut)),
  continues: Schema.optionalKey(ConsumedCard),
  invoked: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Literal(true)),
  child: Schema.optionalKey(Schema.Literal(true)),
  took: Schema.optionalKey(Schema.Array(Schema.String)),
  by: Schema.optionalKey(Schema.String),
});
type Placing = typeof Placing.Type;
const PlacingJson = Schema.fromJsonString(Placing);
const decodePlacing = Schema.decodeUnknownOption(PlacingJson);
const encodePlacing = flow(Schema.encodeResult(PlacingJson), Result.getOrThrow);

const owing = new WeakMap<RunRow, boolean>();

export const owesReport = (row: RunRow) => {
  const known = owing.get(row);
  if (known !== undefined) {
    return known;
  }
  const owes = Option.match(decodePlacing(row.placing ?? ""), {
    onNone: () => false,
    onSome: (placing) => placing.requestedBy !== undefined || placing.closes === "reported",
  });
  owing.set(row, owes);
  return owes;
};

const authorityOf: (
  worktree: WorktreeRecord | null,
  started: Started | undefined,
) => RunAuthority = (worktree, started) => ({
  created:
    worktree?.created_branch === true && worktree.created_on !== null
      ? { branch: worktree.branch, checkout: worktree.path, origin: worktree.created_on }
      : null,
  roaming: worktree !== null && worktree.branch === "",
  started: started ?? null,
});

const unplaced = (row: RunRow) => row.checkout === null && row.placing !== null;

const treeOf = Effect.fn("Engine.treeOf")(function* (
  row: RunRow | null,
  runId: string,
  dir: string,
) {
  const placed =
    row === null
      ? null
      : placedOf(
          row,
          yield* decodeStrings(row.options ?? "{}").pipe(
            Effect.orElseSucceed(() => {
              const returned: Record<string, string> = {};
              return returned;
            }),
          ),
        );
  return { id: runId, cwd: placed?.cwd ?? dir, worktree: placed?.worktree?.path ?? null };
});

const workingPlace: (row: RunRow) => Placed = (row) => {
  if (!unplaced(row)) {
    return placedOf(row, {});
  }
  const receipt = Option.getOrUndefined(decodePlacing(row.placing ?? ""));
  return receipt?.checkout?.placed ?? { ...placedOf(row, {}), cwd: receipt?.from ?? row.project };
};

const optionsNow = (dir: string, runId: string, options: Readonly<Record<string, string>>) =>
  readIntent(runDir(dir, runId)).pipe(
    Effect.map((intent) => withOutcome(options, intent)),
    Effect.orElseSucceed(() => options),
  );

interface ReviewedMr {
  readonly mr: {
    readonly state: string;
    readonly head: string;
    readonly author: string;
    readonly sourceBranch: string;
  };
  readonly me: string | null;
}

const syncedReview = Effect.fn("Engine.syncedReview")(function* (target: string, cwd: string) {
  const id = yield* mrIdIn(target, cwd, runShell);
  if (id === null) {
    return null;
  }
  const requests = yield* MergeRequests;
  const entry = (yield* requests.entries).get(id);
  const login = yield* requests.login(Str.split(id, "/")[0] ?? "");
  if (entry?.read === undefined || entry.author === undefined || login === null) {
    return null;
  }
  return {
    mr: {
      state: entry.draft === true ? "draft" : (entry.state ?? "open"),
      head: entry.head ?? "",
      author: entry.author,
      sourceBranch: entry.source ?? "",
    },
    me: login.login,
  } satisfies ReviewedMr;
});

const reviewFacts = <R>(
  store: StoreApi,
  dir: string,
  runId: string,
  target: string,
  said: (
    ref: NonNullable<ReturnType<typeof readMrRef>>,
    cwd: string,
  ) => Effect.Effect<ReviewedMr | null, never, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const row = yield* store.run(runId);
    const ref = readMrRef(target);
    const missing = {
      owned: false,
      head: "",
      reviewed: "",
      lineage: Arr.empty<string>(),
      following: false,
    };
    if (row === null || ref === null) {
      return missing;
    }
    const read = yield* said(ref, placedOf(row, {}).cwd);
    if (read === null || !["open", "opened", "draft"].includes(read.mr.state)) {
      return missing;
    }
    const { mr, me } = read;
    const runs = yield* store.runs;
    const tasks = new Map(
      Arr.map(
        yield* listTasks.pipe(Effect.orElseSucceed(() => [])),
        (one) => [one.id, one] as const,
      ),
    );
    const taskIds = new Set(row.task === null ? [] : [row.task]);
    let ownsBranch = false;
    for (const candidate of runs) {
      const task = candidate.task === null ? undefined : tasks.get(candidate.task);
      if (candidate.project !== row.project || task === undefined || !isOpen(task)) {
        continue;
      }
      const at = placedOf(candidate, {});
      if (at.branch === mr.sourceBranch && at.branch !== null) {
        ownsBranch = true;
        taskIds.add(task.id);
      }
    }
    return {
      owned: me !== null && (mr.author === me || ownsBranch),
      head: mr.head,
      reviewed: yield* fs
        .readFileString(`${runDir(dir, runId)}/review-head`)
        .pipe(Effect.orElseSucceed(() => "")),
      lineage: Arr.map(
        Arr.filter(runs, (one) => one.task !== null && taskIds.has(one.task)),
        (one) => one.run,
      ),
      following: Arr.some(yield* store.watches([mrId(target)!]), (one) => one.run === runId),
    };
  });

const AGENT_WAIT_POLL = 100;

// WARNING: core answers a terminal.list with no deadline of its own, so a silent socket must not hold the wait.
const AGENT_LIST_BUDGET = 10_000;

const workingIn = (entry: AgentEntry, alive: ReadonlyArray<AgentInfo>, cwd: string) => {
  const at = Option.getOrUndefined(
    Arr.findFirst(
      alive,
      (one) =>
        one.terminalId === entry.incarnation?.terminalId ||
        one.paneId === entry.paneId ||
        one.name === entry.agent,
    ),
  );
  return (
    at !== undefined &&
    (at.status === "working" || at.status === "blocked") &&
    (at.cwd === cwd || at.foregroundCwd === cwd)
  );
};

const placedOf: (row: RunRow, options: Readonly<Record<string, string>>) => Placed = (
  row,
  options,
) =>
  Option.getOrElse(decodePlaced(row.checkout ?? ""), () => ({
    cwd: Option.getOrElse(
      Option.filter(Option.fromNullishOr(options.workspace), Str.startsWith("/")),
      () => row.project,
    ),
    branch: null,
    workspace: null,
    worktree: null,
  }));

const branchInputs = Effect.fn("Engine.branchInputs")(function* (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
  options: Readonly<Record<string, string>>,
) {
  const inputs: Record<string, string> = {};
  for (const [name, value] of Rec.toEntries(input)) {
    if (isText(value)) {
      inputs[name] = value;
    }
  }
  for (const [name, hint] of Rec.toEntries(generation.hints)) {
    const value = inputs[name];
    if (hint !== "work-source" || value === undefined) {
      continue;
    }
    const source = yield* classifyWorkSource(value).pipe(
      Effect.orElseSucceed(() => ({ kind: "text" })),
    );
    inputs[`${name}_kind`] = source.kind;
  }
  if (options.task !== undefined) {
    inputs[TASK_INPUT] = options.task;
  }
  return inputs;
});

const fanOutOf = Effect.fn("Engine.fanOutOf")(function* (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
  options: Readonly<Record<string, string>>,
  root: string,
) {
  const field = fieldWith(generation.hints, "work-source");
  const value = field === undefined ? undefined : input[field];
  if ((options.repo ?? "") !== "" || !isText(value)) {
    return null;
  }
  const source = yield* classifyWorkSource(value).pipe(Effect.orElseSucceed(() => null));
  if (source?.kind !== "plan-dir") {
    return null;
  }
  const plan = yield* planReposOf(source.value, root).pipe(Effect.orElseSucceed(() => null));
  return plan === null || isSingleRepo(plan) ? null : plan;
});

const checksOfStart = Effect.fn("Engine.checksOfStart")(function* (o: {
  readonly generation: Generation;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly launch: Readonly<Record<string, string>>;
  readonly from: string;
  readonly project: string;
  readonly verify: ReadonlyArray<VerifySpec> | undefined;
  readonly userDir: string;
  readonly start: Effect.Effect<string | null, never, PlatformServices>;
}) {
  const readApproved = (cwd: string, ref: string | null) =>
    approvedAt(cwd, o.userDir, ref).pipe(Effect.catch((cause) => refusedInput(cause.message)));
  const approved = o.verify ?? (yield* readApproved(o.project, yield* o.start));
  const fanOut = yield* fanOutOf(o.generation, o.input, o.launch, o.from);
  if (fanOut === null || fanOut.refusal !== null) {
    return approved;
  }
  if (o.verify !== undefined) {
    return yield* refusedInput(
      "--verify gives one repository's checks, and this plan spans repositories: each is held to its own .collie/verify.json or remembered checks",
    );
  }
  const path = yield* Path.Path;
  for (const repo of fanOut.repos) {
    const cwd = path.join(o.from, repo.path);
    yield* readApproved(cwd, yield* startOf(cwd));
  }
  return approved;
});

const seedIntentOf = (options: {
  readonly dir: string;
  readonly row: RunRow;
  readonly generation: Generation;
  readonly seed: IntentSeed | undefined;
  readonly parent: RunRow | null;
}) =>
  writeSeed(options).pipe(
    Effect.catch((cause) =>
      said(
        { runDir: runDir(options.dir, options.row.run) },
        `intent v1 not written: ${reason(cause)}`,
      ),
    ),
  );

const writeSeed = Effect.fn("Engine.writeSeed")(function* (options: {
  readonly dir: string;
  readonly row: RunRow;
  readonly generation: Generation;
  readonly seed: IntentSeed | undefined;
  readonly parent: RunRow | null;
}) {
  const at = runDir(options.dir, options.row.run);
  if ((yield* readIntent(at).pipe(Effect.orElseSucceed(() => null))) !== null) {
    return;
  }
  const input = yield* decodeInput(options.row.input).pipe(
    Effect.orElseSucceed(() => {
      const returned: Readonly<Record<string, Schema.Json>> = {};
      return returned;
    }),
  );
  const textOf = (hint: string) => {
    const field = fieldWith(options.generation.hints, hint);
    const value = field === undefined ? undefined : input[field];
    return isText(value) ? value : "";
  };
  const source = textOf("work-source");
  const kind = yield* classifyWorkSource(source).pipe(
    Effect.map((found) => found.kind),
    Effect.orElseSucceed(() => null),
  );
  const work = yield* fromWorkSource(kind, source).pipe(
    Effect.orElseSucceed(() => ({ goal: null, constraints: [] })),
  );
  const seeded = seedIntent(options.row.run, {
    defaults: options.seed?.defaults ?? null,
    goal: options.seed?.goal ?? (textOf("goal") || work.goal),
    constraints: [...work.constraints, ...(options.seed?.constraints ?? [])],
    runVerification: yield* approvedOf(options.dir, options.row.run),
  });
  const inherited =
    options.parent === null
      ? null
      : yield* readIntent(runDir(options.dir, options.parent.run)).pipe(
          Effect.orElseSucceed(() => null),
        );
  yield* (yield* FileSystem.FileSystem).makeDirectory(at, { recursive: true });
  yield* writeIntent(at, inherited === null ? seeded : propagate(inherited, seeded).intent);
});

// WARNING: a card reads the outcome from here, never from the workflow id.
const launchOptions = (generation: Generation, asked: Readonly<Record<string, string>>) =>
  generation.fixedOutcome === null ? asked : { ...asked, outcome: generation.fixedOutcome };

export const OpenDecision = Schema.Struct({
  shipping: Schema.optionalKey(Schema.NullOr(ShippingGo)),
  name: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(RecordedSolution),
  answer: Schema.NullOr(Schema.String),
  asked: Schema.optionalKey(Schema.String),
  answered: Schema.optionalKey(Schema.NullOr(Schema.String)),
  by: Schema.optionalKey(Schema.NullOr(Schema.String)),
  asker: Schema.optionalKey(Schema.NullOr(Schema.String)),
  superseded: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cause: Schema.optionalKey(Schema.NullOr(Schema.String)),
  messaged: Schema.optionalKey(Schema.Array(Schema.String)),
  revises: Schema.optionalKey(Schema.NullOr(Schema.String)),
  shortfall: Schema.optionalKey(Schema.NullOr(Schema.String)),
  steer: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type OpenDecision = typeof OpenDecision.Type;

const SupersedeRecord = Schema.Struct({ decision: Schema.String, agent: Schema.String });

export { Steered };

export const RunView = Schema.Struct({
  narratives: Schema.optionalKey(Schema.Array(NarrativeReport)),
  requestedBy: Schema.optional(RequestedBy),
  heals: Schema.optionalKey(Schema.String),
  report: Schema.optional(RunReport),
  linkNotices: Schema.optional(Schema.Array(LinkDelivery)),
  stepNotes: Schema.optional(Schema.Array(SteeringNote)),
  closes: Schema.optional(Schema.Literal("reported")),
  runId: Schema.String,
  workflow: Schema.String,
  project: Schema.String,
  task: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  registration: Schema.String,
  entry: Schema.String,
  input: Schema.Record(Schema.String, Schema.Json),
  provenance: Schema.Record(Schema.String, Schema.String),
  strategies: Schema.Record(Schema.String, Schema.String),
  options: Schema.Record(Schema.String, Schema.String),
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  worktree: Schema.NullOr(WorktreeRecordSchema),
  // WARNING: a stored fact, not read from the workflow id, so a renamed workflow is held to its declaration.
  outcome: Schema.String,
  created: Schema.String,
  status: RunStatus,
  waiting: Schema.Array(OpenDecision),
  controls: Schema.Array(Schema.String),
  diagnostic: Schema.NullOr(Schema.String),
  parked: Schema.NullOr(Schema.String),
  park: Schema.optionalKey(Schema.NullOr(Park)),
  recovery: Schema.optionalKey(Schema.Array(Schema.String)),
  awaiting: Schema.NullOr(AwaitingSchema),
  mr: Schema.NullOr(Schema.String),
  landing: Schema.NullOr(LandingSchema),
  wakes: Schema.optionalKey(Schema.NullOr(Schema.String)),
  usage: Schema.optionalKey(Schema.NullOr(UsageWaitSchema)),
  measurement: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type RunView = typeof RunView.Type;

const encodeView = flow(Schema.encodeResult(Schema.fromJsonString(RunView)), Result.getOrThrow);

const SWEEP_INTERVAL = "500 millis";
const WHOLE_SWEEP_EVERY = 60;

const WAKE_INTERVAL = "250 millis";
const WAKE_TRIES = 8;

const VIEW_CONCURRENCY = 8;

export interface KeptViews {
  readonly revision: (run: string) => number;
  readonly views: Map<
    string,
    {
      readonly row: RunRow;
      readonly decided: number;
      readonly revision: number;
      readonly engine: number | undefined;
      readonly view: RunView;
    }
  >;
}

export const Registrations = Schema.Struct({
  live: Schema.Array(Schema.String),
  unavailable: Schema.Array(Schema.String),
});

export interface Generation {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly entry: string;
  readonly fields: InputFields;
  readonly hints: Readonly<Record<string, InputStrategy>>;
  readonly fixedOutcome: string | null;
  readonly checkout: CheckoutKind;
  readonly closes?: "reported";
  readonly follows?: string;
  readonly source: string;
  readonly metadata: Schema.Json;
  readonly connections?: Sdk.WorkflowConnections;
  readonly offers: ReadonlyArray<Declared>;
  readonly agents: WorkflowAgentPreferences | undefined;
  readonly registration: Registration;
}

export type HostServices =
  | WorkflowEngine.WorkflowEngine
  | Host
  | Agents
  | Records
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | ForgeHttp;

export interface RegistryApi {
  readonly load: (entry: string) => Effect.Effect<Generation, EntryError, HostServices>;
  readonly use: (options: {
    readonly entry: string;
    readonly revision: string;
  }) => Effect.Effect<Generation, EntryError, HostServices>;
  readonly registrations: Effect.Effect<typeof Registrations.Type>;
  readonly newest: (id: string) => Effect.Effect<Generation, HostRefused>;
  readonly resolve: (options: {
    readonly project: string;
    readonly id: string;
  }) => Effect.Effect<Generation, HostRefused, HostServices>;
  readonly start: (
    options: StartOptions,
  ) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
  readonly check: (options: StartOptions) => Effect.Effect<void, HostRefused, HostServices>;
  readonly result: (runId: string) => Effect.Effect<unknown, WorkflowError>;
  readonly status: (
    runId: string,
  ) => Effect.Effect<typeof RunStatus.Type, HostRefused, HostServices>;
  readonly answer: (options: {
    readonly runId: string;
    readonly decision: string | null;
    readonly value: string;
    readonly request: string;
    readonly by?: Asker & { readonly schedule?: ScheduledBy | undefined };
  }) => Effect.Effect<typeof Answered.Type, HostRefused, HostServices>;
  readonly wake: (
    run: string,
    name: string,
    woke: Woke,
  ) => Effect.Effect<void, never, HostServices>;
  readonly supersede: (options: {
    readonly runId: string;
    readonly decision: string;
    readonly cause: string;
    readonly by: Asker;
    readonly agent: string;
  }) => Effect.Effect<Superseded, never, HostServices>;
  readonly control: (options: {
    readonly runId: string;
    readonly control: string;
    readonly set: boolean;
    readonly before?: string;
    readonly by?: string;
    readonly alone?: boolean;
    readonly reason?: string;
  }) => Effect.Effect<typeof Controlled.Type, HostRefused, HostServices>;
  readonly grant: (options: {
    readonly runId: string;
    readonly name: string;
    readonly command: Omit<VerifySpec, "name"> | null;
  }) => Effect.Effect<ReadonlyArray<VerifySpec>, HostRefused, HostServices>;
  readonly steer: (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly step?: string;
    readonly to?: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: AgentsSdk.DeliveryMode;
    readonly actor?: Asker;
  }) => Effect.Effect<typeof Steered.Type, HostRefused, HostServices>;
  readonly tendQuestions: Effect.Effect<void, never, HostServices>;
  readonly waiting: (runId: string) => Effect.Effect<ReadonlyArray<OpenDecision>>;
  readonly view: (runId: string) => Effect.Effect<RunView | null>;
  readonly forgetClaim: (slug: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly views: (
    task: string | null,
    read?: FileSystem.FileSystem,
    kept?: KeptViews,
  ) => Effect.Effect<ReadonlyArray<RunView>>;
  readonly related: (
    runId: string,
    also: ReadonlyArray<string>,
    read?: FileSystem.FileSystem,
    kept?: KeptViews,
  ) => Effect.Effect<ReadonlyArray<RunView>>;
  readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
  readonly retire: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, never, MessageStorage.MessageStorage>;
  readonly watch: (runId: string) => Stream.Stream<RunView | null>;
  readonly recover: Effect.Effect<typeof Registrations.Type, never, HostServices>;
  readonly resume: (
    runId: string,
    recoveryPark?: string,
    healing?: string,
  ) => Effect.Effect<typeof Controlled.Type, HostRefused, HostServices>;
  readonly offers: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<Offer>, HostRefused, HostServices>;
  readonly syncRecovery: (runId: string) => Effect.Effect<void, never, HostServices>;
  // WARNING: the offer, its eligibility and its arguments are all checked again, so a stale one starts nothing.
  readonly invoke: (options: {
    readonly runId: string;
    readonly offer: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
    readonly started?: Started | undefined;
    readonly by?: string | undefined;
  }) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
  readonly routed: (
    runId: string,
  ) => Effect.Effect<{ readonly generation: Generation; readonly execution: string }, HostRefused>;
}

export interface StartOptions {
  readonly requestedBy?: RequestedBy;
  readonly heals?: string;
  readonly started?: Started;
  readonly branchBase?: string | undefined;
  readonly generation: Generation;
  readonly request: string;
  readonly project: string;
  readonly runId?: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly text?: Readonly<Record<string, string>>;
  readonly inferred?: ReadonlyArray<string>;
  readonly root?: string | undefined;
  readonly options?: Readonly<Record<string, string>>;
  readonly task?: string | null;
  readonly taskLabel?: string | undefined;
  readonly parent?: string | null;
  readonly continues?: ConsumedCard | undefined;
  readonly invoked?: string | undefined;
  readonly took?: ReadonlyArray<string> | undefined;
  readonly by?: string | undefined;
  readonly intent?: IntentSeed;
  readonly verify?: ReadonlyArray<VerifySpec> | undefined;
  readonly attachments?: ReadonlyArray<string> | undefined;
  readonly handsOver?: boolean;
}

export interface Admitted {
  readonly runId: string;
  readonly registration: string;
  readonly execution: string;
  readonly fresh: boolean;
  readonly followed?: string;
}

export type CrashPoint =
  | "admitted"
  | "executed"
  | "answered"
  | "reported"
  | "recovery-park-cleared"
  | "recovery-entered";

// WARNING: a parent's child is located the same way, so a project override reaches its work.
export type Locate = (options: {
  readonly project: string;
  readonly id: string;
}) => Effect.Effect<
  { readonly entry: string; readonly revision: string },
  HostRefused,
  FileSystem.FileSystem
>;

export class Registry extends Context.Service<Registry, RegistryApi>()("collie/Registry") {}

export interface RegistryOptions {
  readonly catalogue?: Effect.Effect<MachineCatalogue>;
  readonly crashAt?: CrashPoint;
  readonly locate?: Locate;
  readonly userDir?: string;
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  readonly namesTasks?: boolean;
  readonly supersedeGraceMs?: number | undefined;
  readonly keep?:
    | { readonly revision: (run: string) => number; readonly reading: FileSystem.FileSystem }
    | undefined;
}

export const registryLayer: (
  dir: string,
  options?: RegistryOptions,
) => Layer.Layer<
  Registry,
  never,
  | HostServices
  | Store
  | SecureRandom.SecureRandom
  | ChildProcessSpawner.ChildProcessSpawner
  | PlatformServices
> = (dir, options?) => Layer.effect(Registry)(makeRegistry(dir, options));

// WARNING: one SQLite client and one Store sit behind all three, never a second connection.
export const foundationLayer: (options: {
  readonly dir: string;
  readonly userDir?: string;
  readonly toast?: Toast;
  readonly slack?: typeof slackApi;
  readonly herd?: Herd;
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  readonly messagePoll?: Duration.Input | undefined;
  readonly terminationTimeout?: Duration.Input | undefined;
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  readonly productionPoll?: Duration.Input;
  readonly issuePrivacyBudget?: Duration.Input;
  readonly reviewPoll?: Duration.Input;
}) => Layer.Layer<
  | Host
  | Notifier
  | Oversight
  | Reliance
  | Store
  | Records
  | WorkflowEngine.WorkflowEngine
  | MessageStorage.MessageStorage
  | SqlClient.SqlClient
  | Reactivity.Reactivity
  | ForgeHttp,
  ConfigError,
  PlatformServices
> = (options) =>
  hostLayer(options).pipe(
    Layer.provideMerge(keptRevisions),
    Layer.provideMerge(
      recordsLayer.pipe(
        Layer.provideMerge(storeLayer(options.dir).pipe(Layer.provideMerge(engineLayer(options)))),
      ),
    ),
    Layer.provideMerge(forgeHttpLayer),
  );

const keptRevisions = Layer.effect(RevisionRows)(
  ModuleRevisions.use((rows) => Effect.succeed({ rows, synced: false })),
);

const makeRegistry: (
  dir: string,
  options?: RegistryOptions,
) => Effect.Effect<
  RegistryApi,
  never,
  | HostServices
  | Store
  | SecureRandom.SecureRandom
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | PlatformServices
> = Effect.fn("Engine.makeRegistry")(function* (dir: string, options?: RegistryOptions) {
  const crashAt = options?.crashAt;
  const locate = options?.locate;
  const userDir = options?.userDir ?? dir;
  const catalogue = options?.catalogue;
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const touches = Option.getOrUndefined(yield* Effect.serviceOption(EngineTouches));
  const fs = yield* FileSystem.FileSystem;
  const hostFs = fs;
  const store = yield* Store;
  const random = yield* SecureRandom.SecureRandom;
  const hostScope = yield* Effect.scope;
  const placing =
    options?.placing ??
    (yield* currentEnv.pipe(
      Effect.map((env) => ({ herdr: new Herdr(env), env })),
      Effect.orDie,
    ));
  const bun = yield* Effect.context<PlatformServices | SecureRandom.SecureRandom | Records>();
  const runRecords = Context.get(bun, RunRecords);
  const mergeRequestOf = (runId: string) =>
    recordedMergeRequest(runId).pipe(Effect.provideContext(bun));

  // WARNING: a branch Run's repository other than its checkout is refused, never ignored.
  const refuseElsewhere = Effect.fn("Engine.refuseElsewhere")(function* (
    generation: Generation,
    settled: Settled,
    cwd: string,
  ) {
    const field = fieldWith(generation.hints, "repository");
    const value = field === undefined ? undefined : settled.input[field];
    if (generation.checkout !== "branch" || !isText(value) || Str.trim(value) === "") {
      return;
    }
    const named = Str.trim(value);
    const top = (at: string) =>
      runShell("git", ["rev-parse", "--show-toplevel"], at).pipe(
        Effect.map((said) => (said.code === 0 ? Str.trim(said.stdout) : null)),
        Effect.orElseSucceed(() => null),
        Effect.provideContext(bun),
      );
    const there = pipe(named, Str.startsWith("/")) ? yield* top(named) : null;
    if (there !== null && there === (yield* top(cwd))) {
      return;
    }
    return yield* refusedInput(
      `"${field}" names ${named}, and a ${generation.id} Run works in the checkout it is started in, ${cwd}, and never clones: start it in that checkout, or from Home, which places it there`,
    );
  });

  const settleTargets = Effect.fn("Engine.settleTargets")(function* (
    generation: Generation,
    settled: Settled,
    cwd: string,
  ) {
    yield* refuseElsewhere(generation, settled, cwd);
    const field = fieldWith(generation.hints, "diff-target");
    const value = field === undefined ? undefined : settled.input[field];
    if (field === undefined || !isText(value) || Str.trim(value) === "") {
      return settled;
    }
    const permalink = slackMessageRef(value) !== null ? value : settled.input.slack;
    if (isText(permalink) && permalink !== "") {
      const target = yield* Context.get(hostServices, Host)
        .slackTarget(permalink, permalink === value ? undefined : value)
        .pipe(Effect.mapError((error) => new HostRefused({ reason: error.reason })));
      return { ...settled, input: { ...settled.input, [field]: target, slack: permalink } };
    }
    const set = yield* classifyGivenSet(value, { cwd }).pipe(Effect.provideContext(bun));
    if (set !== null && "unresolved" in set) {
      return yield* refusedInput(
        `"${field}" names ${set.unresolved}, which is not a merge request`,
      );
    }
    if (set !== null) {
      return { ...settled, input: { ...settled.input, [field]: set.value } };
    }
    const target = yield* classifyGivenTarget(value, { cwd }).pipe(Effect.provideContext(bun));
    if (target === null) {
      return yield* refusedInput(
        `"${field}" is not a merge request, a branch diff or the working tree: ${value}`,
      );
    }
    return { ...settled, input: { ...settled.input, [field]: target.value } };
  });
  const live = new Map<string, Generation>();
  const unavailable = new Map<string, string>();
  const newestOf = new Map<string, string>();
  let known = yield* store.generations;
  // WARNING: staged copies are cleared on start, never restored.
  yield* clearGenerations(dir);
  const waking = yield* Semaphore.make(1);
  const controlling = yield* Semaphore.make(1);
  const wakingWatches = new Set<string>();
  const forgetWatch = (run: string, name?: string) =>
    Effect.gen(function* () {
      if (!(yield* store.unwatch(run, name))) {
        return;
      }
      yield* runRecords.setControl(AWAITING, run, null);
      yield* store.announce;
    });
  const parkedOf = (runId: string) =>
    Effect.map(runRecords.control(PARKED, runId), Option.fromNullishOr);
  const clearParked = (runId: string) =>
    runRecords.setControl(PARKED, runId, null).pipe(Effect.andThen(store.announce));

  const restoreParked = (runId: string, old: Option.Option<string>) =>
    Effect.gen(function* () {
      if (Option.isSome(old) && (yield* runRecords.control(PARKED, runId)) === null) {
        yield* runRecords.setControl(PARKED, runId, old.value);
        yield* store.announce;
      }
    });

  const stageEntry = Effect.fn("Engine.stageEntry")(function* (file: string) {
    const name = yield* random.uuidV4();
    const sources = yield* sourceTree(directoryOf(file));
    const staged = yield* stageFiles({ dir, name, entry: file }, sources);
    const entry = yield* readStagedEntry(file, {
      file: staged,
      root: `${dir}/generations/${name}`,
    });
    return { entry, source: `${file}@${sources.revision}` };
  });

  const register = Effect.fn("Engine.register")(function* (
    route: {
      readonly workflow: string;
      readonly name: string;
      readonly entry: string;
    },
    recovered?: Set<string>,
    prepared?: { readonly entry: WorkflowEntry; readonly source: string },
    reached: (run: string) => boolean = () => true,
  ) {
    const { entry, source } = prepared ?? (yield* stageEntry(route.entry));
    const registration = entry.make(route.name);
    const pending: Array<{ row: RunRow; parked: Option.Option<string> }> = [];
    const held: Array<string> = [];
    if (recovered !== undefined) {
      for (const row of yield* store.runs) {
        if (row.generation !== route.name || unplaced(row)) {
          continue;
        }
        if (Option.isNone(yield* payloadOf(registration, row).pipe(Effect.option))) {
          continue;
        }
        const status = pollStatus(
          yield* engine.poll(registration.workflow, row.execution),
          route.entry,
        ).status;
        if (status === "pending" && !reached(row.run)) {
          held.push(row.run);
        } else if (status === "pending") {
          pending.push({
            row,
            parked: yield* parkedOf(row.run),
          });
          yield* clearParked(row.run);
        }
      }
    }
    for (const run of held) {
      heldAtEntry.set(run, yield* Deferred.make<void>());
    }
    // WARNING: the only place a host binds services into a module's Layer; modules provide the rest themselves.
    yield* Layer.buildWithScope(
      registration.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Children)(children),
            Layer.succeed(Executions)(executions),
            Layer.succeed(Host)(
              Host.of({
                ...Context.get(hostServices, Host),
                held: (runId) => boundary(Context.get(hostServices, Host).held(runId), HOLD, runId),
                stopRequested: (runId) =>
                  boundary(Context.get(hostServices, Host).stopRequested(runId), STOP, runId),
                report: machineReport,
                takeOverLanding: landingTakeover,
              }),
            ),
          ),
        ),
      ),
      hostScope,
    ).pipe(
      Effect.onError(() =>
        Effect.forEach(held, releaseEntry).pipe(
          Effect.andThen(
            Effect.forEach(pending, ({ row, parked }) =>
              (entriesOf.get(registration.workflow)?.get(row.run) ?? 0) > 0
                ? Effect.void
                : restoreParked(row.run, parked),
            ),
          ),
        ),
      ),
    );
    const generation: Generation = {
      id: route.workflow,
      name: route.name,
      title: entry.title,
      entry: route.entry,
      fields: entry.input,
      hints: entry.metadata?.hints ?? {},
      fixedOutcome: entry.metadata?.outcome?.fixed ?? null,
      closes: entry.metadata?.closes,
      follows: entry.metadata?.follows,
      checkout: entry.metadata?.checkout ?? "none",
      source,
      metadata: describeMetadata(entry.metadata),
      connections: entry.metadata?.connections,
      offers: declaredByModule(entry.metadata),
      agents: entry.agents,
      registration,
    };
    live.set(route.name, generation);
    unavailable.delete(route.name);
    newestOf.set(route.workflow, route.name);
    for (const { row, parked } of pending) {
      const accepted = yield* handOver(row, false).pipe(
        Effect.catchTag("HostRefused", () => Effect.succeed(false)),
      );
      if (accepted || (entriesOf.get(registration.workflow)?.get(row.run) ?? 0) > 0) {
        recovered?.add(row.run);
      } else {
        yield* restoreParked(row.run, parked);
      }
    }
    return generation;
  });

  // WARNING: merging this way keeps the parent's instance and scope, which is what links child to parent.
  const hostServices = yield* Effect.context<HostServices>();
  const generationsRegistered = yield* Deferred.make<void>();
  const landingTakeover = Effect.fn("Host.takeOverLanding")(function* (asked: {
    readonly runId: string;
    readonly cwd: string;
  }) {
    const rows = Arr.filter(yield* store.runs, (row) => row.run !== asked.runId);
    const runs = Arr.map(yield* Effect.forEach(rows, (row) => viewOf(row)), (view) => ({
      runId: view.runId,
      landing: view.landing,
      ended:
        view.status.status === "complete"
          ? { succeeded: true, failure: "" }
          : view.status.status === "failed"
            ? { succeeded: false, failure: view.status.reason }
            : null,
    }));
    return yield* takeOver({
      runDir: runDir(dir, asked.runId),
      mr: yield* mergeRequestOf(asked.runId),
      runs,
      cwd: asked.cwd,
      run: runShell,
    }).pipe(
      Effect.catchTag("PlatformError", (cause) => Effect.die(cause)),
      Effect.provideService(ForgeHttp, Context.get(hostServices, ForgeHttp)),
      Effect.provideContext(bun),
    );
  });
  const machineReport = Effect.fn("Host.report")(function* (since: string) {
    yield* Deferred.await(generationsRegistered);
    const from = epochMs(since);
    if (!Number.isFinite(from)) {
      return yield* new WorkflowError({ reason: `since is not a date: ${since}` });
    }
    const rows = Arr.filter(yield* store.runs, (row) => epochMs(row.admitted) >= from);
    const views = yield* Effect.forEach(rows, (row) => viewOf(row));
    const metrics = new Map<string, Metrics>();
    const recorded = new Map<string, Recorded>();
    for (const view of views) {
      const lines = yield* readMetrics(evidenceDir(dir, view.runId)).pipe(
        Effect.provideContext(bun),
      );
      const records = yield* outcomeRecordsOf(dir, view.runId).pipe(
        Effect.orElseSucceed(() => null satisfies OutcomeRecords | null),
        Effect.provideContext(bun),
      );
      metrics.set(view.runId, metricsOf(lines, view.created));
      recorded.set(view.runId, { records, metrics: lines });
    }
    return reportOf(views, metrics, since, recorded);
  });
  const lending: <A, E>(effect: Effect.Effect<A, E, HostServices>) => Effect.Effect<A, E> = <A, E>(
    effect: Effect.Effect<A, E, HostServices>,
  ) =>
    Effect.updateContext(effect, (caller: Context.Context<never>) =>
      Context.merge(hostServices, caller),
    );

  const childRunId = (ask: ChildAsk & { readonly runId: string }) =>
    `${ask.runId}.${ask.invocation}`;

  const refuseAgent = Effect.fn("Engine.refuseAgent")(function* (
    generation: Generation,
    options: Readonly<Record<string, string>>,
  ) {
    const asked = yield* preferencesFromOptions(options).pipe(
      Effect.catch((cause) => refusedInput(`claudeSubagents: ${String(cause)}`)),
    );
    if (Struct.keys(asked).length === 0) {
      return;
    }
    const defaults = yield* loadDefaults(userDir).pipe(
      Effect.orElseSucceed(() => FALLBACK_DEFAULTS),
    );
    const raw = (yield* readConfig(userDir).pipe(
      Effect.catch((cause) => refusedInput(String(cause))),
    )).claude_subagents;
    const policy =
      raw === undefined
        ? undefined
        : yield* readSubagents(raw).pipe(
            Effect.catch((cause) => refusedInput(`claude_subagents: ${String(cause)}`)),
          );
    const configured = {
      harness: defaults.harness,
      model: defaults.model,
      effort: defaults.effort,
      claudeSubagents: policy,
    };
    const resolved = resolveChoice(
      [configured, generation.agents, asked],
      defaults.models,
      catalogue === undefined ? undefined : yield* catalogue,
    );
    if (!resolved.ok) {
      return yield* refusedInput(resolved.problem);
    }
  });

  const refused = (reason: string) => new WorkflowError({ reason });

  const reviewedTarget = Effect.fn("Engine.reviewedTarget")(function* (dirOfRun: string) {
    const row = yield* store.run(
      Str.split(pipe(dirOfRun, Str.replace(/\/+$/, "")), "/").at(-1) ?? "",
    );
    const generation = row === null ? undefined : live.get(row.generation);
    if (row === null || generation === undefined) {
      return null;
    }
    return pointedAt(
      generation,
      yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({}))),
    );
  });

  const plannedOn = Effect.fn("Engine.plannedOn")(function* (planRun: string, runId: string) {
    const states = yield* readMrStates(dir).pipe(Effect.orElseSucceed(() => new Map()));
    let branch: string | null = null;
    for (const row of yield* store.runs) {
      const on = row.run === runId || unplaced(row) ? null : placedOf(row, {}).branch;
      if (on === null || (branch !== null && on !== branch)) {
        continue;
      }
      if (!(yield* lineageIn(store)(row.run)).includes(planRun)) {
        continue;
      }
      branch = on;
      const mr = yield* mergeRequestOf(row.run);
      const id = mr === null ? null : yield* mrIdIn(mr, placedOf(row, {}).cwd, runShell);
      const state = id === null ? undefined : states.get(id);
      if (state !== undefined && state !== "open") {
        return null;
      }
    }
    return branch;
  });

  const branchAskOf = Effect.fn("Engine.branchAskOf")(function* (ask: {
    readonly generation: Generation;
    readonly runId: string;
    readonly from: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly provenance: Readonly<Record<string, string>>;
    readonly options: Readonly<Record<string, string>>;
  }) {
    const { generation } = ask;
    const inputs = yield* branchInputs(generation, ask.input, ask.options);
    const source = fieldWith(generation.hints, "work-source");
    const reviewed =
      source !== undefined &&
      inputs[`${source}_kind`] === "review" &&
      fieldWith(generation.hints, "diff-target") === undefined
        ? yield* reviewedTarget(inputs[source] ?? "")
        : null;
    if (reviewed !== null) {
      inputs[REVIEWED] = reviewed;
    }
    const planRun = planRunOf(workSourceOf({ inputs, strategies: generation.hints })?.value ?? "");
    const taskBranch = planRun === null ? null : yield* plannedOn(planRun, ask.runId);
    return {
      cwd: ask.from,
      name: ask.runId,
      inputs,
      strategies:
        reviewed === null ? generation.hints : { ...generation.hints, [REVIEWED]: "diff-target" },
      sources: ask.provenance,
      explicit: ask.options.branch ?? null,
      taskBranch,
      change: ask.options.change,
      stackedOn:
        ask.options.stacked === undefined
          ? undefined
          : changeOfKey(ask.options.repo ?? ".", ask.options.stacked),
      login: placing.env.gitlabLogin,
      githubLogin: placing.env.githubLogin,
      gitlabHost: yield* gitlabHostOf(placing.env).pipe(Effect.orElseSucceed(() => undefined)),
    } satisfies BranchAsk;
  });

  const startRefOf = Effect.fn("Engine.startRefOf")(function* (ask: {
    readonly generation: Generation;
    readonly runId: string;
    readonly from: string;
    readonly project: string;
    readonly branchBase?: string | undefined;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly provenance: Readonly<Record<string, string>>;
    readonly options: Readonly<Record<string, string>>;
  }) {
    const { generation } = ask;
    if (
      generation.checkout === "branch" &&
      ask.from === ask.project &&
      (yield* fanOutOf(generation, ask.input, ask.options, ask.from)) === null
    ) {
      const plan = yield* branchFor({ ...(yield* branchAskOf(ask)), fetches: false }).pipe(
        Effect.option,
      );
      if (Option.isSome(plan) && plan.value.refused === null) {
        return ask.branchBase ?? plan.value.base;
      }
    }
    return yield* startOf(ask.project);
  });

  // WARNING: a checkout that cannot be cut is refused now, before anything exists to clean up.
  const placeRun = Effect.fn("Engine.placeRun")(function* (ask: {
    readonly generation: Generation;
    readonly runId: string;
    readonly from: string;
    readonly branchBase?: string | undefined;
    readonly request: CheckoutRequest;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly provenance: Readonly<Record<string, string>>;
    readonly options: Readonly<Record<string, string>>;
    readonly task: string | null;
    readonly taskLabel?: string | undefined;
    readonly workspace?: string | null | undefined;
    readonly checkout?: Cut | null | undefined;
    readonly record: (receipt: Partial<Placing>) => Effect.Effect<void>;
  }) {
    const { generation, from } = ask;
    const failed = (cause: unknown) =>
      new HostRefused({
        reason: `"${generation.id}" could not be given a checkout: ${String(cause)}`,
      });
    let placed: Placed = { cwd: from, branch: null, workspace: null, worktree: null };
    let opened: Cut["opened"] = null;
    const fanOut =
      ask.checkout === undefined && generation.checkout !== "none"
        ? yield* fanOutOf(generation, ask.input, ask.options, from)
        : null;
    if (fanOut?.refusal) {
      return yield* new HostRefused({
        reason: `"${generation.id}" cannot run here: ${fanOut.refusal.message}`,
      });
    }
    if (ask.checkout === null) {
      return yield* new PlacementUncertain({
        reason: `a checkout from ${from} may have been cut for ${ask.runId} before the host stopped, and nothing records where. Remove it if it is there, and start again under a new request id.`,
      });
    }
    if (ask.checkout !== undefined) {
      ({ placed, opened } = ask.checkout);
    } else if (generation.checkout !== "none" && fanOut === null) {
      const branchAsk = yield* branchAskOf(ask);
      if (
        generation.checkout === "branch" &&
        (yield* repositoryName(runShell, from).pipe(Effect.mapError(failed))) === null
      ) {
        return yield* refusedInput(
          `"${generation.id}" builds on a worktree of its own, and ${from} is not a git checkout to cut one from. Start it from a checkout, or name one with --input workspace=/path/to/checkout.`,
        );
      }
      yield* ask.record({ checkout: null });
      const checkout = yield* checkoutFor(placing.herdr, {
        ...branchAsk,
        stateDir: placing.env.stateDir,
        workflow: generation.id,
        checkout: generation.checkout,
        branchBase: ask.branchBase,
        recordedBy: (at) =>
          Effect.gen(function* () {
            const rows = yield* store.runs;
            const others = Arr.filter(rows, (row) => row.run !== ask.runId);
            const recorders = Arr.map(
              Arr.filter(others, (row) => workingPlace(row).worktree?.path === at),
              (row) => row.run,
            );
            const latest = Option.getOrUndefined(
              Arr.findLast(others, (row) => workingPlace(row).worktree?.path === at),
            );
            if (latest === undefined) {
              return null;
            }
            const real = (dir: string) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
            const here = yield* real(at);
            const users: Array<string> = [];
            for (const row of others) {
              const cwd = yield* real(workingPlace(row).cwd);
              if (cwd === here || pipe(cwd, Str.startsWith(`${here}/`))) {
                users.push(row.run);
              }
            }
            const runs = new Set(
              Arr.flatMap([...recorders, ...users], (run) => [run, ...descendantsOf(rows, run)]),
            );
            return {
              run: latest.run,
              worktree: workingPlace(latest).worktree ?? null,
              live: unended([...runs]),
              release: releaseRuns([...runs]).pipe(
                Effect.filterOrElse(
                  (why) => why !== null,
                  () => agentIn(here),
                ),
              ),
            };
          }),
        claimed: (worktree) =>
          ask.record({
            checkout: {
              placed: { cwd: worktree.path, branch: null, workspace: null, worktree },
              opened: null,
            },
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new PlacementUncertain({
              reason: `"${generation.id}" could not be given a checkout: ${String(cause)}`,
            }),
        ),
      );
      if (checkout.refused !== null) {
        return yield* new HostRefused({
          reason: `"${generation.id}" could not be given a checkout: ${checkout.refused}`,
        });
      }
      placed = {
        cwd: checkout.cwd,
        branch: checkout.branch,
        workspace: null,
        worktree: checkout.worktree,
      };
      yield* ask.record({ checkout: { placed, opened } });
      if (checkout.note !== "") {
        yield* said({ runDir: runDir(dir, ask.runId) }, checkout.note);
      }
    }
    if (ask.taskLabel === undefined) {
      return { placed, task: ask.task };
    }
    // WARNING: a start about a Task's work joins that Task's workspace, wherever it came from.
    if (ask.workspace === undefined && opened === null) {
      const joined = yield* taskWorking(generation, ask, placed);
      if (joined !== null) {
        return { placed, task: joined.id };
      }
    }
    const label = opened?.label ?? ask.taskLabel;
    // WARNING: only a Herdr 1 placement records a workspace; core records none.
    const workspace = opened?.id ?? ask.workspace ?? null;
    const rootPane = opened === null ? null : (placed.worktree?.root_pane_id ?? null);
    const known =
      ask.workspace === undefined ? null : yield* taskOfWorkspace(workspace).pipe(Effect.orDie);
    const task =
      known ??
      (yield* newTask({
        workspace,
        label,
        cwd: placed.cwd,
        rootPane,
        herd: yield* machineHerd(placing.env).pipe(Effect.orElseSucceed(() => null)),
      }).pipe(
        Effect.flatMap((made) => writeTask(made)),
        Effect.orDie,
      ));
    return { placed, task: task.id };
  }, Effect.provideContext(bun));

  const taskWorking = Effect.fn("Engine.taskWorking")(function* (
    generation: Generation,
    ask: {
      readonly runId: string;
      readonly input: Readonly<Record<string, Schema.Json>>;
      readonly provenance: Readonly<Record<string, string>>;
      readonly options: Readonly<Record<string, string>>;
    },
    placed: Placed,
  ) {
    const about = (ask: Parameters<typeof workOf>[0]) =>
      workOf(ask, runShell).pipe(Effect.orElseSucceed(() => null));
    const branch = yield* about({
      cwd: placed.cwd,
      branch: placed.branch,
      name: ask.runId,
      inputs: yield* branchInputs(generation, ask.input, ask.options),
      strategies: generation.hints,
      sources: ask.provenance,
    });
    const mr = yield* mrIdOf(pointedAt(generation, ask.input), placed.cwd);
    if (branch === null && mr === null) {
      return null;
    }
    const tasks = new Map(
      Arr.map(
        yield* listTasks.pipe(Effect.orElseSucceed(() => [])),
        (task) => [task.id, task] as const,
      ),
    );
    for (const row of yield* store.runs) {
      const task = row.task === null || row.run === ask.runId ? undefined : tasks.get(row.task);
      if (task === undefined) {
        continue;
      }
      if (mr !== null) {
        const recorded = live.get(row.generation);
        const given = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
        const cwd = placedOf(row, {}).cwd;
        const mrs = yield* Effect.forEach(
          [
            yield* mergeRequestOf(row.run),
            recorded === undefined ? null : pointedAt(recorded, given),
          ],
          (said) => mrIdOf(said, cwd),
        );
        if (mrs.includes(mr)) {
          return task;
        }
      }
      if (branch === null || !isOpen(task) || unplaced(row)) {
        continue;
      }
      const at = placedOf(row, {});
      if (at.branch === null) {
        continue;
      }
      if (
        (yield* about({ cwd: at.cwd, branch: at.branch, name: row.run, inputs: {} })) === branch
      ) {
        return task;
      }
    }
    return null;
  }, Effect.provideContext(bun));

  const claiming = yield* Effect.forEach(Array.from({ length: CLAIM_STRIPES }), () =>
    Semaphore.make(1),
  );
  const claimingOf = (request: string) => claiming[stripeOf(request)]!;

  // WARNING: a claim found already made may have placed something, so it is kept on refusal.
  const placeClaimed = Effect.fn("Engine.placeClaimed")(function* (row: RunRow, fresh: boolean) {
    const generation = live.get(row.generation);
    const placing = decodePlacing(row.placing ?? "");
    if (!unplaced(row) || generation === undefined || Option.isNone(placing)) {
      return row;
    }
    let receipt = placing.value;
    const strings = (text: string | null) =>
      decodeStrings(text ?? "{}").pipe(
        Effect.orElseSucceed(() => ({}) satisfies Record<string, string>),
      );
    const options = yield* strings(row.options);
    const placement = yield* Effect.gen(function* () {
      return yield* placeRun({
        generation,
        runId: row.run,
        from: placing.value.from,
        branchBase: placing.value.branchBase,
        request: yield* checkoutRequest(generation, options, placing.value.root ?? null),
        input: yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({}))),
        provenance: yield* strings(row.provenance),
        options,
        task: row.task,
        taskLabel: placing.value.taskLabel ?? undefined,
        workspace: placing.value.workspace,
        checkout: placing.value.checkout,
        record: (change) => {
          receipt = { ...receipt, ...change };
          return store.recordPlacing(row.run, encodePlacing(receipt));
        },
      });
    }).pipe(
      // WARNING: an uncertain placement keeps its claim, so a retry cannot open a second Run.
      Effect.tapErrorTag("HostRefused", () => (fresh ? store.forget(row.run) : Effect.void)),
      Effect.catchTag("PlacementUncertain", (failure) =>
        Effect.fail(new HostRefused({ reason: failure.reason })),
      ),
    );
    return yield* store.place(row.run, {
      checkout: encodePlaced(placement.placed),
      task: placement.task,
    });
  });

  const claimAndPlace = (admission: Admission) =>
    claimingOf(admission.request).withPermits(1)(
      Effect.gen(function* () {
        const claimed = yield* store.admit(admission);
        const row = yield* placeClaimed(claimed.row, claimed.fresh);
        remember(row);
        return { row, fresh: claimed.fresh };
      }),
    );

  const executions: typeof Executions.Service = {
    stop: (runId) => stopTree(runId).pipe(Effect.provideContext(hostServices), Effect.orDie),
    stopped: (runId) =>
      routed(runId).pipe(
        Effect.flatMap((found) =>
          engine.poll(found.generation.registration.workflow, found.execution),
        ),
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => true),
      ),
  };

  const children: ChildrenApi = {
    start: (ask: ChildAsk) => lending(admitChild(ask)),
    result: (child: ChildRun) => lending(runChild(child)),
  };

  const admitChild = Effect.fn("Engine.children.start")(function* (given: ChildAsk) {
    const parentId = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id;
    if (parentId === undefined) {
      return yield* refused("a child is started from inside a Run");
    }
    const ask = { ...given, runId: parentId };
    const parent = yield* store.run(ask.runId);
    if (parent === null) {
      return yield* refused(`no run "${ask.runId}" was started here`);
    }
    const generation = yield* resolve({
      project: parent.project,
      id: ask.workflow === "self" ? parent.workflow : ask.workflow,
    }).pipe(Effect.mapError((failure) => refused(failure.reason)));
    const runId = childRunId(ask);
    const parentOptions = yield* decodeStrings(parent.options ?? "{}").pipe(
      Effect.orElseSucceed(() => {
        const none: Record<string, string> = {};
        return none;
      }),
    );
    // WARNING: options are serialisable; no parent Context, service or Layer crosses to the child.
    const parentPreferences = yield* preferencesFromOptions(parentOptions).pipe(
      Effect.mapError((cause) => refused(`claudeSubagents: ${String(cause)}`)),
    );
    const { claudeSubagents, ...preferences } = foldPreferences([
      parentPreferences,
      ...(yield* AgentScopes),
    ]);
    const inherited: Record<string, string> = preferences;
    if (claudeSubagents !== undefined) {
      inherited.claudeSubagents = encodeSubagents(claudeSubagents);
    }
    const asked = { ...inherited, ...ask.options };
    yield* refuseOptions(generation, asked).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    yield* refuseAgent(generation, asked).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const root = Option.match(decodePlacing(parent.placing ?? ""), {
      onNone: () => null,
      onSome: (receipt) => receipt.root ?? null,
    });
    const request = yield* checkoutRequest(generation, asked, root).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const from = request.kind === "existing" ? request.path : placedOf(parent, parentOptions).cwd;
    const settled = yield* settleInput(generation.fields, { json: ask.input, text: {} }).pipe(
      Effect.flatMap((given) => settleTargets(generation, given, from)),
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const payload = yield* Schema.decodeEffect(generation.registration.workflow.payloadSchema)({
      runId,
      input: settled.input,
    }).pipe(Effect.mapError((cause) => refused(`${REFUSED_INPUT}: ${cause.message}`)));
    const launch = Option.getOrUndefined(
      Arr.findFirst(Rec.toEntries(generation.hints), ([, strategy]) =>
        EXCLUSIVE_STRATEGIES.includes(strategy),
      ),
    )?.[0];
    const taskLabel =
      ask.ownTask === true && (yield* store.run(runId)) === null
        ? yield* freshTaskLabel(
            { ...placing.env, cwd: from },
            {
              workflow: generation.id,
              inputs: launch === undefined ? {} : { [launch]: settled.input[launch] ?? null },
            },
            options?.namesTasks === true,
          ).pipe(Effect.provideContext(bun))
        : null;
    const claimed = yield* claimAndPlace({
      // WARNING: the invocation is the claim; changed input is refused, not run twice.
      request: runId,
      run: runId,
      workflow: generation.id,
      project: parent.project,
      input: settled.input,
      provenance: settled.provenance,
      options: launchOptions(generation, asked),
      placing: encodePlacing({ from, taskLabel, root, closes: generation.closes, child: true }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: ask.ownTask === true ? null : parent.task,
      parent: ask.runId,
    }).pipe(Effect.mapError((failure) => refused(failure.reason)));
    // WARNING: a child's checks are frozen from its parent, grants included, never read when it asks.
    const parentChecks = request.kind === "existing" ? [] : yield* approvedOf(dir, parent.run);
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: request.kind === "existing" ? request.path : parent.project,
      userDir,
      approved: parentChecks.length > 0 ? parentChecks : undefined,
    }).pipe(Effect.provideContext(bun), Effect.ignore({ log: "Unhandled" }));
    yield* seedIntentOf({ dir, row: claimed.row, generation, seed: undefined, parent }).pipe(
      Effect.provideContext(bun),
      Effect.ignore({ log: "Unhandled" }),
    );
    if (claimed.fresh) {
      yield* recordFeatures(claimed.row.run, userDir).pipe(Effect.provideContext(bun));
    }
    if (claimed.row.accepted === null) {
      yield* attachInto(claimed.row);
    }
    // WARNING: a sweep must not dispatch a child with no parent to wake; the parent hands its children over here.
    yield* store.accepted(claimed.row.run);
    const at = yield* CurrentStep;
    if (at !== null && claimed.fresh) {
      yield* noteStep(runDir(dir, parent.run), {
        kind: "child",
        key: at.key,
        run: claimed.row.run,
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    }
    return {
      runId: claimed.row.run,
      workflow: generation.id,
      invocation: ask.invocation,
      fresh: claimed.fresh,
    };
  });

  const runChild = Effect.fn("Engine.children.result")(function* (child: ChildRun) {
    const found = yield* routed(child.runId).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const row = yield* store.run(child.runId);
    if (row === null) {
      return yield* refused(`no run "${child.runId}" was started here`);
    }
    const payload = yield* payloadOf(found.generation.registration, row).pipe(
      Effect.mapError(() => refused(`${found.generation.entry} no longer takes ${row.input}`)),
    );
    if (row.parent !== null) {
      yield* runRecords.setControl(AWAITED, row.parent, "", child.runId);
    }
    // WARNING: runs on the parent's fiber; a child's completion wakes the parent and interrupting the parent reaches the child.
    const workflow = found.generation.registration.workflow;
    const written = Schema.encodeUnknownOption(Schema.toCodecJson(workflow.errorSchema));
    // WARNING: no yield may sit between this and the engine's registration, or a finished child re-runs under the same id.
    const derived = row.execution === (yield* workflow.executionId(payload));
    return yield* Effect.suspend(() =>
      derived
        ? // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- A loaded child's erased error schema is encoded and translated to WorkflowError below.
          workflow.execute(payload)
        : // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Saved execution ids use the same erased child error schema and translation below.
          engine.execute(workflow, {
            executionId: row.execution,
            payload,
            suspendedRetrySchedule: workflow.suspendedRetrySchedule,
          }),
    ).pipe(
      Effect.onExit((exit) =>
        row.parent === null || (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
          ? Effect.void
          : runRecords.setControl(AWAITED, row.parent, null, child.runId),
      ),
      Effect.mapError((failure) => {
        if (isWorkflowError(failure)) {
          return failure;
        }
        const encoded = written(failure);
        const text =
          Option.isSome(encoded) && isJson(encoded.value) ? asJsonText(encoded.value) : "";
        return refused(`${child.workflow} failed: ${text}`);
      }),
    );
  });

  const crash = (point: CrashPoint) =>
    crashAt === point
      ? currentPid.pipe(
          Effect.flatMap((pid) => signalProcess(pid, "SIGKILL")),
          Effect.asVoid,
        )
      : Effect.void;

  const payloadOf = (registration: Registration, row: RunRow) =>
    decodeInput(row.input).pipe(
      Effect.flatMap((input) =>
        Schema.decodeEffect(registration.workflow.payloadSchema)({
          runId: row.run,
          input,
        }),
      ),
    );

  // WARNING: nothing happens where the module is unregistered or no longer takes its input; the row stays for a repair.
  // WARNING: the selection the child took is finished here too, so recovery never leaves them open for a second child.
  const finishTaken = Effect.fn("Engine.finishTaken")(function* (row: RunRow, by?: string) {
    const placing = Option.getOrUndefined(decodePlacing(row.placing ?? ""));
    if (placing?.took === undefined || row.parent === null) {
      return;
    }
    const parentDir = `${dir}/runs/${row.parent}`;
    const said = yield* readFindingStatuses(parentDir).pipe(
      Effect.provideService(RunRecords, runRecords),
    );
    const owed = Arr.filter(
      placing.took,
      (id) =>
        !Arr.some(said, (one) => one.id === id && one.status === "taken" && one.run === row.run),
    );
    if (owed.length === 0) {
      yield* storeOpenCount(parentDir).pipe(Effect.provideService(RunRecords, runRecords));
      return;
    }
    const named = Option.flatMap(Option.fromNullishOr(placing.invoked), (text) =>
      Schema.decodeOption(NamedInvocation)(text),
    );
    yield* markTaken(
      parentDir,
      owed,
      Option.getOrElse(
        Option.map(named, (one) => one.offer),
        () => "",
      ),
      row.run,
      by ?? placing.by ?? row.run,
    ).pipe(Effect.provideService(RunRecords, runRecords));
  });

  const handOver = Effect.fn("Engine.handOver")(function* (row: RunRow, clear = true) {
    const generation = live.get(row.generation);
    if (generation === undefined || unplaced(row)) {
      return false;
    }
    const payload = yield* payloadOf(generation.registration, row).pipe(Effect.result);
    if (payload._tag === "Failure") {
      return false;
    }
    yield* attachInto(row);
    yield* crash("admitted");
    yield* finishTaken(row);
    const before = entriesOf.get(generation.registration.workflow)?.get(row.run) ?? 0;
    const old = yield* parkedOf(row.run);
    if (clear) {
      yield* clearParked(row.run);
    }
    yield* releaseEntry(row.run);
    // WARNING: upstream retries a send it cannot route without end; the row stays unaccepted for the next host.
    // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- The registered author's erased error schema reaches this discard call; failures become defects below.
    yield* engine
      .execute(generation.registration.workflow, {
        executionId: row.execution,
        payload: payload.success,
        discard: true,
      })
      .pipe(
        Effect.orDie,
        Effect.timeoutOrElse({
          duration: HAND_OVER_TIMEOUT,
          orElse: () => {
            const refusal = `the engine did not take ${row.run} within ${HAND_OVER_TIMEOUT}; it is recorded, and the next host start hands it over`;
            return Effect.logWarning(refusal).pipe(
              Effect.andThen(Effect.fail(new HostRefused({ reason: refusal }))),
            );
          },
        }),
        Effect.onError(() =>
          clear && (entriesOf.get(generation.registration.workflow)?.get(row.run) ?? 0) === before
            ? restoreParked(row.run, old)
            : Effect.void,
        ),
      );
    yield* crash("executed");
    yield* store.accepted(row.run);
    return true;
  });

  const attachInto = (row: RunRow) =>
    Effect.gen(function* () {
      const own = Option.match(decodeAskedAttachments(row.asked ?? "{}"), {
        onNone: () => [],
        onSome: (asked) => asked.attachments ?? [],
      });
      const inherited: Array<string> = [];
      for (const from of (yield* lineageIn(store)(row.run)).slice(1)) {
        for (const one of yield* listAttachments(attachmentsDir(runDir(dir, from)))) {
          inherited.push(one.path);
        }
      }
      yield* copyInto(attachmentsDir(runDir(dir, row.run)), [...own, ...inherited]);
    }).pipe(
      Effect.provideContext(bun),
      Effect.catch((cause) =>
        Effect.logWarning(`${row.run}'s attachments could not be copied: ${reason(cause)}`),
      ),
    );

  // WARNING: the row is read again under the claim, since another pass may have placed or handed it over.
  const recoverAdmission = (row: RunRow) =>
    claimingOf(row.request).withPermits(1)(
      store.run(row.run).pipe(
        Effect.flatMap((now) =>
          now === null || now.accepted !== null
            ? Effect.succeed(false)
            : placeClaimed(now, false).pipe(Effect.flatMap(handOver)),
        ),
        Effect.catchTag("HostRefused", (failure) =>
          Effect.logWarning(`${row.run} was not started: ${failure.reason}`).pipe(Effect.as(false)),
        ),
      ),
    );

  // WARNING: the engine keeps one completion, so every recorded answer may be handed again.
  const reconcileAnswers = (reached: (run: string) => boolean = () => true) =>
    Effect.gen(function* () {
      const woken: Array<string> = [];
      for (const row of yield* store.runs) {
        if (!reached(row.run)) {
          continue;
        }
        const generation = live.get(row.generation);
        if (generation === undefined) {
          continue;
        }
        const rows = yield* store.asked(row.run);
        const answered = Arr.filter(rows, (one) => one.answer !== null && one.asker === null);
        if (answered.length === 0) {
          continue;
        }
        const state = pollStatus(
          yield* engine.poll(generation.registration.workflow, row.execution),
          generation.entry,
        );
        if (state.status !== "suspended") {
          continue;
        }
        const before = entriesOf.get(generation.registration.workflow)?.get(row.run) ?? 0;
        const old = yield* parkedOf(row.run);
        yield* clearParked(row.run);
        for (const one of answered) {
          yield* answerDecision(generation.registration, {
            name: rootOf(rows, one.decision),
            executionId: row.execution,
            value: one.answer ?? "",
          });
        }
        if (yield* waitForEntry(generation.registration.workflow, row.run, before)) {
          woken.push(row.run);
        } else {
          yield* restoreParked(row.run, old);
        }
      }
      return woken;
    }).pipe(waking.withPermits(1));

  const entryOf = (name: string) =>
    Option.getOrUndefined(Arr.findFirst(known, (route) => route.name === name))?.entry ?? "";

  const claimOf = (runId: string) =>
    recordedClaims(claimPath(dir, runId)).pipe(
      Effect.map((held) =>
        held.length === 0
          ? null
          : Arr.join(
              Arr.map(held, (one) => one.slug),
              ", ",
            ),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  const finished = new Map<string, typeof RunStatus.Type>();
  const shared: KeptViews | undefined =
    options?.keep === undefined ? undefined : { revision: options.keep.revision, views: new Map() };
  const polled = Effect.fn("Engine.polled")(function* (generation: Generation, execution: string) {
    const workflow = generation.registration.workflow;
    const status = pollStatus(
      yield* engine.poll(workflow, execution),
      generation.entry,
      workflow.successSchema,
      workflow.errorSchema,
    );
    if (status.status === "complete" || status.status === "failed") {
      finished.set(execution, status);
    }
    return status;
  });

  // WARNING: query by shard and processed; by entity alone it scans every message on each sweep.
  const wakeOf = Effect.fn("Engine.wakeOf")(function* (execution: string) {
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (Option.isNone(sql)) {
      return null;
    }
    const rows = yield* sql.value<{ readonly deliver_at: number | null }>`
      SELECT deliver_at FROM cluster_messages
      WHERE shard_id = ${ONE_SHARD} AND processed = 0
        AND entity_type = 'Workflow/-/DurableClock' AND entity_id = ${execution}
      ORDER BY deliver_at LIMIT 1
    `.pipe(Effect.orElseSucceed(() => []));
    const at = rows[0]?.deliver_at ?? null;
    return at === null ? null : DateTime.formatIso(DateTime.makeUnsafe(Number(at)));
  });

  const asleep = new Map<
    string,
    { readonly status: typeof RunStatus.Type; readonly wakes: string | null; readonly at: number }
  >();
  const stillAsleep = (execution: string) =>
    touches !== undefined && asleep.get(execution)?.at === touches.of(execution);
  const engineSays = Effect.fn("Engine.engineSays")(function* (
    generation: Generation,
    execution: string,
  ) {
    const done = finished.get(execution);
    if (done !== undefined) {
      return { status: done, wakes: null };
    }
    const kept = asleep.get(execution);
    if (kept !== undefined && stillAsleep(execution)) {
      return kept;
    }
    // WARNING: read the count before polling, so a write landing during the poll is not missed.
    const at = touches?.of(execution);
    const status = yield* polled(generation, execution);
    if (status.status !== "suspended") {
      asleep.delete(execution);
      return { status, wakes: null };
    }
    const read = { status, wakes: yield* wakeOf(execution), at: at ?? Number.NaN };
    if (at !== undefined) {
      asleep.set(execution, read);
    }
    return read;
  });

  const viewOf = Effect.fn("Engine.viewOf")(function* (row: RunRow, read?: FileSystem.FileSystem) {
    const fs = read ?? hostFs;
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const placing = Option.getOrUndefined(decodePlacing(row.placing ?? ""));
    const report = Option.getOrUndefined(
      Schema.decodeOption(Schema.fromJsonString(RunReport))(row.report ?? ""),
    );
    const linkNotices = yield* readLinkDeliveries(runDir(dir, row.run)).pipe(
      Effect.provideContext(bun),
    );
    const admitted = {
      requestedBy: placing?.requestedBy,
      ...(placing?.heals !== undefined && { heals: placing.heals }),
      closes: placing?.closes,
      report,
      linkNotices: linkNotices.length === 0 ? undefined : linkNotices,
      stepNotes: (yield* readStepSteering(runDir(dir, row.run)).pipe(Effect.provideContext(bun)))
        .notes,
      runId: row.run,
      workflow: row.workflow,
      project: row.project,
      task: row.task,
      parent: row.parent,
      registration: row.generation,
      entry: entryOf(row.generation),
      input,
      provenance: yield* decodeStrings(row.provenance ?? "{}").pipe(
        Effect.orElseSucceed(() => {
          const none: Record<string, string> = {};
          return none;
        }),
      ),
      options: yield* decodeStrings(row.options ?? "{}").pipe(
        Effect.orElseSucceed(() => {
          const none: Record<string, string> = {};
          return none;
        }),
        Effect.flatMap((options) => optionsNow(dir, row.run, options)),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideContext(bun),
      ),
    };
    const { cwd, branch, workspace, worktree } = placedOf(row, admitted.options);
    const outcome = admitted.options.outcome ?? UNSPECIFIED;
    const generation = live.get(row.generation);
    const controls = yield* runRecords.controlsIn([row.run]);
    const control = (name: string) =>
      Option.getOrNull(
        Option.map(
          Arr.findFirst(controls.get(row.run) ?? [], (one) => one.control === name),
          (one) => one.data,
        ),
      );
    const parked = control(PARKED);
    const metrics = yield* readMetrics(evidenceDir(dir, row.run)).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideContext(bun),
    );
    const recovery = recoveriesIn(metrics);
    const lastPark = Option.getOrUndefined(Arr.findLast(metrics, (line) => line.kind === "halt"));
    const info =
      parked === null
        ? null
        : ((yield* parkInfoOf(control(PARK_INFO))) ?? {
            ...parkOf(parkCauseOf(control(PARK_CAUSE))),
            id: lastPark?.park ?? lastPark?.at ?? row.admitted,
            since: lastPark?.at ?? row.admitted,
          });
    const catalogue = yield* Effect.serviceOption(Artefacts);
    const reading: Types.Mutable<Pick<RunView, "narratives">> = {};
    if (Option.isSome(catalogue)) {
      reading.narratives = yield* catalogue.value.reports(row.run);
    }
    const about = {
      ...reading,
      ...admitted,
      strategies: generation?.hints ?? {},
      cwd,
      branch,
      workspace,
      worktree,
      outcome,
      created: row.admitted,
      waiting: yield* steered(row.run),
      controls: Arr.filter([HOLD, STOP], (one) => control(one) !== null),
      parked,
      park: parked === null ? null : parkWithRecovery(info!, recovery),
      recovery: Arr.map(recovery.slice(-20), recoveryLine),
      awaiting: yield* Schema.decodeUnknownEffect(AwaitingJson)(control(AWAITING)).pipe(
        Effect.orElseSucceed(() => null),
      ),
      usage: yield* Schema.decodeUnknownEffect(UsageWaitJson)(control(USAGE)).pipe(
        Effect.orElseSucceed(() => null),
      ),
      mr: yield* mergeRequestOf(row.run),
      landing: yield* readLanding(runDir(dir, row.run)).pipe(Effect.provideContext(bun)),
      measurement:
        outcome === "performance"
          ? finalMeasurementLine(
              yield* readMeasurements(evidenceDir(dir, row.run)).pipe(
                Effect.provideContext(bun),
                Effect.orElseSucceed(() => [] satisfies ReadonlyArray<Measurement>),
              ),
            )
          : null,
    };
    if (generation === undefined) {
      const recorded = yield* RunRecords.use((records) => records.fact(row.run, TERMINAL)).pipe(
        Effect.provideContext(bun),
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RunStatus))),
        Effect.orElseSucceed(() => null),
      );
      const finished = yield* finishedOnRecord(runDir(dir, row.run)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideContext(bun),
      );
      return {
        ...about,
        status:
          recorded?.status === "failed"
            ? { ...recorded, entry: admitted.entry || recorded.entry }
            : recorded?.status === "complete"
              ? recorded
              : finished !== null
                ? { status: "ended" as const, at: finished }
                : { status: "pending" as const },
        diagnostic:
          unavailable.get(row.generation) ?? `${row.generation} is not registered in this host`,
      };
    }
    const { status, wakes } = yield* engineSays(generation, row.execution);
    // WARNING: a failed Run keeps its claim, which may guard half-done shared work.
    const kept = status.status === "failed" ? yield* claimOf(row.run) : null;
    return {
      ...about,
      status,
      wakes,
      diagnostic:
        kept === null
          ? null
          : `claim on ${kept} retained; recovery required: a new Run of ${row.workflow} takes it over and closes this Run's agents`,
    };
  });

  const setControl = Effect.fn("Engine.setControl")(function* (
    runId: string,
    control: string,
    set: boolean,
  ) {
    yield* runRecords.setControl(control, runId, set ? yield* nowIso : null);
  });

  const controlsOf = Effect.fn("Engine.controlsOf")(function* (runId: string) {
    const set: Array<string> = [];
    for (const control of [HOLD, STOP]) {
      if ((yield* runRecords.control(control, runId)) !== null) {
        set.push(control);
      }
    }
    return set;
  });

  // WARNING: return only once the run has settled, or a completion landing mid-wake is lost.
  const wake = Effect.fn("Engine.wake")(function* (
    runId: string,
    found: {
      readonly generation: Generation;
      readonly execution: string;
    },
    recoveryPark?: string,
  ) {
    const claim =
      recoveryPark === undefined
        ? undefined
        : Option.getOrUndefined(
            Arr.findLast(
              yield* readMetrics(evidenceDir(dir, runId)),
              (line) =>
                line.park === recoveryPark &&
                line.action === "resumed" &&
                line.outcome === "claimed",
            ),
          );
    const recoveryEntered = () =>
      readStepLines(runDir(dir, runId)).pipe(
        Effect.map(
          (lines) =>
            claim !== undefined &&
            (claim.entries === undefined
              ? Arr.some(
                  lines,
                  (line) => line.kind === "entry" && epochMs(line.at) >= epochMs(claim.at),
                )
              : Arr.filter(lines, (line) => line.kind === "entry").length > claim.entries),
        ),
      );
    if (recoveryPark !== undefined) {
      if (yield* recoveryEntered()) {
        return true;
      }
      const row = yield* store.run(runId);
      const view = row === null ? null : yield* viewOf(row);
      const savedPark = yield* parkInfoOf(yield* runRecords.control(PARK_INFO, runId));
      if (
        claim === undefined ||
        view === null ||
        (view.park === null ? savedPark?.id !== recoveryPark : view.park?.id !== recoveryPark) ||
        view.controls.length > 0 ||
        Arr.some(
          view.waiting,
          (one) =>
            isUnanswered(one) ||
            isSetAside(view.waiting, one) ||
            (one.asker != null && one.answer === null),
        )
      ) {
        return yield* new HostRefused({
          reason: "The park is no longer eligible for automatic resume",
        });
      }
    }
    const workflow = found.generation.registration.workflow;
    const status = pollStatus(
      yield* engine.poll(workflow, found.execution),
      found.generation.entry,
    ).status;
    if (status === "suspended") {
      const entries = entriesOf.get(workflow);
      const before = entries?.get(runId) ?? 0;
      const old = yield* parkedOf(runId);
      yield* clearParked(runId);
      if (recoveryPark !== undefined) {
        yield* crash("recovery-park-cleared");
      }
      yield* engine
        .resume(workflow, found.execution)
        .pipe(Effect.onError(() => restoreParked(runId, old)));
      const entered = yield* waitForEntry(workflow, runId, before);
      if (!entered) {
        yield* restoreParked(runId, old);
        return yield* new HostRefused({ reason: `${runId} did not take up its suspended work` });
      }
    }
    yield* settle(found);
    if (recoveryPark !== undefined) {
      yield* crash("recovery-entered");
    }
    if (recoveryPark !== undefined && !(yield* recoveryEntered())) {
      return yield* new HostRefused({
        reason: `${runId} has not recorded entry after its recovery claim`,
      });
    }
    return recoveryPark !== undefined || status === "suspended";
  }, waking.withPermits(1));

  // WARNING: a control read at a boundary is read again after the suspend, or a release landing before it is lost.
  const armed = new Map<string, object>();
  const boundary = (read: Effect.Effect<boolean>, control: string, runId: string) =>
    Effect.tap(read, (on) => {
      const key = `${control}\u0000${runId}`;
      if (!on) {
        armed.delete(key);
      }
      if (!on || armed.has(key)) {
        return Effect.void;
      }
      const token = {};
      armed.set(key, token);
      const current = () => armed.get(key) === token;
      return Effect.gen(function* () {
        const found = yield* routed(runId);
        const workflow = found.generation.registration.workflow;
        yield* engine.poll(workflow, found.execution).pipe(
          Effect.map((result) => pollStatus(result, found.generation.entry).status),
          Effect.repeat({
            until: (status) => status !== "pending" || !current(),
            schedule: Schedule.spaced(WAKE_INTERVAL),
          }),
        );
        if (!current()) {
          return;
        }
        armed.delete(key);
        if (!(yield* controlsOf(runId)).includes(control)) {
          yield* wake(runId, found);
        }
      }).pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => current() && armed.delete(key))),
        Effect.provideService(RunRecords, runRecords),
        Effect.forkIn(hostScope),
        Effect.asVoid,
      );
    });

  const settle = (found: { readonly generation: Generation; readonly execution: string }) =>
    engine.poll(found.generation.registration.workflow, found.execution).pipe(
      Effect.map((result) => pollStatus(result, found.generation.entry).status),
      Effect.repeat({
        until: (status) => status !== "pending",
        times: WAKE_TRIES,
        schedule: Schedule.spaced(WAKE_INTERVAL),
      }),
      Effect.ignore,
    );

  const asked = Effect.fn("Engine.asked")(function* (runId: string) {
    const rows = yield* store.asked(runId);
    const none: ReadonlyArray<Solution> = [];
    return yield* Effect.forEach(rows, (row) =>
      decodeOptions(row.options).pipe(
        Effect.orElseSucceed(() => none),
        Effect.map((options) => {
          const question = {
            name: row.decision,
            prompt: row.prompt,
            options: recommendedFirst(options),
            answer: row.answer,
            asked: row.asked,
            answered: row.answered,
            by: row.answerer === null ? null : whoActed(row.answerer),
            asker: row.asker,
            superseded: row.superseded,
            cause: row.cause,
            messaged: Arr.map(row.messaged ?? [], (one) => one.agent),
            revises: row.revises,
            shortfall: row.shortfall,
          };
          return row.shipping === null ? question : { ...question, shipping: row.shipping };
        }),
      ),
    );
  });

  const steered = Effect.fn("Engine.steered")(function* (runId: string) {
    const waiting = yield* asked(runId);
    if (!Arr.some(waiting, isUnanswered)) {
      return waiting;
    }
    const fs = yield* FileSystem.FileSystem;
    const launches = yield* readLaunches(runId).pipe(Effect.orElseSucceed(() => []));
    const candidates = yield* Effect.forEach(launches, (one) =>
      fs.exists(one.output).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((done) => ({ ...one, done })),
      ),
    );
    const steer = steerTarget(candidates, {})?.agent ?? null;
    return Arr.map(waiting, (one) =>
      isUnanswered(one)
        ? {
            ...one,
            steer:
              one.asker === null
                ? steer
                : (Option.getOrUndefined(
                    Arr.findLast(launches, (launch) => launch.operation === one.asker),
                  )?.agent ?? null),
          }
        : one,
    );
  }, Effect.provideContext(bun));

  const keptHit = (row: RunRow, decided: (run: string) => number, kept: KeptViews) => {
    const was = kept.views.get(row.run);
    return was !== undefined &&
      was.decided === decided(row.run) &&
      was.revision === kept.revision(row.run) &&
      was.engine === touches?.of(row.execution) &&
      sameRow(was.row, row)
      ? was.view
      : undefined;
  };

  const keepView = (
    row: RunRow,
    decided: (run: string) => number,
    kept: KeptViews,
    read?: FileSystem.FileSystem,
  ) =>
    Effect.gen(function* () {
      const before = {
        decided: decided(row.run),
        revision: kept.revision(row.run),
        engine: touches?.of(row.execution),
      };
      yield* (yield* Foreground).boundary;
      const view = yield* viewOf(row, read);
      // WARNING: a settled status is final, a suspended one stands until the engine writes, and a running one is polled.
      if (finished.has(row.execution) || stillAsleep(row.execution)) {
        kept.views.set(row.run, { row, ...before, view });
      } else {
        kept.views.delete(row.run);
      }
      return view;
    });

  const keptViews = (
    rows: ReadonlyArray<RunRow>,
    concurrency: number,
    read?: FileSystem.FileSystem,
    kept?: KeptViews,
  ) =>
    Effect.gen(function* () {
      if (kept === undefined) {
        return yield* Effect.forEach(rows, (row) => viewOf(row, read), { concurrency });
      }
      const decided = yield* store.decided;
      const views: Array<RunView | undefined> = Arr.map(rows, (row) => keptHit(row, decided, kept));
      yield* Effect.forEach(
        rows,
        (row, at) =>
          views[at] === undefined
            ? Effect.map(keepView(row, decided, kept, read), (view) => {
                views[at] = view;
              })
            : Effect.void,
        { concurrency, discard: true },
      );
      // WARNING: every slot a hit left empty was filled by its keepView above.
      return views as Array<RunView>;
    });

  const view = (runId: string) =>
    store
      .run(runId)
      .pipe(Effect.flatMap((row) => (row === null ? Effect.succeed(null) : viewOf(row))));

  // WARNING: writes to upstream's tables invalidate nothing of Collie's, so one shared fiber polls on a schedule.
  const watched = new Map<string, { readonly row: RunRow; said: string }>();
  const remember = (row: RunRow) => watched.set(row.run, { row, said: "" });
  for (const row of yield* store.runs) {
    remember(row);
  }
  let watchers = 0;

  let sweeps = 0;
  const sweep = Effect.gen(function* () {
    if (watchers === 0) {
      return;
    }
    const { boundary } = yield* Foreground;
    const whole = ++sweeps % WHOLE_SWEEP_EVERY === 0;
    let changed = false;
    for (const [runId, entry] of watched) {
      if (!whole && entry.said !== "" && stillAsleep(entry.row.execution)) {
        continue;
      }
      yield* boundary;
      const view = yield* viewOf(entry.row);
      const said = encodeView(view);
      if (said === entry.said) {
        continue;
      }
      entry.said = said;
      changed = true;
      if (terminalStatus(view.status)) {
        watched.delete(runId);
      }
    }
    if (changed) {
      yield* store.announce;
    }
  });
  yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  const held = Effect.sync(() => ({
    live: [...live.keys()].sort(),
    unavailable: Arr.map([...unavailable.entries()], ([name, why]) => `${name}: ${why}`).sort(),
  }));

  const newest = Effect.fn("Engine.newest")(function* (id: string) {
    const generation = live.get(newestOf.get(id) ?? "");
    if (!generation) {
      return yield* new HostRefused({ reason: `no workflow "${id}" is loaded here` });
    }
    return generation;
  });

  const routed = Effect.fn("Engine.routed")(function* (runId: string) {
    yield* Deferred.await(generationsRegistered);
    const row = yield* store.run(runId);
    if (row === null) {
      return yield* new HostRefused({ reason: `no run "${runId}" was started here` });
    }
    const generation = live.get(row.generation);
    if (!generation) {
      return yield* new HostRefused({
        reason:
          unavailable.get(row.generation) ?? `${row.generation} is not registered in this host`,
      });
    }
    return { generation, execution: row.execution };
  });

  const hasEnded = Effect.fn("Engine.hasEnded")(function* (runId: string) {
    if ((yield* controlsOf(runId)).includes(STOP)) {
      return true;
    }
    return yield* workflowEnded(runId);
  });

  const workflowEnded = Effect.fn("Engine.workflowEnded")(function* (runId: string) {
    const found = yield* routed(runId).pipe(Effect.option);
    if (Option.isNone(found)) {
      const current = yield* view(runId);
      return current !== null && terminalStatus(current.status);
    }
    const { generation, execution } = found.value;
    const workflow = generation.registration.workflow;
    const status = pollStatus(
      yield* engine.poll(workflow, execution),
      generation.entry,
      workflow.successSchema,
      workflow.errorSchema,
    ).status;
    return status === "complete" || status === "failed";
  });

  const supersedeQuestion = Effect.fn("Engine.supersedeQuestion")(function* (
    options: Parameters<RegistryApi["supersede"]>[0],
  ) {
    const superseded = yield* store.supersede({
      run: options.runId,
      decision: options.decision,
      cause: options.cause,
      actor: actorOf(options.by, options.cause),
      agent: options.agent,
    });
    if (superseded._tag === "accepted") {
      yield* recordAudit(runDir(dir, options.runId), {
        ...options.by,
        operation: "supersede",
        request: options.cause,
        result: SupersedeRecord,
        value: { decision: options.decision, agent: options.agent },
      }).pipe(Effect.orDie);
    }
    return superseded;
  });

  const seenWorking = new Set<string>();

  const supersedeFor = Effect.fn("Engine.supersedeFor")(function* (
    runId: string,
    cause: string,
    actor: Asker,
    agent: string,
    submitted = Infinity,
    read?: {
      readonly rows: ReadonlyArray<DecisionRow>;
      readonly launches: ReadonlyArray<Launched>;
    },
  ) {
    const launches =
      read?.launches ?? (yield* readLaunches(runId).pipe(Effect.orElseSucceed(() => [])));
    const rows = read?.rows ?? (yield* store.asked(runId));
    const { aside, extended } = touchedBy(rows, launches, agent, submitted);
    const written = new Map(Arr.map(rows, (one) => [one.decision, one] as const));
    for (const one of aside) {
      const superseded = yield* supersedeQuestion({
        runId,
        decision: one.decision,
        cause,
        by: actor,
        agent,
      });
      if (superseded._tag === "accepted") {
        written.set(one.decision, superseded.row);
      }
    }
    for (const one of extended) {
      seenWorking.delete(`${runId}/${one.decision}/${agent}`);
      const messaged = yield* store.alsoMessaged({ run: runId, decision: one.decision, agent });
      if (messaged !== undefined) {
        written.set(one.decision, messaged);
      }
    }
    return [...written.values()];
  });

  const superseding = (runId: string, actor: Asker | undefined, sent: typeof Steered.Type) =>
    sent.delivered && sent.delivery !== undefined && actor !== undefined && speaksForHuman(actor)
      ? supersedeFor(runId, sent.delivery, actor, sent.agent)
      : Effect.void;

  // WARNING: a message typed into a Claude pane is recorded external by its hook, and may already be delivered.
  const missedMessages = Effect.gen(function* () {
    const runs = Arr.dedupe(Arr.map(yield* store.supersedable, (row) => row.run));
    if (runs.length === 0) {
      return;
    }
    const delivered = yield* humanSubmits;
    const askedOf = yield* store.askedOf(runs);
    const launchesOfRuns = yield* launchesOf(runs);
    for (const runId of runs) {
      let rows = askedOf.get(runId) ?? [];
      const launches = launchesOfRuns.get(runId) ?? [];
      const typed = yield* Effect.forEach(
        Arr.dedupe(Arr.map(launches, (launch) => launch.agent)),
        (agent) =>
          Effect.gen(function* () {
            const ats = yield* externalSubmits(yield* controlDir(placing.env.stateDir, agent)).pipe(
              Effect.orElseSucceed(() => []),
            );
            return Arr.map(ats, (at) => ({
              cause: `${agent}:submit:${at}`,
              actor: { origin: "cli-tty" } as const,
              agent,
              at,
            }));
          }),
      );
      const sent = Arr.flatMap(delivered, (one) =>
        one.run === runId
          ? [{ cause: one.id, actor: one.human, agent: one.agent, at: epochMs(one.at) }]
          : [],
      );
      for (const one of [...sent, ...Arr.flatten(typed)]) {
        const touched = touchedBy(rows, launches, one.agent, one.at);
        if (touched.aside.length + touched.extended.length === 0) {
          continue;
        }
        rows = yield* supersedeFor(runId, one.cause, one.actor, one.agent, one.at, {
          rows,
          launches,
        });
      }
    }
  });
  const graceMs = options?.supersedeGraceMs ?? SUPERSEDE_GRACE_MS;

  const awaitsRoot = Effect.fn("Engine.awaitsRoot")(function* (
    runId: string,
    rows: ReadonlyArray<DecisionRow>,
    decision: string,
  ) {
    const root = Arr.findFirst(rows, (one) => one.decision === rootOf(rows, decision));
    if (Option.isNone(root)) {
      return false;
    }
    const entry = Arr.findLast(
      yield* readStepLines(runDir(dir, runId)),
      (line) => line.kind === "entry",
    );
    return (
      Option.isNone(entry) ||
      epochMs(root.value.reached ?? root.value.asked) >= epochMs(entry.value.at)
    );
  });

  const reviseQuestions = Effect.gen(function* () {
    const agents = yield* Agents;
    const setAside = yield* store.setAside;
    const setAsideRuns = Arr.dedupe(Arr.map(setAside, (row) => row.run));
    const askedOf = yield* store.askedOf(setAsideRuns);
    const launchesOfRuns = yield* launchesOf(setAsideRuns);
    for (const row of setAside) {
      if ((yield* controlsOf(row.run)).includes(STOP)) {
        continue;
      }
      const found = yield* routed(row.run).pipe(Effect.option);
      if (Option.isNone(found)) {
        continue;
      }
      const { generation, execution } = found.value;
      const state = pollStatus(
        yield* engine.poll(generation.registration.workflow, execution),
        generation.entry,
      );
      if (state.status !== "suspended") {
        continue;
      }
      const rows = askedOf.get(row.run) ?? [];
      if (!(yield* awaitsRoot(row.run, rows, row.decision))) {
        continue;
      }
      const launches = launchesOfRuns.get(row.run) ?? [];
      const messaged = row.messaged ?? [];
      const keyOf = (agent: string) => `${row.run}/${row.decision}/${agent}`;
      const finished = Effect.fn("Engine.finished")(function* (agent: string, since: string) {
        const status = yield* agents.statusOf(agent);
        if (status === "working" || status === "blocked") {
          seenWorking.add(keyOf(agent));
          return false;
        }
        if (status === "gone") {
          return true;
        }
        if (status === "unknown") {
          return false;
        }
        const asksItself = Arr.some(
          rows,
          (one) => one.asker !== null && isUnanswered(one) && asksAs(launches, one.asker, agent),
        );
        if (asksItself) {
          return false;
        }
        return (
          seenWorking.has(keyOf(agent)) ||
          (yield* Clock.currentTimeMillis) - epochMs(since) >= graceMs
        );
      });
      const ended = yield* Effect.forEach(messaged, (one) => finished(one.agent, one.at));
      if (!Arr.every(ended, (one) => one)) {
        continue;
      }
      const lineage = lineageOf(rows, row.decision);
      const name = `${lineage[0]}.r${lineage.length + 1}`;
      for (const one of messaged) {
        seenWorking.delete(keyOf(one.agent));
      }
      if (!(yield* store.revise({ run: row.run, decision: row.decision, name, messaged }))) {
        continue;
      }
      const notifier = yield* Effect.serviceOption(Notifier);
      if (Option.isSome(notifier)) {
        yield* notifier.value.notify(row.run, "needs-you", `${name}: ${row.prompt}`, {
          key: `ask:${name}`,
        });
      }
    }
  });

  const agentIn = Effect.fn("Engine.agentIn")(function* (dir: string) {
    const real = (at: string) => fs.realPath(at).pipe(Effect.orElseSucceed(() => at));
    const agents = yield* Effect.result(placing.herdr.agentList());
    if (agents._tag === "Failure") {
      return "core would not say which agents work in it";
    }
    for (const agent of agents.success) {
      for (const at of [agent.cwd, agent.foregroundCwd]) {
        if (at === null) {
          continue;
        }
        const there = yield* real(at);
        if (there === dir || pipe(there, Str.startsWith(`${dir}/`))) {
          return `agent ${agent.name} in terminal ${agent.paneId} works in it`;
        }
      }
    }
    const servers = yield* unlistedServers(placing.env.stateDir, [placing.herdr]);
    if (servers === null) {
      return "core would not say which agents it has";
    }
    for (const record of servers) {
      const there = yield* real(record.cwd);
      if (there === dir || pipe(there, Str.startsWith(`${dir}/`))) {
        return `${record.agent}'s server may still be writing in it`;
      }
    }
    return null;
  }, Effect.provideContext(bun));

  const unended = Effect.fn("Engine.unended")(function* (runs: ReadonlyArray<string>) {
    for (const runId of runs) {
      if (!(yield* workflowEnded(runId))) {
        return `${runId} has not ended and may still go on in it`;
      }
    }
    return null;
  }, Effect.provideContext(hostServices));

  const releaseRuns = Effect.fn("Engine.releaseRuns")(function* (runs: ReadonlyArray<string>) {
    const live = yield* unended(runs);
    if (live !== null) {
      return live;
    }
    const agents = yield* Agents;
    const left: Array<string> = [];
    for (const runId of runs) {
      left.push(...(yield* agents.halt(runId)).left);
    }
    return left.length === 0 ? null : `its agents did not all close (${Arr.join(left, "; ")})`;
  }, Effect.provideContext(hostServices));

  const applyControl = Effect.fn("Engine.applyControl")(function* (
    runId: string,
    control: string,
    set: boolean,
    recovered?: ReadonlySet<string>,
    alone = false,
    healing?: string,
  ) {
    const runs =
      control === STOP && !alone ? [runId, ...descendantsOf(yield* store.runs, runId)] : [runId];
    if (healing !== undefined && control === STOP && !set) {
      for (const one of runs) {
        if ((yield* controlsOf(one)).includes(STOP)) {
          return yield* new HostRefused({
            reason: `${one}: a person stopped it, and only a person resumes it`,
          });
        }
      }
      if ((yield* view(runId))?.park?.id !== healing) {
        return yield* new HostRefused({
          reason: `${runId} has left park ${healing}, the one its Heal was started for`,
        });
      }
    }
    // WARNING: the stop is written before anything wakes, so a woken run never finds the request that stopped it.
    const stopped = new Set<string>();
    for (const one of runs) {
      if (control === STOP && !set && (yield* controlsOf(one)).includes(STOP)) {
        stopped.add(one);
      }
      yield* setControl(one, control, set);
    }
    yield* store.announce;
    // WARNING: a hold needs no wake, since a held run reads it at the next boundary; every other control needs one.
    const woken: Array<string> = [];
    if (!(control === HOLD && set)) {
      for (const one of runs) {
        if (recovered?.has(one) && !stopped.has(one)) {
          continue;
        }
        const found = yield* routed(one).pipe(Effect.option);
        if (Option.isSome(found) && (yield* wake(one, found.value))) {
          woken.push(one);
        }
      }
    }
    return { runs, woken };
  }, controlling.withPermits(1));

  const stopTree = Effect.fn("Engine.stopTree")(function* (
    runId: string,
    alone = false,
    reason?: string,
  ) {
    const { runs } = yield* applyControl(runId, STOP, true, undefined, alone);
    for (const one of runs) {
      yield* forgetWatch(one);
    }
    const agents = yield* Agents;
    const left: Array<string> = [];
    for (const one of runs) {
      left.push(...(yield* agents.halt(one, reason)).left);
    }
    return { runs, left };
  });

  // WARNING: one registration at a time, or two starts minting one name would stage over each other.
  const registering = yield* Semaphore.make(1);
  // WARNING: a grant reads and writes one file; concurrent grants would drop each other's.
  const invoking = yield* Semaphore.make(1);

  const mint = Effect.fn("Engine.Registry.mint")(function* (file: string) {
    const described = yield* stageEntry(file);
    const route = {
      workflow: described.entry.id,
      name: nextRegistrationName(known, described.entry.id),
      entry: file,
    };
    const generation = yield* register(route, undefined, described);
    known = [...known, route];
    yield* store.remember(route);
    return generation;
  });

  const useEntry = (options: { readonly entry: string; readonly revision: string }) =>
    registering.withPermits(1)(
      Effect.gen(function* () {
        const source = `${options.entry}@${options.revision}`;
        for (const generation of live.values()) {
          if (generation.source === source) {
            return generation;
          }
        }
        return yield* mint(options.entry);
      }),
    );

  const resolve = Effect.fn("Engine.Registry.resolve")(function* (options: {
    readonly project: string;
    readonly id: string;
  }) {
    if (locate === undefined) {
      return yield* newest(options.id);
    }
    const found = yield* locate(options);
    return yield* useEntry(found).pipe(
      Effect.mapError(
        (failure) => new HostRefused({ reason: `${failure.file}: ${failure.message}` }),
      ),
    );
  });

  const unfilled = (offer: Offer, project: string, filled: Readonly<Record<string, Schema.Json>>) =>
    resolve({ project, id: offer.workflow }).pipe(
      Effect.map((target) => {
        const field = fieldWith(target.hints, "work-source");
        if (field !== undefined) {
          offer = { ...offer, textField: field };
        }
        const rest = Arr.filter(
          Rec.toEntries(target.fields),
          ([name]) => !(name in filled) && target.hints[name] !== "internal",
        );
        if (rest.length === 0) {
          return offer;
        }
        return {
          ...offer,
          arguments: jsonSchemaFor(Schema.Struct(Rec.fromEntries(rest))).document,
        };
      }),
      Effect.orElseSucceed(() => offer),
    );

  const unbound = (offer: Offer, project: string) =>
    resolve({ project, id: offer.workflow }).pipe(
      Effect.map((target) => Rec.keys(Rec.filter(target.hints, (hint) => hint === "internal"))),
      Effect.orElseSucceed(() => [] satisfies ReadonlyArray<string>),
      Effect.map((internal) => ({
        ...offer,
        arguments: argumentsWithout(
          offer.arguments,
          new Set([...Rec.keys(offer.given ?? {}), ...internal]),
        ),
      })),
    );

  const chosenFor = Effect.fn("Engine.Registry.chosen")(function* (
    offer: Offer,
    given: Schema.Json | undefined,
    runDir: string,
  ) {
    const ids = idsIn(given);
    if (ids === null) {
      return yield* new HostRefused({
        reason: `"${offer.id}" takes its findings as ids, given as a list`,
      });
    }
    if (offer.selects === "one" && ids.length !== 1) {
      return yield* new HostRefused({
        reason: `"${offer.id}" is taken for exactly one finding, not ${ids.length}`,
      });
    }
    const open = Arr.filter(yield* findingsWithStatus(runDir), (one) => isOpenFinding(one.status));
    const unknown = Arr.findFirst(ids, (id) => !Arr.some(open, (one) => one.id === id));
    if (Option.isSome(unknown)) {
      return yield* new HostRefused({
        reason: `"${unknown.value}" is not one of the findings still open on this Run`,
      });
    }
    return ids;
  });

  const findingFor = Effect.fn("Engine.Registry.finding")(function* (runDir: string, id: string) {
    const found = Option.getOrUndefined(
      Arr.findFirst(yield* findingsWithStatus(runDir), (one) => one.id === id),
    );
    return found === undefined ? undefined : findingText(found, yield* reportIn(runDir));
  });

  const recoveryNow = (runId: string, workSource: string) =>
    recoveryFor(store, dir, runId, runId, workSource).pipe(
      Effect.tap((recovery) =>
        Effect.gen(function* () {
          const text = encodeRecovery(recovery);
          // WARNING: writing an unchanged fact would move the card.
          if ((yield* runRecords.fact(runId, SYNCED_RECOVERY)) !== text) {
            yield* runRecords.put(runId, SYNCED_RECOVERY, text);
          }
        }),
      ),
      Effect.provideContext(bun),
    );

  const syncRecovery = Effect.fn("Engine.Registry.syncRecovery")(function* (runId: string) {
    const row = yield* store.run(runId);
    if (row === null) {
      return;
    }
    const generation = yield* resolve({ project: row.project, id: row.workflow }).pipe(
      onSyncedRevisions,
    );
    const work = fieldWith(generation.hints, "work-source");
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const workSource =
      work === undefined ? undefined : Rec.get(input, work).pipe(Option.getOrUndefined);
    if (isText(workSource) && Arr.some(generation.offers, (offer) => offer.entry !== undefined)) {
      yield* recoveryNow(runId, workSource);
    }
  });

  // WARNING: a removed module leaves the Run readable but refuses its offers.
  const offeredBy = Effect.fn("Engine.Registry.offeredBy")(function* (
    runId: string,
    request?: string,
    given: Readonly<Record<string, Schema.Json>> = {},
  ) {
    const row = yield* store.run(runId);
    if (row === null) {
      return yield* new HostRefused({ reason: `no run "${runId}" was started here` });
    }
    const generation = yield* resolve({ project: row.project, id: row.workflow });
    const options = yield* decodeStrings(row.options ?? "{}").pipe(
      Effect.orElseSucceed(() => {
        const none: Record<string, string> = {};
        return none;
      }),
      Effect.flatMap((admitted) => optionsNow(dir, runId, admitted)),
      Effect.provideContext(bun),
    );
    const found = yield* routed(runId);
    const state = pollStatus(
      yield* engine.poll(found.generation.registration.workflow, found.execution),
      found.generation.entry,
    );
    const asked = options.outcome ?? UNSPECIFIED;
    const where = runDir(dir, runId);
    const disposition = latest(
      yield* readDispositions(where).pipe(
        Effect.orElseSucceed(() => [] satisfies Array<Disposition>),
      ),
    );
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const facts: Types.Mutable<ActionFacts> = {
      outcome: isOutcome(asked) ? asked : "unspecified",
      succeeded: state.status === "complete",
      branch: placedOf(row, options).branch,
      mrUrl: yield* mergeRequestOf(runId),
      nothingToLand: (yield* runRecords.fact(runId, NOTHING_TO_LAND)) !== null,
      planIssues: yield* planIssuesIn(where),
      disposed: disposition !== null,
      openFindings: yield* openFindingsRead(where),
      diffTarget: pointedAt(generation, input),
      claim: yield* claimOf(runId),
    };
    const work = fieldWith(generation.hints, "work-source");
    let unread: string | null = null;
    if (
      facts.diffTarget !== null &&
      readMrRef(facts.diffTarget) !== null &&
      facts.openFindings > 0
    ) {
      // WARNING: taking an offer asks the forge now; a listing reads only what the syncer last read.
      if (request !== undefined) {
        facts.review = yield* Context.get(hostServices, Host).reviewFix(runId, facts.diffTarget);
      } else {
        const target = facts.diffTarget;
        const synced = yield* syncedReview(target, placedOf(row, options).cwd).pipe(
          Effect.provideContext(bun),
        );
        if (synced === null) {
          unread = target;
        } else {
          facts.review = yield* reviewFacts(store, dir, runId, target, () =>
            Effect.succeed(synced),
          ).pipe(Effect.provideContext(bun));
        }
      }
    }
    const workSource =
      work === undefined ? undefined : Rec.get(input, work).pipe(Option.getOrUndefined);
    if (isText(workSource) && Arr.some(generation.offers, (offer) => offer.entry !== undefined)) {
      // WARNING: taking an offer reads git now; a listing reads only what the git syncer kept.
      const recovery =
        request !== undefined
          ? yield* recoveryNow(runId, workSource)
          : yield* runRecords
              .fact(runId, SYNCED_RECOVERY)
              .pipe(Effect.map((kept) => (kept === null ? undefined : decodeRecovery(kept))));
      if (recovery !== undefined) {
        facts.recovery = recovery;
      }
    }
    const refused = new Map<string, string>();
    if (unread !== null) {
      for (const offer of generation.offers) {
        refused.set(offer.id, `${unread} is still being read from its forge; offered once it is`);
      }
    }
    const readings = new Map<ConnectionId, ConnectionReading>();
    for (const offer of generation.offers) {
      const ids = yield* connectionIds(
        offer.connections ?? [],
        generation,
        placedOf(row, options).cwd,
        input,
        request !== undefined,
      );
      for (const id of ids) {
        const cwd = placedOf(row, options).cwd;
        // WARNING: taking an offer reads the Connection now; a listing reads only what the syncer kept.
        const reading =
          readings.get(id) ??
          (request !== undefined
            ? yield* connectionOnMachine({ ...placing.env, cwd }, id).pipe(
                Effect.tap((read) =>
                  Effect.flatMap(Clock.currentTimeMillis, (at) =>
                    Context.get(bun, ConnectionRows).put({ id, cwd }, read, at),
                  ),
                ),
                Effect.provideContext(bun),
              )
            : yield* Context.get(bun, ConnectionRows).of({ id, cwd }));
        if (reading === null) {
          if (!refused.has(offer.id)) {
            refused.set(offer.id, `${id} is still being read; offered once it is`);
          }
          continue;
        }
        readings.set(id, reading);
        if (reading.state !== "ok" && !refused.has(offer.id)) {
          refused.set(offer.id, `needs ${id}: ${reading.detail}. Fix: ${reading.fix}`);
        }
      }
    }
    for (const offer of generation.offers) {
      const field = Option.getOrUndefined(
        Arr.findFirst(Rec.toEntries(offer.inputs), ([, source]) => source === "plan-dir"),
      )?.[0];
      if (field === undefined) {
        continue;
      }
      const read = yield* planReposOf(`${where}/plan`, placedOf(row, options).cwd).pipe(
        Effect.provideContext(bun),
        Effect.result,
      );
      if (read._tag === "Failure") {
        refused.set(offer.id, `its plan could not be read: ${read.failure.message}`);
      } else if (!isSingleRepo(read.success)) {
        refused.set(
          offer.id,
          read.success.refusal?.message ??
            `its plan spans repositories (${Arr.join(
              Arr.map(read.success.repos, changeKey),
              ", ",
            )}), which a card does not fan out. \`collie run start ${offer.workflow === SELF ? row.workflow : offer.workflow} --input ${field}=${where}/plan\` does, one Run per repository.`,
        );
      }
    }
    // WARNING: a follow-up shares its parent's checkout, so it must not start while the parent is still going or resumable.
    const ended = state.status === "complete" || state.status === "failed";
    const stopped = (yield* controlsOf(runId)).includes(STOP);
    const notYet = ended
      ? null
      : !stopped
        ? "a follow-up is a child of a finished run, and this one is still going"
        : facts.branch !== null
          ? "this run is stopped, and could be resumed in the checkout a follow-up would share"
          : null;
    if (notYet !== null) {
      for (const offer of generation.offers) {
        if (offer.kind === "follow-up") {
          refused.set(offer.id, notYet);
        }
      }
    }
    const again = Arr.filter(
      generation.offers,
      (offer) => offer.kind === "follow-up" && offer.workflow === SELF && !refused.has(offer.id),
    );
    if (
      state.status === "failed" &&
      again.length > 0 &&
      facts.diffTarget !== null &&
      (yield* fs.exists(checkoutRefusedFile(where)).pipe(Effect.orElseSucceed(() => false)))
    ) {
      const still = yield* refusedCheckout({
        dir,
        store,
        placing,
        starter: row,
        target: facts.diffTarget,
        awaits: false,
      }).pipe(Effect.provideContext(bun));
      if (still !== null) {
        for (const offer of again) {
          refused.set(offer.id, still);
        }
      }
    }
    const runs = yield* store.runs;
    const mr = facts.mrUrl;
    const mrId = mr === null ? null : yield* mrIdIn(mr, placedOf(row, options).cwd, runShell);
    const merged = mrId === null ? undefined : (yield* readMrStates(dir)).get(mrId);
    for (const offer of generation.offers) {
      const fields = Arr.filter(
        Rec.toEntries(offer.inputs),
        ([, source]) => source === "merge-request",
      );
      const withMr = mr !== null && fields.length > 0;
      if (withMr && (merged === "merged" || merged === "on-stage" || merged === "in-prod")) {
        refused.set(offer.id, `${mr} is merged`);
      }
      const workflow = offer.workflow === SELF ? generation.id : offer.workflow;
      // WARNING: a listing keeps a selecting offer visible so the card holds; only an invoke without ids is refused a live sibling.
      const oneAtATime =
        offer.selects === undefined ||
        ((idsIn(given.findings) ?? []).length === 0 &&
          (offer.selects !== "many" || request !== undefined));
      for (const candidate of oneAtATime ? runs : []) {
        if (candidate.workflow !== workflow || candidate.request === request) {
          continue;
        }
        if (candidate.parent !== runId) {
          if (!withMr) {
            continue;
          }
          const given = yield* decodeInput(candidate.input).pipe(
            Effect.orElseSucceed(() => {
              const none: Record<string, Schema.Json> = {};
              return none;
            }),
          );
          if (!Arr.some(fields, ([name]) => given[name] === mr)) {
            continue;
          }
        }
        if (yield* hasEnded(candidate.run)) {
          continue;
        }
        refused.set(
          offer.id,
          `a ${offer.title}${withMr ? ` of ${mr}` : ""} is still going: ${candidate.run}`,
        );
        break;
      }
    }
    return { row, generation, facts, where, refused, input };
  });

  const connectionIds = Effect.fn("Engine.Registry.connectionIds")(function* (
    ids: ReadonlyArray<string>,
    generation: Generation,
    cwd: string,
    input: Readonly<Record<string, Schema.Json>>,
    fresh = true,
  ) {
    const field = fieldWith(generation.hints, "diff-target");
    const target = field === undefined ? undefined : input[field];
    const ref = isText(target) ? parseMrTarget(target) : null;
    let here: ForgeHere | null = null;
    if (Arr.some(ids, (id) => id === "gitlab" || id === "github") && ref === null) {
      const defaults = yield* loadDefaults(userDir).pipe(
        Effect.provideContext(bun),
        Effect.mapError(
          (cause) =>
            new HostRefused({
              reason: `Connection configuration could not be read: ${String(cause)}`,
            }),
        ),
      );
      // WARNING: a listing reads the project the git syncer kept, none before its first read; a start or a taken offer asks git.
      if (fresh) {
        here = yield* forgeHere(cwd, runShell, defaults.gitlabHost).pipe(
          Effect.provideContext(bun),
        );
      } else {
        const kept = Arr.findFirst([...(yield* Context.get(bun, Branches).all)], ([key]) =>
          Str.startsWith(`${cwd}\0`)(key),
        );
        here = Option.isSome(kept)
          ? forgeOfProject(kept.value[1].project, defaults.gitlabHost)
          : null;
      }
    }
    const forge = ref !== null ? forgeOfRef(ref) : here?.ok ? here.forge.name : null;
    return [
      ...new Set(
        Arr.filter(
          Arr.map(Arr.filter(ids, Schema.is(ConnectionId)), (id) =>
            id === "gitlab" && forge === "github" ? "github" : id,
          ),
          (id) => id !== "github" || forge !== "gitlab" || !Arr.contains(ids, "gitlab"),
        ),
      ),
    ];
  });

  const settleStart = Effect.fn("Engine.Registry.settleStart")(function* (
    options: StartOptions,
    runId: string,
  ) {
    const generation = options.generation;
    const asked = options.options ?? {};
    yield* refuseOptions(generation, asked);
    yield* refuseAgent(generation, asked);
    const unattachable = yield* attachmentRefusal(options.attachments ?? []).pipe(
      Effect.provideContext(bun),
    );
    if (unattachable !== null) {
      return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${unattachable}` });
    }
    const request = yield* checkoutRequest(generation, asked, options.root ?? null);
    const launch = launchOptions(generation, asked);
    // WARNING: an empty set counts as none, so the project's verify.json still applies.
    const verify = options.verify?.length ? options.verify : undefined;
    // WARNING: inputs are settled before any row, claim or execution exists, so a refusal leaves nothing behind.
    const settled = yield* settleInput(generation.fields, {
      json: options.input,
      text: options.text ?? {},
      inferred: options.inferred ?? [],
    }).pipe(
      Effect.flatMap((given) =>
        settleTargets(
          generation,
          given,
          request.kind === "existing" ? request.path : options.project,
        ),
      ),
    );
    const payload = yield* Schema.decodeEffect(generation.registration.workflow.payloadSchema)({
      runId,
      input: settled.input,
    }).pipe(
      Effect.mapError((cause) => new HostRefused({ reason: `${REFUSED_INPUT}: ${cause.message}` })),
    );
    if ((yield* store.requested(options.request)) === null) {
      const cwd = request.kind === "existing" ? request.path : options.project;
      const needed = yield* connectionIds(
        Struct.keys(generation.connections?.needs ?? {}),
        generation,
        cwd,
        settled.input,
      );
      for (const id of needed) {
        const reading = yield* connectionOnMachine({ ...placing.env, cwd }, id).pipe(
          Effect.provideContext(bun),
        );
        if (reading.state !== "ok") {
          return yield* new HostRefused({
            reason: `${generation.id} needs ${id}: ${reading.detail}. Fix: ${reading.fix}`,
          });
        }
      }
    }
    const provenance = {
      ...settled.provenance,
      ...Rec.fromEntries(
        Arr.map(
          Arr.filter(options.inferred ?? [], (name) => name in asked),
          (name) => [name, INFERRED] as const,
        ),
      ),
    };
    const approved =
      (yield* store.requested(options.request)) === null
        ? yield* checksOfStart({
            generation,
            input: settled.input,
            launch,
            from: request.kind === "existing" ? request.path : options.project,
            project: options.project,
            verify,
            userDir,
            start: startRefOf({
              generation,
              runId,
              from: request.kind === "existing" ? request.path : options.project,
              project: options.project,
              branchBase: options.branchBase,
              input: settled.input,
              provenance,
              options: launch,
            }).pipe(
              Effect.provideService(ForgeHttp, Context.get(hostServices, ForgeHttp)),
              Effect.provideContext(bun),
            ),
          }).pipe(Effect.provideContext(bun))
        : verify;
    return { request, launch, settled, provenance, payload, approved };
  });

  const startWork = Effect.fn("Engine.Registry.start")(function* (options: StartOptions) {
    const generation = options.generation;
    const runId = options.runId ?? `run-${pipe(yield* random.uuidV4(), Str.slice(0, 8))}`;
    const { request, launch, settled, provenance, payload, approved } = yield* settleStart(
      options,
      runId,
    );
    const following = yield* followRequest({
      workflow: generation.id,
      setting: generation.follows,
      target: pointedAt(generation, settled.input),
      userDir,
      cwd: options.project,
    }).pipe(
      Effect.provideService(ForgeHttp, Context.get(hostServices, ForgeHttp)),
      Effect.provideContext(bun),
      Effect.mapError((reason) => new HostRefused({ reason })),
    );
    const followed =
      following === null
        ? null
        : yield* claimingOf(following.request).withPermits(1)(
            Effect.gen(function* () {
              const previous = yield* store.requested(following.request);
              if (previous !== null && (yield* workflowEnded(previous.run))) {
                yield* store.releaseClaim(previous);
                return null;
              }
              return previous;
            }),
          );
    if (following !== null && followed !== null) {
      return {
        runId: followed.run,
        registration: followed.generation,
        execution: followed.execution,
        fresh: false,
        followed: following.mr,
      };
    }
    const claimed = yield* claimAndPlace({
      request: following?.request ?? options.request,
      run: runId,
      workflow: generation.id,
      project: options.project,
      input: settled.input,
      provenance,
      options: launch,
      placing: encodePlacing({
        requestedBy: options.requestedBy,
        ...(options.heals !== undefined && { heals: options.heals }),
        started: options.started,
        branchBase: options.branchBase,
        closes: generation.closes,
        from: request.kind === "existing" ? request.path : options.project,
        taskLabel: options.taskLabel ?? null,
        root: options.root ?? null,
        ...(options.continues !== undefined && { continues: options.continues }),
        ...(options.invoked === undefined
          ? { direct: true as const }
          : { invoked: options.invoked }),
        ...(options.took !== undefined && { took: options.took }),
        ...(options.by !== undefined && { by: options.by }),
      }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: options.task ?? null,
      parent: options.parent ?? null,
      attachments: options.attachments,
    });
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: options.project,
      userDir,
      approved,
    }).pipe(Effect.provideContext(bun), Effect.ignore({ log: "Unhandled" }));
    yield* seedIntentOf({
      dir,
      row: claimed.row,
      generation,
      seed: options.intent,
      parent: options.parent ? yield* store.run(options.parent) : null,
    }).pipe(Effect.provideContext(bun), Effect.ignore({ log: "Unhandled" }));
    if (claimed.fresh) {
      yield* recordFeatures(claimed.row.run, userDir).pipe(Effect.provideContext(bun));
    }
    // WARNING: a Run that crashed before the engine heard is handed over under the identity it was admitted with.
    if (claimed.row.accepted === null) {
      yield* options.handsOver === true ? store.accepted(claimed.row.run) : handOver(claimed.row);
    }
    return {
      runId: claimed.row.run,
      registration: claimed.row.generation,
      execution: claimed.row.execution,
      fresh: claimed.fresh,
    };
  });

  const recover = (reach?: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const recovered = new Set<string>();
      const released: Array<string> = [];
      const reached = (run: string) => reach === undefined || reach.has(run);
      const rows = yield* store.runs;
      const used =
        reach === undefined
          ? undefined
          : new Set(
              Arr.map(
                Arr.filter(rows, (row) => reach.has(row.run)),
                (row) => row.generation,
              ),
            );
      yield* registering.withPermits(1)(
        Effect.gen(function* () {
          yield* Effect.forEach(known, (route) =>
            live.has(route.name) || used?.has(route.name) === false
              ? Effect.void
              : register(route, recovered, undefined, reached).pipe(
                  Effect.catchTag("EntryError", (failure) =>
                    Effect.sync(() =>
                      unavailable.set(route.name, `${failure.file}: ${failure.message}`),
                    ),
                  ),
                ),
          );
          for (const { run } of rows) {
            if (!reached(run) || !(yield* releaseEntry(run))) {
              continue;
            }
            yield* clearParked(run);
            recovered.add(run);
            released.push(run);
          }
        }),
      );
      for (const run of released) {
        yield* routed(run).pipe(Effect.flatMap(settle), Effect.ignore);
      }
      for (const row of yield* store.pending) {
        if (reached(row.run) && (yield* recoverAdmission(row))) {
          recovered.add(row.run);
        }
      }
      for (const one of yield* reconcileAnswers(reached)) {
        recovered.add(one);
      }
      return { registrations: yield* held, takenUp: recovered };
    });

  // WARNING: a gone file leaves only its own generation unavailable; one broken module must not stop the rest.
  for (const route of known) {
    yield* register(route).pipe(
      Effect.catchTag("EntryError", (failure) =>
        Effect.sync(() => unavailable.set(route.name, `${failure.file}: ${failure.message}`)),
      ),
    );
  }

  yield* Deferred.succeed(generationsRegistered, undefined);

  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (const row of yield* store.pending) {
        yield* recoverAdmission(row);
      }
      yield* reconcileAnswers();
    }),
  );

  const hosted = yield* Effect.context<HostServices>();
  yield* Effect.forkScoped(
    (yield* Agents).onLosses(
      Effect.gen(function* () {
        const host = yield* Host;
        const agents = yield* Agents;
        for (const { run } of yield* store.runs) {
          yield* agents.resumeLost(run, {
            running: hasEnded(run).pipe(
              Effect.map((ended) => !ended),
              Effect.orElseSucceed(() => false),
              Effect.provideContext(hosted),
            ),
            authority: host.place(run).pipe(Effect.map((place) => place.authority)),
            questions: {
              ask: (question, asker) => host.asking(run, question, asker),
              asked: host.asked(run),
              close: (decision, value) => host.close(run, decision, value),
            },
          });
        }
      }).pipe(Effect.provideContext(hosted)),
    ),
  );

  const returned: RegistryApi = {
    load: (file: string) => registering.withPermits(1)(mint(file)),

    use: useEntry,
    resolve,

    registrations: held,

    waiting: asked,
    view,
    retire: (runs) =>
      Effect.flatMap(Effect.context<MessageStorage.MessageStorage>(), (storage) =>
        store.retire(runs, (row) =>
          forgetExecution(row.generation, row.execution).pipe(Effect.provideContext(storage)),
        ),
      ),
    forgetClaim: (slug: string) =>
      Effect.gen(function* () {
        const dropped: Array<string> = [];
        for (const { run } of yield* store.runs) {
          const file = claimPath(dir, run);
          if (!Arr.some(yield* recordedClaims(file), (one) => one.slug === slug)) {
            continue;
          }
          yield* updateClaims(file, (now) => Arr.filter(now, (one) => one.slug !== slug));
          dropped.push(run);
        }
        return dropped;
      }).pipe(Effect.orDie, Effect.provideContext(bun)),
    views: (task: string | null, read?: FileSystem.FileSystem, kept?: KeptViews) => {
      const keeping = kept ?? shared;
      return store.runs.pipe(
        Effect.flatMap((rows) =>
          keptViews(
            task === null ? rows : Arr.filter(rows, (row) => row.task === task),
            kept === undefined ? VIEW_CONCURRENCY : 1,
            read ?? (keeping === undefined ? undefined : options?.keep?.reading),
            keeping,
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (keeping === undefined || task !== null) {
                  return;
                }
                const present = new Set(Arr.map(rows, (row) => row.run));
                for (const run of keeping.views.keys()) {
                  if (!present.has(run)) {
                    keeping.views.delete(run);
                  }
                }
              }),
            ),
          ),
        ),
      );
    },
    related: (
      runId: string,
      also: ReadonlyArray<string>,
      read?: FileSystem.FileSystem,
      kept?: KeptViews,
    ) =>
      Effect.all([store.near(runId), store.runs]).pipe(
        Effect.map(([near, every]) => [
          ...new Map(
            Arr.map([...near, ...Arr.filter(every, (row) => also.includes(row.run))], (row) => [
              row.run,
              row,
            ]),
          ).values(),
        ]),
        Effect.flatMap((rows) => {
          const self = Option.getOrUndefined(Arr.findFirst(rows, (row) => row.run === runId));
          if (self === undefined) {
            return Effect.succeed([]);
          }
          const inTask = new Set(
            Arr.map(
              Arr.filter(rows, (row) =>
                self.task === null ? row.run === runId : row.task === self.task,
              ),
              (row) => row.run,
            ),
          );
          const parents = new Set(
            Arr.map(rows, (row) => (inTask.has(row.run) ? row.parent : null)),
          );
          const asked = (row: RunRow) =>
            Str.includes("requestedBy")(row.placing ?? "") &&
            inTask.has(Option.getOrUndefined(decodePlacing(row.placing))?.requestedBy?.run ?? "");
          return keptViews(
            Arr.filter(
              rows,
              (row) =>
                inTask.has(row.run) ||
                parents.has(row.run) ||
                inTask.has(row.parent ?? "") ||
                also.includes(row.run) ||
                asked(row),
            ),
            VIEW_CONCURRENCY,
            read,
            kept,
          );
        }),
      ),
    mergeRequest: (runId: string, url: string) =>
      RunRecords.use((records) => records.put(runId, MERGE_REQUEST, `${url}\n`)).pipe(
        Effect.provideContext(bun),
        Effect.andThen(store.announce),
      ),
    watch: (runId: string) =>
      store
        .watching(view(runId))
        .pipe(
          Stream.onStart(Effect.sync(() => (watchers += 1))),
          Stream.ensuring(Effect.sync(() => (watchers -= 1))),
        ),

    recover: recover().pipe(Effect.map((result) => result.registrations)),

    resume: Effect.fn("Engine.Registry.resume")(function* (
      runId: string,
      recoveryPark?: string,
      healing?: string,
    ) {
      const recovered = yield* recover(
        new Set(
          recoveryPark === undefined
            ? [runId, ...descendantsOf(yield* store.runs, runId)]
            : [runId],
        ),
      );
      entryCauses.set(runId, "resumed");
      const controlled = yield* (
        recoveryPark === undefined
          ? applyControl(runId, STOP, false, recovered.takenUp, false, healing)
          : Effect.gen(function* () {
              const found = yield* routed(runId);
              const woken = yield* wake(runId, found, recoveryPark);
              return { runs: [runId], woken: woken ? [runId] : [] };
            }).pipe(controlling.withPermits(1))
      ).pipe(Effect.result, Effect.ensuring(Effect.sync(() => entryCauses.delete(runId))));
      const recorded = { runId, control: STOP, set: false, left: [] };
      if (controlled._tag === "Failure") {
        return {
          ...recorded,
          applied: healing === undefined && recovered.takenUp.has(runId),
          detail: controlled.failure.reason,
        };
      }
      if (recovered.takenUp.has(runId) || controlled.success.woken.includes(runId)) {
        return { ...recorded, applied: true, detail: "" };
      }
      const found = yield* routed(runId).pipe(Effect.result);
      if (found._tag === "Failure") {
        return { ...recorded, applied: false, detail: found.failure.reason };
      }
      const status = pollStatus(
        yield* engine.poll(found.success.generation.registration.workflow, found.success.execution),
        found.success.generation.entry,
      ).status;
      return {
        ...recorded,
        applied: false,
        detail:
          status === "pending"
            ? `${runId} is already running; no work was taken up`
            : `${runId} has ${status === "complete" ? "finished" : status}; no work was taken up`,
      };
    }),

    newest,
    routed,

    syncRecovery: (runId: string) => syncRecovery(runId).pipe(Effect.ignore),

    // WARNING: a listing reads each module's kept revision; taking an offer computes it afresh.
    offers: (runId: string) =>
      offeredBy(runId).pipe(
        Effect.flatMap(({ row, generation, facts, where, refused, input }) =>
          Effect.forEach(
            offersFrom(generation.offers, facts, {
              self: generation.id,
              keepUnavailable: true,
              refused,
            }),
            (offer) =>
              offer.kind === "follow-up"
                ? unfilled(
                    offer,
                    row.project,
                    inputsFor(offer, { runId: row.run, runDir: where, facts, input }),
                  )
                : unbound(offer, row.project),
          ),
        ),
        onSyncedRevisions,
      ),

    invoke: Effect.fn("Engine.Registry.invoke")(function* (options: {
      readonly runId: string;
      readonly offer: string;
      readonly input: Readonly<Record<string, Schema.Json>>;
      readonly request: string;
      readonly attachments?: ReadonlyArray<string> | undefined;
      readonly started?: Started | undefined;
      readonly by?: string | undefined;
    }) {
      const invoked = canonicalJson({
        parent: options.runId,
        offer: options.offer,
        input: options.input,
        attachments: options.attachments ?? [],
      });
      // WARNING: the request id is the claim, so a caller that lost the answer is given the Run it started.
      const claimed = yield* store.requested(options.request);
      if (claimed !== null) {
        const placing = Option.getOrUndefined(decodePlacing(claimed.placing ?? ""));
        if (
          placing?.direct === true ||
          placing?.child === true ||
          claimed.parent === null ||
          claimed.request === claimed.run
        ) {
          return yield* new RequestConflict({
            request: options.request,
            reason: `request "${options.request}" is already ${claimed.run}, started directly rather than by an offer`,
          });
        }
        // WARNING: a child admitted before this branch carries no fingerprint, and its retry is still a replay.
        if (placing?.invoked !== undefined && placing.invoked !== invoked) {
          return yield* new RequestConflict({
            request: options.request,
            reason: `request "${options.request}" is already ${claimed.run}, started with other arguments`,
          });
        }
        yield* finishTaken(claimed, options.by ?? options.request);
        return {
          runId: claimed.run,
          registration: claimed.generation,
          execution: claimed.execution,
          fresh: false,
        };
      }
      const { row, generation, facts, where, refused, input } = yield* offeredBy(
        options.runId,
        options.request,
        options.input,
      );
      // WARNING: a card is not authority; the offer is asked again of the module as it is now.
      const offer = Option.getOrUndefined(
        Arr.findFirst(
          offersFrom(generation.offers, facts, {
            self: generation.id,
            keepUnavailable: true,
            refused,
          }),
          (one) => one.id === options.offer,
        ),
      );
      if (offer === undefined || offer.unavailable !== null) {
        const why = offer?.unavailable ? `: ${offer.unavailable}` : " now";
        return yield* new HostRefused({
          reason: `run "${options.runId}" does not offer "${options.offer}"${why}`,
        });
      }
      const starting = yield* resolve({ project: row.project, id: offer.workflow });
      const bound = Arr.findFirst(
        Rec.keys(options.input),
        (name) => name in (offer.given ?? {}) || starting.hints[name] === "internal",
      );
      if (Option.isSome(bound)) {
        return yield* new HostRefused({
          reason: `"${bound.value}" is Collie's to set when "${options.offer}" starts ${offer.workflow}, so it cannot be given`,
        });
      }
      // WARNING: the caller's own values win over an offer's fill-ins.
      const given = {
        ...inputsFor(offer, { runId: row.run, runDir: where, facts, input }),
        ...options.input,
      };
      const chosen =
        offer.selects === undefined ? [] : yield* chosenFor(offer, given.findings, where);
      const selecting = Arr.filter(
        Rec.toEntries(offer.inputs),
        ([, source]) => source === "findings",
      );
      const filled: Record<string, Schema.Json> = Rec.filter(
        given,
        (_, name) => name !== "findings" && !Arr.some(selecting, ([field]) => field === name),
      );
      if (chosen.length > 0) {
        for (const [name] of selecting) {
          filled[name] = chosen;
        }
      }
      for (const [name, source] of Rec.toEntries(offer.inputs)) {
        const text = source === "finding" ? yield* findingFor(where, chosen[0] ?? "") : undefined;
        if (text !== undefined) {
          filled[name] = text;
        }
      }
      const inherited = yield* approvedOf(dir, row.run);
      const launch = Rec.map(
        Rec.filter(filled, (_, name) => name in RESERVED_INPUTS),
        (value) => (Predicate.isString(value) ? value : asJsonText(value)),
      );
      if (offer.kind === "follow-up" && facts.branch !== null) {
        launch.branch = facts.branch;
        if (offer.workflow === generation.id && facts.outcome !== "unspecified") {
          launch.outcome ??= facts.outcome;
        }
        if (offer.workflow === generation.id) {
          const previous = yield* decodeStrings(row.options ?? "{}").pipe(
            Effect.orElseSucceed(() => {
              const none: Record<string, string> = {};
              return none;
            }),
          );
          if (previous.risks !== undefined) {
            launch.risks ??= previous.risks;
          }
        }
      }
      const startedWith: Readonly<Record<string, Schema.Json>> = input;
      const carriedWork = Arr.filter(
        Rec.keys(offer.inputs),
        (name) => offer.inputs[name] === "started-with",
      );
      const sameWork =
        offer.kind === "follow-up" &&
        offer.workflow === generation.id &&
        carriedWork.length > 0 &&
        Arr.every(carriedWork, (name) =>
          filled[name] === undefined || startedWith[name] === undefined
            ? filled[name] === startedWith[name]
            : stringifyJson(filled[name]) === stringifyJson(startedWith[name]),
        );
      return yield* startWork({
        continues: sameWork ? yield* consumedCard(row.run, where) : undefined,
        generation: starting,
        request: options.request,
        project: row.project,
        input: Rec.filter(filled, (_, name) => !(name in RESERVED_INPUTS)),
        invoked,
        took: chosen,
        by: options.by ?? options.request,
        task: row.task,
        parent: row.run,
        verify: inherited,
        attachments: options.attachments,
        started: options.started,
        options: launch,
      });
    }, invoking.withPermits(1)),

    start: startWork,
    check: (options) => settleStart(options, "run-check").pipe(Effect.asVoid),
    result: (runId) =>
      lending(
        Effect.flatMap(store.run(runId), (row) =>
          runChild({ runId, workflow: row?.workflow ?? "", invocation: runId, fresh: false }),
        ),
      ),

    status: Effect.fn("Engine.Registry.status")(function* (runId: string) {
      const found = yield* routed(runId);
      const workflow = found.generation.registration.workflow;
      const result = yield* engine.poll(workflow, found.execution);
      return pollStatus(
        result,
        found.generation.entry,
        workflow.successSchema,
        workflow.errorSchema,
      );
    }),

    answer: Effect.fn("Engine.Registry.answer")(function* (
      options: Parameters<RegistryApi["answer"]>[0],
    ) {
      const found = yield* Effect.result(routed(options.runId));
      if (found._tag === "Failure" && (yield* store.run(options.runId)) === null) {
        return yield* found.failure;
      }
      const asks = yield* asked(options.runId);
      const open = Arr.filter(asks, isUnanswered);
      const setAside = Arr.filter(asks, (one) => isSetAside(asks, one));
      const candidates = open.length === 0 && setAside.length === 1 ? setAside : open;
      const sole = options.decision === null ? soleOpen(options.runId, candidates, asks) : null;
      if (sole !== null) {
        return yield* sole;
      }
      const name = options.decision ?? candidates[0]?.name ?? "";
      const question = Option.getOrUndefined(Arr.findFirst(asks, (one) => one.name === name));
      if (question === undefined) {
        return yield* new HostRefused({
          reason: `run "${options.runId}" is not waiting on a decision called "${name}"`,
        });
      }
      const said = Str.toLowerCase(options.value);
      const named = Option.getOrUndefined(
        Arr.findFirst(question.options, (option) => Str.toLowerCase(option.id) === said).pipe(
          Option.orElse(() =>
            Arr.findFirst(question.options, (option) => Str.toLowerCase(option.title) === said),
          ),
        ),
      );
      if (question.options.length > 0 && named === undefined) {
        return yield* new HostRefused({
          reason: `"${options.value}" is not one of ${Arr.join(
            Arr.map(question.options, (option) => option.title),
            ", ",
          )}`,
        });
      }
      const value = named?.id ?? options.value;
      // WARNING: an agent's question needs no workflow to wake, since a finished Run's module may be gone.
      const byAgent = Arr.some(
        yield* store.asked(options.runId),
        (row) => row.decision === name && row.asker !== null,
      );
      if (!byAgent && found._tag === "Failure") {
        return yield* found.failure;
      }
      // WARNING: the database, not timing, orders racing answers; only the row's writer completes the deferred.
      const settled = yield* store.settle({
        run: options.runId,
        decision: name,
        value,
        request: options.request,
        answerer: options.by === undefined ? undefined : actorOf(options.by, options.request),
      });
      if (settled._tag === "refused") {
        return yield* new HostRefused({ reason: settled.reason });
      }
      if (settled._tag === "accepted") {
        yield* crash("answered");
      }
      // WARNING: an agent's question is answered to its agent, never woken, since waking the workflow would replay it.
      if (settled.row.asker === null && found._tag === "Success") {
        const { registration } = found.success.generation;
        const executionId = found.success.execution;
        const deferred = rootOf(yield* store.asked(options.runId), name);
        yield* untilStopped(registration, executionId).pipe(
          Effect.andThen(
            answerDecision(registration, { name: deferred, executionId, value }).pipe(
              waking.withPermits(1),
            ),
          ),
          Effect.forkIn(hostScope),
        );
      }

      return { runId: options.runId, decision: name, value, fresh: settled._tag === "accepted" };
    }, waking.withPermits(1)),

    wake: Effect.fn("Engine.Registry.wake")(function* (run: string, name: string, woke: Woke) {
      yield* store.wake(run, name, woke);
      if (wakingWatches.has(run)) {
        return;
      }
      if (Arr.some(yield* store.asked(run), (row) => row.decision === name)) {
        const closed = yield* store.settle({
          run,
          decision: name,
          value: wokeText(woke),
          request: `${run}-${name}-woke`,
        });
        if (closed._tag === "refused") {
          return yield* forgetWatch(run, name);
        }
      }
      const found = yield* routed(run).pipe(Effect.option);
      if (Option.isNone(found)) {
        return;
      }
      wakingWatches.add(run);
      const { generation, execution } = found.value;
      yield* answerDecision(generation.registration, {
        name,
        executionId: execution,
        value: wokeText(woke),
      }).pipe(
        Effect.andThen(forgetWatch(run, name)),
        waking.withPermits(1),
        Effect.ensuring(Effect.sync(() => wakingWatches.delete(run))),
        Effect.forkIn(hostScope),
      );
    }),

    supersede: supersedeQuestion,

    control: Effect.fn("Engine.Registry.control")(function* (options: {
      readonly runId: string;
      readonly control: string;
      readonly set: boolean;
      readonly before?: string;
      readonly by?: string;
      readonly alone?: boolean;
      readonly reason?: string;
    }) {
      if (options.before !== undefined) {
        const target = yield* stepTarget(runDir(dir, options.runId), options.before);
        if (target.refused !== undefined) {
          return yield* new HostRefused({ reason: target.refused });
        }
        if (yield* hasEnded(options.runId)) {
          return yield* new HostRefused({
            reason: `Step ${options.before} has no work left in this finished Run`,
          });
        }
        yield* pauseBefore(
          runDir(dir, options.runId),
          options.before,
          options.by ?? "the CLI",
          options.set,
        );
        yield* store.announce;
        return {
          runId: options.runId,
          control: HOLD,
          set: options.set,
          left: [],
          applied: true,
          detail: "",
        };
      }
      if (options.control === HOLD && !options.set) {
        yield* clearReachedPause(runDir(dir, options.runId));
      }
      if (options.control === HOLD && (yield* hasEnded(options.runId))) {
        return yield* new HostRefused({
          reason: "a finished Run has no step left to hold; stop closes its agents",
        });
      }
      if (options.control === STOP && options.set && (yield* workflowEnded(options.runId))) {
        const halted = yield* (yield* Agents).halt(options.runId, options.reason);
        return {
          runId: options.runId,
          control: options.control,
          set: options.set,
          left: halted.left,
          closed: halted.stopped,
          applied: true,
          detail: "",
        };
      }
      const found = yield* routed(options.runId).pipe(Effect.result);
      const left =
        options.control === STOP && options.set
          ? (yield* stopTree(options.runId, options.alone, options.reason)).left
          : yield* applyControl(options.runId, options.control, options.set).pipe(Effect.as([]));
      const recorded = { runId: options.runId, control: options.control, set: options.set, left };
      if (found._tag === "Failure") {
        return { ...recorded, applied: false, detail: found.failure.reason };
      }
      return { ...recorded, applied: true, detail: "" };
    }),

    grant: Effect.fn("Engine.Registry.grant")(function* (options: {
      readonly runId: string;
      readonly name: string;
      readonly command: Omit<VerifySpec, "name"> | null;
    }) {
      const row = yield* store.run(options.runId);
      if (row === null) {
        return yield* new HostRefused({ reason: `no run "${options.runId}" was started here` });
      }
      // WARNING: a command resolves as the gate does, so a check that could never run is refused now.
      if (options.command !== null) {
        const refused = markRefused(options.command);
        if (refused !== undefined) {
          return yield* new HostRefused({
            reason: `${REFUSED_INPUT}: check "${options.name}": ${refused}`,
          });
        }
        const own = yield* treeOf(row, options.runId, dir);
        const at =
          options.command.cwd === "worktree"
            ? (own.worktree ?? own.cwd)
            : (yield* Path.Path).resolve(own.cwd, options.command.cwd);
        if (!(yield* insideRun(at, own))) {
          return yield* new HostRefused({
            reason: `${REFUSED_INPUT}: check "${options.name}" would run in "${at}", which is not inside run ${options.runId}`,
          });
        }
      }
      return yield* updateApproved(evidenceDir(dir, options.runId), (frozen) => {
        const kept = Arr.filter(frozen ?? [], (spec) => spec.name !== options.name);
        return options.command === null
          ? kept
          : [...kept, { name: options.name, ...options.command }];
      }).pipe(Effect.provideContext(bun));
    }),

    steer: Effect.fn("Engine.Registry.steer")(function* (options: {
      readonly runId: string;
      readonly text: string;
      readonly request: string;
      readonly step?: string;
      readonly to?: string;
      readonly operation?: string;
      readonly agent?: string;
      readonly mode?: AgentsSdk.DeliveryMode;
      readonly actor?: Asker;
    }) {
      // WARNING: a finished Run's agents need its row, not its module, to be closed.
      if ((yield* store.run(options.runId)) === null) {
        return yield* new HostRefused({ reason: `no run "${options.runId}" was started here` });
      }
      if (options.step !== undefined) {
        if (
          options.agent !== undefined ||
          options.to !== undefined ||
          options.operation !== undefined
        ) {
          return yield* new HostRefused({
            reason: "A Step note takes --step alone, without an agent, role or operation",
          });
        }
        const where = runDir(dir, options.runId);
        const target = yield* stepTarget(where, options.step);
        if (target.refused !== undefined) {
          return yield* new HostRefused({ reason: target.refused });
        }
        if (target.step.kind === "question") {
          return yield* new HostRefused({
            reason: `Step ${options.step} is a question; answer it rather than leave a note`,
          });
        }
        if (yield* workflowEnded(options.runId)) {
          return yield* new HostRefused({
            reason: `Step ${options.step} has no next prompt in this finished Run`,
          });
        }
        yield* leaveStepNote(where, {
          id: options.request,
          step: options.step,
          by:
            options.actor === undefined
              ? "the CLI"
              : whoActed(actorOf(options.actor, options.request)),
          text: options.text,
        });
        const launch = Option.getOrUndefined(
          Arr.findLast(
            yield* readLaunches(options.runId),
            (one) => one.step?.step === options.step,
          ),
        );
        if (launch !== undefined && !(yield* fs.exists(launch.output).pipe(Effect.orDie))) {
          const sent = yield* (yield* Agents).steer({
            ...options,
            agent: launch.agent,
            mode: "boundary",
          });
          if (sent.delivered) {
            yield* readStepNote(where, options.request);
          }
        }
        yield* store.announce;
        return {
          agent: launch?.agent ?? "",
          delivered: true,
          detail: "Note kept for the Step's next prompt",
          note: options.request,
        };
      }
      let workflowNotice: string | undefined;
      if (yield* workflowEnded(options.runId)) {
        const current = yield* view(options.runId);
        const status =
          current?.status.status === "complete"
            ? "succeeded"
            : current?.status.status === "failed"
              ? "failed"
              : "terminal status unavailable without its module";
        const available = yield* offeredBy(options.runId).pipe(
          Effect.map(({ generation, facts, refused }) =>
            offersFrom(generation.offers, facts, { self: generation.id, refused }),
          ),
          Effect.orElseSucceed(() => []),
        );
        const followUp = Option.getOrUndefined(
          Arr.findFirst(available, (one) => one.kind === "follow-up" && one.unavailable === null),
        );
        const route =
          followUp === undefined
            ? `Start a new Run on ${current?.branch == null ? "its branch" : `its branch ${current.branch}`}.`
            : `Use follow-up offer "${followUp.id}", giving the message as its input.`;
        workflowNotice = `${options.runId} has finished (${status}). No Step reads this turn's Output. ${route}`;
      }
      const sent = yield* (yield* Agents).steer({ ...options, workflowNotice });
      yield* superseding(options.runId, options.actor, sent);
      const result: Types.Mutable<typeof Steered.Type> = { ...sent };
      if (workflowNotice !== undefined) {
        result.workflowNotice = workflowNotice;
      }
      if (sent.gone === true) {
        result.finished = yield* hasEnded(options.runId);
      }
      return result;
    }),

    tendQuestions: Effect.gen(function* () {
      const host = yield* Host;
      const services = yield* Effect.context<HostServices>();
      yield* (yield* Agents).tendQuestions(
        (runId) => ({
          ask: (question, asker) => host.asking(runId, question, asker),
          asked: host.asked(runId),
          close: (decision, value) => host.close(runId, decision, value),
        }),
        (runs) =>
          Effect.gen(function* () {
            const rowsOf = yield* store.askedOf(runs);
            const asked = new Map<string, ReadonlyArray<Sdk.AskedQuestion>>();
            for (const [runId, rows] of rowsOf) {
              asked.set(
                runId,
                yield* askedQuestions(
                  rows,
                  yield* readAudit(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
                ),
              );
            }
            return asked;
          }).pipe(Effect.provideContext(bun)),
        (queued, sent) =>
          superseding(queued.runId, queued.actor, sent).pipe(Effect.provideContext(services)),
      );
      yield* missedMessages;
      yield* reviseQuestions;
    }),
  };
  return returned;
});

const decodeOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(RecordedSolution)),
);

const askedQuestions = (rows: ReadonlyArray<DecisionRow>, audit: ReadonlyArray<AuditLine>) =>
  Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const actor =
        row.answerer ??
        Option.getOrUndefined(
          Arr.findFirst(
            audit,
            (line) => line.operation === "answer" && line.request === row.request,
          ),
        )?.actor;
      const asked = {
        name: row.decision,
        answer: row.answer,
        superseded: row.superseded,
        options: yield* decodeOptions(row.options).pipe(
          Effect.orElseSucceed(() => {
            const returned: ReadonlyArray<Solution> = [];
            return returned;
          }),
        ),
      };
      if (actor === undefined) {
        return asked;
      }
      const { requestId: _, schedule: __, ...by } = actor;
      return { ...asked, by };
    }),
  );

const touchedBy = (
  rows: ReadonlyArray<DecisionRow>,
  launches: ReadonlyArray<{ readonly operation: string; readonly agent: string }>,
  agent: string,
  submitted: number,
) => {
  const before = Arr.filter(rows, (one) => epochMs(one.asked) < submitted);
  return {
    aside: Arr.filter(
      before,
      (one) => isUnanswered(one) && (one.asker === null || asksAs(launches, one.asker, agent)),
    ),
    extended: Arr.filter(
      before,
      (one) =>
        one.asker === null &&
        isSuperseded(one) &&
        !Arr.some(rows, (r) => r.revises === one.decision) &&
        !Arr.some(one.messaged ?? [], (was) => was.agent === agent && epochMs(was.at) >= submitted),
    ),
  };
};

const asksAs: (
  launches: ReadonlyArray<{ readonly operation: string; readonly agent: string }>,
  asker: string,
  agent: string,
) => boolean = (launches, asker, agent) =>
  Arr.some(launches, (launch) => launch.operation === asker && launch.agent === agent);

const descendantsOf: (rows: ReadonlyArray<RunRow>, runId: string) => ReadonlyArray<string> = (
  rows,
  runId,
) => {
  const children = Arr.map(
    Arr.filter(rows, (row) => row.parent === runId && row.request === row.run),
    (row) => row.run,
  );
  return Arr.flatMap(children, (child) => [child, ...descendantsOf(rows, child)]);
};

const SUPERSEDE_GRACE_MS = 30_000;

const lineageOf: (
  rows: ReadonlyArray<{ readonly decision: string; readonly revises: string | null }>,
  name: string,
) => ReadonlyArray<string> = (rows, name) => {
  const line: Array<string> = [];
  let at: string | null = name;
  while (at !== null && !Arr.contains(line, at)) {
    const current: string = at;
    line.push(current);
    const row = Option.getOrUndefined(Arr.findFirst(rows, (one) => one.decision === current));
    at = row?.revises ?? null;
  }
  return Arr.reverse(line);
};

const rootOf: (
  rows: ReadonlyArray<{ readonly decision: string; readonly revises: string | null }>,
  name: string,
) => string = (rows, name) => lineageOf(rows, name)[0] ?? name;

const soleOpen: (
  runId: string,
  open: ReadonlyArray<OpenDecision>,
  asks: ReadonlyArray<OpenDecision>,
) => HostRefused | null = (runId, open, asks) => {
  if (open.length === 1) {
    return null;
  }
  const setAside = Arr.filter(asks, isSuperseded);
  return new HostRefused({
    reason:
      open.length === 0
        ? setAside.length > 0
          ? Arr.join(Arr.map(setAside, supersededReason), "; ")
          : `run "${runId}" is not waiting on a decision`
        : `run "${runId}" is waiting on ${Arr.join(
            Arr.map(open, (one) => `"${one.name}"`),
            ", ",
          )}: say which`,
  });
};

const encodeCheckProject = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({ extends: Schema.String, files: Schema.Array(Schema.String) }),
    ),
  ),
  Result.getOrThrow,
);

const TOOLCHAIN_FILES = {
  "package.json": `{
  "name": "collie-workflows",
  "private": true,
  "type": "module",
  "dependencies": { "effect": "${TOOLCHAIN.effect}" },
  "devDependencies": { "typescript": "${TOOLCHAIN.typescript}" }
}
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "types": [],
    "paths": { "collie": ["./collie.d.ts"] }
  }
}
`,
} as const;

const SDK_FILE = "collie.d.ts";

export const TOOLCHAIN_NAMES: ReadonlyArray<string> = [
  ...Struct.keys(TOOLCHAIN_FILES),
  SDK_FILE,
  "bun.lock",
  "node_modules",
];

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = Schema.is(JsonObject);
const readJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const writeJsonObject = flow(
  Schema.encodeResult(Schema.fromJsonString(JsonObject, { space: 2 })),
  Result.getOrThrow,
);
const objectIn: (value: Schema.Json | undefined) => Readonly<Record<string, Schema.Json>> = (
  value,
) => (isJsonObject(value) ? value : {});

const mergedPackage = (pkg: Readonly<Record<string, Schema.Json>>) => {
  const dependencies = objectIn(pkg.dependencies);
  const devDependencies = objectIn(pkg.devDependencies);
  return {
    ...pkg,
    dependencies: { ...dependencies, effect: TOOLCHAIN.effect },
    devDependencies:
      "typescript" in dependencies
        ? devDependencies
        : { typescript: TOOLCHAIN.typescript, ...devDependencies },
  };
};

const mergedCompiler = (dir: string, tsconfig: Readonly<Record<string, Schema.Json>>) => {
  const options = objectIn(tsconfig.compilerOptions);
  const paths = objectIn(options.paths);
  const declarations = isText(options.baseUrl) ? `${dir}/collie.d.ts` : "./collie.d.ts";
  return {
    ...tsconfig,
    compilerOptions: { ...options, paths: { collie: [declarations], ...paths } },
  };
};

export const provisionToolchain: (
  dir: string,
) => Effect.Effect<
  void,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Engine.provisionToolchain")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const unavailable = (message: string) =>
    new ToolchainError({ code: "toolchain_unavailable", message });
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  yield* fs.writeFileString(`${dir}/${SDK_FILE}`, SDK_DECLARATIONS).pipe(Effect.orDie);
  const unmerged: Array<string> = [];
  for (const [name, merge] of [
    ["package.json", mergedPackage],
    ["tsconfig.json", (read: Readonly<Record<string, Schema.Json>>) => mergedCompiler(dir, read)],
  ] as const) {
    const path = `${dir}/${name}`;
    const existing = yield* fs.readFileString(path).pipe(Effect.option);
    if (Option.isNone(existing)) {
      yield* fs.writeFileString(path, TOOLCHAIN_FILES[name]).pipe(Effect.orDie);
      continue;
    }
    const read = readJsonObject(existing.value);
    if (Option.isNone(read)) {
      unmerged.push(name);
      continue;
    }
    const merged = `${writeJsonObject(merge(read.value))}\n`;
    if (merged !== existing.value) {
      yield* fs.writeFileString(path, merged).pipe(Effect.orDie);
    }
  }
  const installed = yield* runBun(dir, ["install"]).pipe(Effect.mapError(unavailable));
  if (installed.code !== 0) {
    return yield* unavailable(
      `cannot install the workflow toolchain in ${dir}: ${installed.output}`,
    );
  }
  if (unmerged.length > 0) {
    return yield* unavailable(
      `${Arr.join(unmerged, " and ")} in ${dir} is not plain JSON, so nothing was merged into it: add "effect" and "typescript" to package.json and map "collie" to ./collie.d.ts under compilerOptions.paths`,
    );
  }
  const compiler = yield* fs
    .exists(`${dir}/node_modules/typescript/lib/tsc.js`)
    .pipe(Effect.mapError((cause) => unavailable(String(cause))));
  const effect = yield* fs
    .readFileString(`${dir}/node_modules/effect/package.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(InstalledPackage)), Effect.option);
  if (!compiler || Option.isNone(effect) || effect.value.version !== TOOLCHAIN.effect) {
    return yield* unavailable(
      `cannot provision the workflow toolchain in ${dir}: Bun's install settings did not install TypeScript and Effect ${TOOLCHAIN.effect}`,
    );
  }
});

const InstalledPackage = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

export const refreshToolchain = Effect.fn("Engine.refreshToolchain")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const installed = yield* fs
    .readFileString(`${dir}/node_modules/effect/package.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(InstalledPackage)), Effect.option);
  if (Option.isSome(installed) && installed.value.version !== TOOLCHAIN.effect) {
    yield* provisionToolchain(dir);
  }
});

const DIAGNOSTIC = /\(\d+,\d+\): error /;

const importersOf = (lines: ReadonlyArray<string>) => {
  const importers = new Map<string, Set<string>>();
  let file: string | null = null;
  for (const line of lines) {
    if (line === "" || DIAGNOSTIC.test(line)) {
      continue;
    }
    if (!Str.startsWith(" ")(line)) {
      file = line;
      continue;
    }
    const importer = /^\s+Imported via .* from file '([^']+)'/.exec(line)?.[1];
    if (file !== null && importer !== undefined) {
      importers.set(file, (importers.get(file) ?? new Set()).add(importer));
    }
  }
  return importers;
};

// WARNING: --explainFiles lists each file followed by indented reasons; what is left is what tsc said.
const tscSaid = (lines: ReadonlyArray<string>) =>
  Arr.filter(
    lines,
    (line, at) => !Str.startsWith(" ")(line) && !Str.startsWith(" ")(lines[at + 1] ?? ""),
  );

const reachingEntries = (
  file: string,
  entries: ReadonlySet<string>,
  importers: ReadonlyMap<string, ReadonlySet<string>>,
) => {
  const seen = new Set([file]);
  const queue = [file];
  const reached = new Set<string>();
  for (let at = queue.shift(); at !== undefined; at = queue.shift()) {
    if (entries.has(at)) {
      reached.add(at);
    }
    for (const next of importers.get(at) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
};

export const typecheckEntries: (options: {
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
}) => Effect.Effect<
  ReadonlyMap<string, ReadonlyArray<string>>,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Engine.typecheckEntries")(function* (options: {
  readonly dir: string;
  readonly files: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const compiler = `${options.dir}/node_modules/typescript/lib/tsc.js`;
  if (!(yield* fs.exists(compiler).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new ToolchainError({
      code: "toolchain_unavailable",
      message: `no typechecker in ${options.dir}; provision it while you have a network`,
    });
  }
  const project = `${options.dir}/${CHECK_PROJECT}-${Bun.hash(Arr.join(options.files, "\n")).toString(16)}.json`;
  yield* fs
    .writeFileString(
      project,
      encodeCheckProject({ extends: "./tsconfig.json", files: [...options.files] }),
    )
    .pipe(Effect.orDie);
  const unavailable = (message: string) =>
    new ToolchainError({ code: "toolchain_unavailable", message });
  const ran = yield* runBun(options.dir, [
    "run",
    compiler,
    "--pretty",
    "false",
    "--explainFiles",
    "-p",
    project,
  ]).pipe(Effect.mapError(unavailable), Effect.ensuring(fs.remove(project).pipe(Effect.ignore)));
  const found = new Map(Arr.map(options.files, (file) => [file, Array<string>()] as const));
  if (ran.code === 0) {
    return found;
  }
  const lines = Str.split(ran.output, "\n");
  const diagnostics = Arr.filter(lines, (line) => DIAGNOSTIC.test(line));
  if (diagnostics.length === 0) {
    return yield* unavailable(
      `the typechecker exited ${ran.code} without checking: ${Str.trim(Arr.join(tscSaid(lines), "\n"))}`,
    );
  }
  // WARNING: tsc names files relative to the project's directory, so entries are matched by that name.
  const named = new Map(
    Arr.map(options.files, (file) => [
      pipe(file, Str.startsWith(`${options.dir}/`))
        ? pipe(file, Str.slice(options.dir.length + 1))
        : file,
      file,
    ]),
  );
  const importers = importersOf(lines);
  for (const line of diagnostics) {
    const reached = reachingEntries(
      pipe(line, Str.takeLeft(Option.getOrElse(Str.search(line, DIAGNOSTIC), () => 0))),
      new Set(named.keys()),
      importers,
    );
    // WARNING: a diagnostic no entry is seen to reach goes to every entry, so none is hidden.
    const owners =
      reached.size === 0 ? options.files : Arr.map([...reached], (one) => named.get(one)!);
    for (const owner of owners) {
      found.get(owner)?.push(line);
    }
  }
  return found;
});

export const typecheckEntry = (options: { readonly dir: string; readonly file: string }) =>
  Effect.map(
    typecheckEntries({ dir: options.dir, files: [options.file] }),
    (found) => found.get(options.file) ?? [],
  );

const runBun: (
  cwd: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<
  { readonly code: number; readonly output: string },
  string,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = (cwd, args) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "collie-bun-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        cwd,
        env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", TMPDIR: tmp },
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const output = yield* collect(child.stdout).pipe(
      Effect.zipWith(collect(child.stderr), (out, err) => out + err),
    );
    return { code: Number(yield* child.exitCode), output };
  }).pipe(Effect.scoped, Effect.mapError(String));

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => {
        return "";
      },
      (all, chunk) => all + chunk,
    ),
  );
