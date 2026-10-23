// Collie's workflow engine: Effect's, run from the compiled binary.
//
// A workflow lives in a TypeScript file outside this checkout. This module is what lets
// the packaged executable load one, give it the binary's own Effect rather than a second
// copy, and run it on ClusterWorkflowEngine over real SQLite — so a host that dies leaves
// completed work completed and a pending decision pending. Nothing here interprets a
// workflow: the module is code, and Effect executes it.
//
// `docs/adr/0014-native-workflows-run-on-effects-own-engine.md` records why each of the
// pieces below is upstream's rather than Collie's.

import type { Asker } from "./proposals";
import { actorOf, readAudit, type ScheduledBy } from "./audit";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import {
  Cache,
  Cause,
  Clock,
  Context,
  Crypto,
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
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { ConfigError } from "effect/Config";
import type { PlatformError } from "effect/PlatformError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as DurableDeferred from "effect/workflow/DurableDeferred";
import * as WorkflowModules from "effect/workflow";
import * as ProcessModules from "effect/process";
import * as EffectRoot from "effect";
import * as AgentsSdk from "./agents";
import { Agents } from "./agents";
import * as Sdk from "./sdk";
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
  type WrittenDefinition,
  describeMetadata,
  jsonSchemaFor,
  type ChildAsk,
  type ChildRun,
  type ChildrenApi,
  type ActionFacts,
  type InputField,
  type InputFields,
  type WorkflowMetadata,
  type WorkflowAgentPreferences,
  type HostCodec,
  type HostPayload,
  type HostWorkflow,
  type Registration,
  type WorkflowDefinition,
  type WorkflowEntry,
} from "./sdk";
import { FALLBACK_DEFAULTS, configValue, gitlabHostOf, loadDefaults, readConfig } from "./config";
import { unlistedServers } from "./compaction";
import { foldPreferences, preferencesIn, resolveChoice } from "./harness";
import type { UsageReading } from "./usage-model";
import { currentEnv } from "./env";
import { waitForMemory } from "./memory-wait";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { gitDirOf, publicationCheckouts, throughAliases, remoteOf } from "./issue-privacy";
import {
  HelleClaimSchema,
  HelleError,
  credentials,
  helleHolders,
  releaseClaim,
  waitForHelle,
  type HelleClaim,
} from "./helle";
import { helleUrlOf } from "./helle-url";
import { currentPid, signalProcess } from "./lock";
import { skillDirs, skillFile, type CheckoutKind, type InputStrategy } from "./definitions";
import { EXCLUSIVE_STRATEGIES } from "./strategies";
import { appendMetric, noteVerification, metricsOf, readMetrics } from "./metrics";
import { ciJob } from "./ci-job";
import { land, LandingSchema, readLanding, takeOver } from "./landing";
import {
  carried,
  fastForward,
  readProduction,
  readRollback,
  readStage,
  readTag,
  type ProductionRead,
  type RollbackRead,
  type StageRead,
} from "./releasing";
import {
  blockedLine,
  reviewWaitOf,
  standingOf,
  type ReviewHead,
  type ReviewStanding,
} from "./review-wait";
import { AwaitingJson, AwaitingSchema, overdueLine } from "./awaiting";
import {
  autoMergingHere,
  forgeHere,
  prepareMergeRequest,
  postNote,
  productionCarries,
  projectHere,
  shell as runShell,
} from "./mr";
import { redact } from "./redact";
import { reportOf, type Recorded } from "./report";
import { outcomeRecordsOf, type OutcomeRecords } from "./outcomes";
import type { Metrics } from "./board-model";
import { mrRefOf, parseMrTarget, parseMrUrl } from "./board-model";
import { forgeOf } from "./forge/forge";
import { integrateDefault, integratedLine } from "./integrate";
import { strategyNamed } from "./strategies";
import { Notifier, SOUND, notificationTitle, openedSubject, wanted, type Sound } from "./notify";
import {
  Oversight,
  cardCheckpoints,
  checkDrift,
  grantedToRun,
  appendLog,
  said,
  settleAtFinish,
  standForElection,
  writeCard,
  type Correcting,
  type Watched,
} from "./oversight";
import { evaluationDeps } from "./evaluator";
import { budgetPath, herdOf } from "./steering";
import type { JudgementDeps } from "./drift";
import { finishedOnRecord, type Card } from "./cards";
import { reason, unsafePathComponent } from "./naming";
import { freshTaskLabel } from "./tasknames";
import { attachmentRefusal, attachmentsDir, copyInto, listAttachments } from "./attachments";
import {
  fromWorkSource,
  propagate,
  readIntent,
  seedIntent,
  writeIntent,
  type IntentSeed,
} from "./intent";
import { latest, readDispositions } from "./disposition";
import { openFindingsIn } from "./output";
import { isSingleRepo, planIssuesIn, planReposOf } from "./plan";
import { SELF, inputsFor, offersFrom, type Declared, type Offer } from "./offers";
import { isOutcome } from "./outcome";
import { Store, storeLayer, type Admission, type RunRow, type StoreApi } from "./store";
import {
  Answered,
  Controlled,
  HostRefused,
  OfferView,
  RequestConflict,
  RequestedBy,
  RunReport,
  type Disposition,
} from "./board-model";
import { TASK_INPUT, checkoutFor, repositoryName, workOf } from "./worktree";
import { Herdr, herdrFailureReason } from "./herdr";

import type { PluginEnv } from "./env";
import { StartedSchema, type RunAuthority, type Started } from "./automode";
import { WorktreeRecordSchema, type WorktreeRecord } from "./run";
import { listTasks, newTask, readTask, taskOfWorkspace, writeTask } from "./task";
import { nowIso, epochMs } from "./time";
import { classifyGivenTarget, classifyWorkSource, defaultBase } from "./inputs";
import type { BunServices } from "@effect/platform-bun/BunServices";
import {
  approvedFile,
  approvedFrom,
  approvedIn,
  encodeApproved,
  VerifySpecSchema,
  type VerifySpec,
} from "./verify-spec";
import { rerunArgv } from "./bun-tests";
import {
  checkCwd,
  commandOf,
  encodeVerifying,
  fingerprint,
  insideRun,
  ranCommand,
  readVerifications,
  recordFor,
  reliedFor,
  rerunTest,
  resolveExecutable,
  runApproved,
  VERIFYING_FILE,
  type CheckPass,
  type CheckRun,
  type Verification,
} from "./verify";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type * as MessageStorage from "effect/cluster/MessageStorage";

/** A module that cannot be loaded, named by its own file. Schema-backed, so the local
 *  host can fail a client with the same value rather than a copy of it. */
export class EntryError extends Schema.TaggedError<EntryError>()("EntryError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** What a refusal says first where the input is why, which a front door reads back. */
export const REFUSED_INPUT = "invalid_input";
/** The prefix of a refusal that names what a start left unsaid. */
export const NEEDS_INPUT = "needs_input";

/** A placement that may have changed something outside, which nothing here can prove either way. */
class PlacementUncertain extends Schema.TaggedError<PlacementUncertain>()("PlacementUncertain", {
  reason: Schema.String,
}) {}

export class ToolchainError extends Data.TaggedError("ToolchainError")<{
  readonly code: "toolchain_unavailable";
  readonly message: string;
}> {}

/**
 * The SDK the binary serves to a module it loads. Without this an external file resolves
 * `effect` from its own directory — a second copy whose `Effect.succeed` builds values
 * this process's runtime does not recognise, and whose service keys are not the host's.
 * The directory does hold one, because that is where an author's declarations come from,
 * which is exactly why serving the bundled namespaces has to win.
 *
 * Each index module is expanded into its members, so `effect/Effect` and
 * `effect/workflow/Workflow` are the binary's objects as surely as `effect` is.
 */
const NAMESPACES = [
  ["effect", EffectRoot],
  ["effect/workflow", WorkflowModules],
  ["effect/process", ProcessModules],
  // rc.117's path, so a module saved before 4.0.0 moved it still loads. Goes in Collie 0.42.0.
  ["effect/unstable/workflow", WorkflowModules],
] as const;

export const sdkModules = (): ReadonlyArray<readonly [string, object]> => {
  // Two files, one module: `sdk.ts` is what a module declares about itself and `agents.ts`
  // is what it does with an agent. They are apart because the second reaches for herdr
  // and the first must not, and an author has no reason to know that.
  const served: Array<readonly [string, object]> = [["collie", { ...Sdk, ...AgentsSdk }]];
  for (const [prefix, namespace] of NAMESPACES) {
    served.push([prefix, namespace]);
    for (const [name, member] of Object.entries(namespace))
      served.push([`${prefix}/${name}`, member]);
  }
  return served;
};

/** Kept in step with package.json, which `engine.test.ts` checks: the host and an
 *  author's declarations have to be the same Effect, or the types are about another one. */
export const TOOLCHAIN = {
  effect: "4.0.1",
  typescript: "^7.0.2",
} as const;

/**
 * The declarations an author typechecks `collie` against, kept in step with
 * `src/sdk.ts` by `engine.test.ts` — which typechecks a module using the whole
 * surface, so a declaration that has drifted fails a test rather than an author's build.
 */
export const SDK_DECLARATIONS = `declare module "collie" {
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
    /** The pipeline job a \`ci\` pass read, and the merge commit it ran on where not the head itself. */
    readonly job?: { readonly name: string; readonly url: string | null; readonly merge?: string };
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
  }

  /** A Run as the host admitted it: where it works, where its work belongs, what it was given. */
  export interface Place {
    readonly cwd: string;
    readonly dir: string;
    /** The host's own launch options — the RESERVED_INPUTS names — as a caller gave them. */
    readonly options: Readonly<Record<string, string>>;
    /** The Task this Run belongs to, whose workspace its agents open in; null for none. */
    readonly task: string | null;
    /** A workspace of the Run's own, where it asked for one; null lives in its Task's. */
    readonly workspace: string | null;
    /** This Run, then the Runs it was started from or builds a plan of, and so on: whose agents it may ask. */
    readonly lineage: ReadonlyArray<string>;
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

  /** What a merge at a head came to: \`MergedOutside\` is a merge this Run did not make. */
  export type MergeOutcome =
    | { readonly _tag: "Merged"; readonly sha: string }
    | { readonly _tag: "HeadMoved"; readonly head: string }
    | { readonly _tag: "MergedOutside"; readonly sha: string; readonly by: string; readonly at: string }
    | { readonly _tag: "Refused"; readonly reason: string };
  export const MergeOutcomeSchema: Schema.Codec<MergeOutcome, unknown, never, never>;

  /** What claim holds, with what a free-only claim left to whom, or why the claims a Run needs could not be settled. */
  export type Claimed =
    | {
        readonly slugs: ReadonlyArray<string>;
        readonly left?: ReadonlyArray<{ readonly slug: string; readonly holder: string }>;
      }
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
    | { readonly _tag: "Unanswered"; readonly head: string; readonly comments: ReadonlyArray<OpenComment> }
    | { readonly _tag: "Moved"; readonly head: string }
    | { readonly _tag: "Merged"; readonly sha: string; readonly by: string; readonly at: string }
    | { readonly _tag: "Closed" }
    | { readonly _tag: "Held" }
    | { readonly _tag: "Waiting"; readonly why: ReadonlyArray<string> }
    | { readonly _tag: "Unreadable"; readonly reason: string };
  export const ReviewStandingSchema: Schema.Codec<ReviewStanding, unknown, never, never>;

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
    readonly replies: ReadonlyArray<{ readonly id: string; readonly body: string }>;
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

  /** Where a fast-forward left the checkout, or why it left it alone. */
  export type FastForward =
    | { readonly _tag: "At"; readonly head: string; readonly from: string }
    | { readonly _tag: "Refused"; readonly why: string };
  export const FastForwardSchema: Schema.Codec<FastForward, unknown, never, never>;

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
        /** It failed where the branch leaves its target too: not this Run's to fix. */
        readonly before?: { readonly at: string; readonly url: string | null };
      };

  /** One of this Run's checks, named by a human, chat or the Run's agent. */
  export interface VerifySpec {
    readonly name: string;
    readonly executable: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
    /** The merge request pipeline job that proves it: nobody runs it locally. */
    readonly ci?: string;
  }

  /** The reviewed branch's checkout, or why there is none. */
  export type ReviewedCheckout =
    | { readonly cwd: string; readonly branch: string }
    | { readonly refused: string };

  /** What opening a merge request from here needs, and what it would be filled in with. */
  export interface MrReady {
    readonly ok: boolean;
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
    /** The command lines an agent runs, written by the forge's adapter. */
    readonly commands?: { readonly create: string; readonly comment: string };
  }

  /** What the host lends a workflow. Hold and stop are read fresh on every replay. */
  export interface HostApi {
    readonly report: (since: string) => Effect.Effect<Report, WorkflowError>;
    readonly issues: (runId: string) => Effect.Effect<ReadonlyArray<Issue>, WorkflowError>;
    readonly fileIssue: (options: { readonly runId: string; readonly title: string; readonly body: string }) => Effect.Effect<IssueRef, WorkflowError>;
    readonly commentIssue: (options: { readonly runId: string; readonly number: number; readonly body: string }) => Effect.Effect<void, WorkflowError>;
    readonly dir: string;
    /**
     * This Machine's Usage readings, one per Subscription. Read it inside an Activity of
     * the workflow's own where it branches on it, so a replay takes the same branch.
     */
    readonly usage: () => Effect.Effect<ReadonlyArray<UsageReading>>;
    /** The installed \`SKILL.md\` an agent's \`{{skill:name}}\` would name, or null. */
    readonly skill: (name: string) => Effect.Effect<string | null>;
    /** This Run as the host admitted it; its directory is made as this is answered. */
    readonly place: (runId: string) => Effect.Effect<Place>;
    /** The checkout of the branch this Run's diff target names, recorded as the Run's own. */
    readonly checkoutReviewed: (runId: string) => Effect.Effect<ReviewedCheckout>;
    readonly held: (runId: string) => Effect.Effect<boolean>;
    readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
    readonly record: (runId: string, event: string) => Effect.Effect<void>;
    /** Why this Run parked its own work, shown beside its status; null clears it. */
    readonly parked: (runId: string, why: string | null) => Effect.Effect<void>;
    readonly asking: (runId: string, question: DecisionSpec, asker?: string) => Effect.Effect<void>;
    /** Every question this run has been asked, oldest first, with its answer once it has one. */
    readonly asked: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly answer: string | null }>>;
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
      /** Approve the merge request too: a review with nothing live left to fix. */
      readonly approve?: boolean;
    }) => Effect.Effect<Posted>;
    /** This Run's checks as they stand now, which anyone may add to. */
    readonly approved: (runId: string) => Effect.Effect<ReadonlyArray<VerifySpec>>;
    /** One value from the operator's own configuration, by dotted name; empty for none. */
    readonly config: (dotted: string) => Effect.Effect<string>;
    /** Whether a merge request can be opened from here, and what it would carry. */
    readonly mr: (options: {
      readonly cwd: string;
      readonly target?: string;
      readonly source?: { readonly value: string; readonly kind: string };
    }) => Effect.Effect<MrReady>;
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
     * With settle, a failed job is read where the branch leaves its target, and is retried
     * once and waited on where it did not fail there too.
     */
    readonly ciJob: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly name: string;
      readonly wait?: boolean;
      readonly settle?: boolean;
    }) => Effect.Effect<CiJob>;
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
    /** The commit origin's default branch is at now. Take it inside an Activity. */
    readonly defaultHead: (cwd: string) => Effect.Effect<string, WorkflowError>;
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
    }) => Effect.Effect<ReviewStanding, WorkflowError>;
    /** Replies to comment \`comment\` of the recorded merge request, unless it is answered already. Take it inside an Activity. */
    readonly reply: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly comment: string;
      readonly body: string;
    }) => Effect.Effect<"posted" | "already", WorkflowError>;
    /** The recorded merge request's head, which of \`commits\` it carries, and its open external comments. Take it inside an Activity. */
    readonly reviewHead: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly commits: ReadonlyArray<string>;
    }) => Effect.Effect<ReviewHead, WorkflowError>;
    /** Fast-forwards the checkout to \`head\`, or refuses, resetting nothing. Take it inside an Activity. */
    readonly fastForward: (options: {
      readonly runId: string;
      readonly cwd: string;
      readonly head: string;
    }) => Effect.Effect<FastForward>;
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

  /** Which agent does the work: each is inherited from the configuration where it is left out. */
  export interface AgentPreferences {
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
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

  /** What a definition declares about itself beside what it does. None of it is a step. */
  export interface Declarations {
    readonly hints?: Readonly<Record<string, string>>;
    readonly outcome?: OutcomeContract;
    /** A worktree the host cuts before the Run exists; absent works where it was started. */
    readonly checkout?: "branch" | "roaming";
    readonly closes?: "reported";
    readonly followUps?: ReadonlyArray<FollowUp>;
    readonly actions?: ReadonlyArray<ActionProvider>;
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

  /** A question as the host records it: its identity, what it asks, what it takes. */
  export interface DecisionSpec {
    readonly name: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }

  /** A question this Run waits on, asked when the work reaches it. The name is its identity. */
  export function ask(question: {
    readonly name: string;
    readonly prompt?: string;
    /** The answers it takes; none is a question answered in the operator's own words. */
    readonly options?: ReadonlyArray<string>;
  }): Effect.Effect<string, never, Run | Host | WorkflowEngine | WorkflowInstance>;

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
    /**
     * The panel seat this work sits at: its agent over the role's, and its persona and
     * instructions where it names them. Work for a role given none takes the agent of the
     * role's first seat, and keeps its own persona and instructions.
     */
    readonly seat?: Seat;
  }

  /** A message handed to the live agent in this role of a Run this one came from, or null. */
  export function handOffWork(options: {
    readonly operation: string;
    readonly role: string;
    readonly text: string;
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
    | "docs" | "migration" | "review" | "plan";

  export type OutcomeContract =
    | { readonly fixed: Outcome; readonly selectable?: undefined }
    | { readonly fixed?: undefined; readonly selectable: ReadonlyArray<Outcome> };

  /**
   * Where an offer's input comes from, as the Run it is offered about knows it. A closed
   * list: Collie fills these in, and anything else is the caller's to give.
   */
  export type Source =
    | "run-dir"
    | "plan-dir"
    | "diff-target"
    | "branch"
    | "merge-request"
    | "started-with";

  export interface FollowUp {
    readonly id: string;
    readonly title: string;
    /** A public workflow id, or "self" for the one declaring it. */
    readonly workflow: string;
    readonly when: "succeeded" | "failed" | "always";
    /** What Collie fills in from the Run itself; the rest is the caller's to give. */
    readonly inputs?: Readonly<Record<string, Source>>;
    /** A further condition on the facts, where how it ended is not the whole of it. */
    readonly eligible?: (facts: ActionFacts) => boolean;
  }

  /** What an action decides eligibility from: facts, never a workflow's name. */
  export interface ActionFacts {
    readonly outcome: Outcome;
    readonly succeeded: boolean;
    readonly branch: string | null;
    readonly mrUrl: string | null;
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
    readonly id: string;
    readonly title: string;
    /** A public workflow id, or "self" for the one declaring it. */
    readonly workflow: string;
    readonly arguments: Schema.Struct.Fields;
    readonly eligible: (facts: ActionFacts) => boolean;
    /** What Collie fills in from the Run itself; the rest is the caller's to give. */
    readonly inputs?: Readonly<Record<string, Source>>;
  }

  /** Names the host supplies at launch; an input of one of these is refused. */
  export const RESERVED_INPUTS: Readonly<Record<string, string>>;
  export const EXCLUSIVE_STRATEGIES: ReadonlyArray<string>;

  export interface Finding {
    file?: string;
    line?: number;
    severity: string;
    title: string;
    detail?: string;
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
  export function blockingKeys(findings: ReadonlyArray<Finding>): string[];
  /** Whether a blocking finding says where and why, so it can be acted on. */
  export function substantiated(finding: Finding): boolean;
  export function unsubstantiated(findings: ReadonlyArray<Finding>): string | null;
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
  export function renderReview(synthesis: Synthesis): string;
  export function formatFindings(findings: ReadonlyArray<Finding>): string;

  /** The prose a human reads, and the findings a card counts, where both are looked for. */
  export const REVIEW_FILE: string;
  export const FINDINGS_FILE: string;
  export function leaveReview(
    dir: string,
    synthesis: SynthesisReport,
  ): Effect.Effect<void, never, FileSystem.FileSystem>;

  /** The findings still standing after a last fix settleFinalFix accepted; the prose stays. */
  export function leaveOutstanding(
    dir: string,
    outstanding: ReadonlyArray<Finding>,
  ): Effect.Effect<void, never, FileSystem.FileSystem>;

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
  /** The forge a merge request is on. */
  export function forgeOfRef(ref: MrRef): "gitlab" | "github";

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
  export const SynthesisSchema: Schema.Codec<SynthesisReport, unknown, never, never>;
  export const FixOutputSchema: Schema.Codec<FixReport, unknown, never, never>;
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
  }

  /** The verification names a ticket's **Checks:** line promises. */
  export function checksIn(text: string): string[];

  /**
   * A ticket's acceptance criteria: each checkbox item with its wrapped lines, under its
   * Acceptance criteria heading where it has one, and never under ## After merge. A nested
   * list and fenced code are not.
   */
  export function criteriaIn(text: string): string[];

  /** What only CI, a merge or a deploy can show: the items under a ticket's ## After merge. */
  export function afterMergeIn(text: string): string[];

  /** A plan's tickets in an order they can be built in, narrowed to one repository. */
  export function orderedTickets(
    tickets: ReadonlyArray<{ readonly file: string; readonly text: string }>,
    repo?: string,
  ): Slice[];

  /** The same reading, against a plan directory on disk. */
  export function orderedTicketsOf(
    planDir: string,
    repo?: string,
  ): Effect.Effect<Slice[], never, FileSystem.FileSystem | Path.Path>;

  /** One repository a plan changes, and the tickets that change it, in plan order. */
  export interface PlanRepo {
    readonly path: string;
    readonly tickets: ReadonlyArray<string>;
  }

  /** Why this plan cannot be fanned out. The message is what the human is shown. */
  export interface PlanRefusal {
    readonly kind:
      | "cycle"
      | "missing-repo"
      | "missing-checkout"
      | "outside-root"
      | "unknown-blocker"
      | "duplicate-ticket";
    readonly message: string;
  }

  export interface PlanRepos {
    readonly repos: ReadonlyArray<PlanRepo>;
    /** Repo paths in the order their runs may start; each wave waits on the one before. */
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

  /** What was actually collected, and by whom, for a merge request to say what it proved. */
  export function renderEvidence(
    got: { readonly verifications: ReadonlyArray<Verification>; readonly final: Snapshot },
  ): string;

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

  /**
   * A Check's proof on this tree: passed, failed, unstable, passed only on an earlier tree, or
   * never run; for a check left to CI, waiting on its job or proved by it.
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

/**
 * Registers the SDK with Bun's module resolver, once per process. A virtual module per
 * specifier, so `import "effect"` from anywhere in the author's imports lands here.
 */
/** `self` is the workflow that declared the offer, whatever a fork has renamed it to. */
const itself = (workflow: string) => (workflow === "self" ? SELF : workflow);

/**
 * What a module declares, as offers. The eligibility functions are the author's own and
 * are kept as they are: the module is the only thing that can answer for its own actions,
 * and a projection of one would be a copy that stops agreeing with it.
 */
export function declaredByModule(metadata: WorkflowMetadata | undefined): Declared[] {
  const actions = (metadata?.actions ?? []).map((action) => ({
    id: action.id,
    title: action.title,
    workflow: itself(action.workflow),
    arguments: jsonSchemaFor(Schema.Struct(action.arguments)).document,
    kind: "action" as const,
    inputs: action.inputs ?? {},
    eligible: action.eligible,
  }));
  const followUps = (metadata?.followUps ?? []).map((offer) => ({
    id: offer.id,
    title: offer.title,
    workflow: itself(offer.workflow),
    arguments: null,
    kind: "follow-up" as const,
    inputs: offer.inputs ?? {},
    eligible: (facts: ActionFacts) =>
      (offer.when === "always" || (offer.when === "succeeded") === facts.succeeded) &&
      (offer.eligible?.(facts) ?? true),
  }));
  return [...actions, ...followUps];
}

export function installSdk(): void {
  if (sdkInstalled) return;
  sdkInstalled = true;
  Bun.plugin({
    name: "collie-sdk",
    setup(build) {
      for (const [specifier, namespace] of sdkModules()) {
        // Spread rather than passed on: Bun's object loader takes a plain object, and
        // the values in it stay the very functions and keys the binary is running on.
        build.module(specifier, () => ({ exports: { ...namespace }, loader: "object" }));
      }
    },
  });
}

/**
 * Imports a workflow entry file and holds it to the published contract. A module that
 * does not compile, does not exist, does not export the contract or contradicts itself
 * fails naming its own file — so one bad entry says which one it is and leaves every
 * other entry loadable.
 *
 * Importing runs the module's top level, which is the author's code. It does not run a
 * workflow body, acquire an agent or open a worktree; nothing here is a sandbox. What the
 * definition declares is checked here, at load, which is why a contradiction never
 * reaches a Run.
 */
export const loadEntry: (
  file: string,
  /** Its directory's `revisionOf`, where a caller reading every entry in it has it already. */
  revision?: string,
) => Effect.Effect<WorkflowEntry, EntryError, FileSystem.FileSystem> = Effect.fn(
  "Engine.loadEntry",
)(function* (file: string, revision?: string) {
  installSdk();
  // Bun's module registry has no invalidation, so an entry or a helper read twice at one
  // path is the first read both times. Each read is of a copy of what is there now.
  const staged = yield* stagedEntry(file, revision);
  const loaded = yield* Effect.tryPromise({
    try: () => import(staged.file),
    catch: (cause) => new EntryError({ file, message: String(cause).replaceAll(staged.root, "") }),
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
    return yield* new EntryError({ file, message: problems.join("; ") });
  }
  return entry;
});

const IsSchema = Schema.declare(Schema.isSchema);

/** What a default export has to be before it is read as a definition. */
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

/** A module's default export held to the contract a definition is read against. */
const isWritten = (exported: unknown): exported is WrittenDefinition =>
  Schema.is(DefinitionContract)(exported);

/** A definition as the entry the rest of the host reads. */
const entryOf = (definition: WorkflowDefinition): WorkflowEntry => {
  const { outcome, checkout, closes, followUps, actions } = definition;
  const hints =
    definition.hints === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(definition.hints).map(([name, hint]) => [name, strategyNamed(hint)]),
        );
  const declared = Object.fromEntries(
    Object.entries({ hints, outcome, checkout, closes, followUps, actions }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  // SAFETY: checkEntry refuses an input field that is not a schema before anything settles one.
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    input: definition.input.fields as InputFields,
    metadata: declared,
    agents: definition.agents,
    make: (name) => registrationOf(definition, name),
  };
};

/** The strategies the executing definition declares, so its host can read a Run's diff target. */
const WorkflowHints = Context.Reference<Readonly<Record<string, InputStrategy>>>(
  "collie/WorkflowHints",
  { defaultValue: () => ({}) },
);

/** The envelope a definition is executed with, read where the host hands it over. */
const readEnvelope = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));

/** Observed Run entries; upstream resume returns no wake acknowledgment. */
const entriesOf = new WeakMap<HostWorkflow, Map<string, number>>();

const waitForEntry = (workflow: HostWorkflow, runId: string, before: number) =>
  Effect.suspend(() =>
    (entriesOf.get(workflow)?.get(runId) ?? 0) > before ? Effect.succeed(true) : Effect.fail(false),
  ).pipe(
    Effect.retry({ times: WAKE_TRIES, schedule: Schedule.spaced(WAKE_INTERVAL) }),
    Effect.orElseSucceed(() => false),
  );

/**
 * The Effect workflow a definition is registered as, under the host's own name for this
 * generation. The Run it executes as is provided here, so no author passes it along.
 */
const registrationOf = (definition: WorkflowDefinition, name: string): Registration => {
  // SAFETY: every workflow is executed with this envelope, and its input is the
  // definition's own struct, whose fields checkEntry has held to be schemas.
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
  const body = workflow.toLayer((envelope) => {
    // SAFETY: the envelope decoded against the definition's own input struct.
    const input = envelope.input as never;
    const run = Run.of({ id: readEnvelope(envelope).runId, workflow: definition.id });
    entries.set(run.id, (entries.get(run.id) ?? 0) + 1);
    return definition.run({ input }).pipe(
      Effect.provideService(Run, run),
      Effect.provideService(WorkflowAgents, definition.agents),
      Effect.provideService(WorkflowHints, definition.hints ?? {}),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : ended(run.id, exitStatus(exit, definition.id, workflow.successSchema, error)),
      ),
    );
  });
  const layer = definition.layer === undefined ? body : body.pipe(Layer.provide(definition.layer));
  return { workflow, layer };
};

/**
 * A Run's ending, as the host tells it: what Oversight settles as it finishes, then the
 * toast. A suspension is not an ending, and a question or a stop says so for itself.
 */
const ended = (runId: string, status: typeof RunStatus.Type) =>
  Effect.serviceOption(Oversight).pipe(
    Effect.flatMap((found) => (Option.isSome(found) ? found.value.finish(runId) : Effect.void)),
    Effect.andThen(told(runId, status)),
  );

/** What an ending says to whoever started the Run, in the words the board reads it in. */
const told = (runId: string, status: typeof RunStatus.Type) =>
  Effect.serviceOption(Notifier).pipe(
    Effect.flatMap((found) => {
      if (Option.isNone(found)) return Effect.void;
      if (status.status === "complete") {
        return found.value.notify(
          runId,
          "run-done",
          isText(status.value) ? status.value : asJsonText(status.value),
        );
      }
      if (status.status !== "failed") return Effect.void;
      return found.value.notify(
        runId,
        status.reason.startsWith("output-unusable:") ? "output-unusable" : "run-failed",
        status.reason,
      );
    }),
  );

/**
 * Where entries are staged to be read: this account's own cache, and only while nobody
 * else can write there, since what is in it is imported as code. A copy is named by its
 * content, so it is never stale.
 */
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

/**
 * An entry's directory as it is now, staged once and then shared by every process that
 * reads it. Staged under a name of its own and renamed into place, so nobody imports a
 * copy another process is still writing.
 */
const stagedEntry = Effect.fn("Engine.stagedEntry")(function* (file: string, revision?: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* entriesRoot(file);
  const dir = directoryOf(file);
  const name = `${Bun.hash(dir).toString(16)}-${revision ?? (yield* revisionOf(dir))}`;
  const root = `${entries}/generations/${name}`;
  const staged = { root, file: `${root}${file}` };
  if (yield* fs.exists(staged.file).pipe(Effect.orElseSucceed(() => false))) {
    // Its age is its last use, which is what cleanup removes it by (ADR-0045).
    const now = DateTime.toDateUtc(yield* DateTime.now);
    yield* fs.utimes(root, now, now).pipe(Effect.ignore);
    return staged;
  }
  const draft = `${name}.${yield* Random.nextInt}`;
  yield* stageGeneration({ dir: entries, name: draft, entry: file }).pipe(
    Effect.provide(Path.layer),
  );
  const drafted = `${entries}/generations/${draft}`;
  // Another process that staged it first is as good as this one.
  yield* fs
    .rename(drafted, root)
    .pipe(Effect.catch(() => fs.remove(drafted, { recursive: true }).pipe(Effect.ignore)));
  return staged;
});

/**
 * What beside an entry is not its code: the installed toolchain, linked rather than copied,
 * and the project file a typecheck writes for itself and removes again.
 */
const unstaged = (name: string) => name === "node_modules" || name.startsWith(CHECK_PROJECT);
const CHECK_PROJECT = ".collie-check";

/**
 * Every path under `dir` a recursive listing names, but none of what is `unstaged`: a
 * provisioned toolchain is thousands of files, and every load of every entry beside it
 * listed them all.
 */
const sourcesIn = Effect.fn("Engine.sourcesIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const names: Array<string> = [];
  const top = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed((): Array<string> => []));
  for (const name of top) {
    if (unstaged(name)) continue;
    names.push(name);
    // A link is named and not followed, as a recursive listing treats it.
    const link = yield* fs.readLink(`${dir}/${name}`).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (link) continue;
    const below = yield* fs
      .readDirectory(`${dir}/${name}`, { recursive: true })
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    names.push(...below.map((one) => `${name}/${one}`));
  }
  return names;
});

/**
 * What a generation of an entry would be staged from, as one value. A generation is a copy
 * of the whole directory and of what it imports from outside it, so an edited helper or
 * Markdown prompt is as much a change as an edited entry — and nothing touched is the same
 * code to run.
 */
export const revisionOf: (dir: string) => Effect.Effect<string, never, FileSystem.FileSystem> =
  Effect.fn("Engine.revisionOf")(function* (dir: string) {
    const fs = yield* FileSystem.FileSystem;
    // An installed dependency counts by its names alone: the toolchain a module is
    // typechecked against lives here too, and reading all of it would cost more than
    // every start it is on the way of.
    const installed = yield* fs
      .readDirectory(`${dir}/node_modules`, { recursive: true })
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    let read = installed
      .sort()
      .map((name) => `node_modules/${name}\n`)
      .join("");
    for (const name of (yield* sourcesIn(dir)).sort()) {
      // A directory reads as nothing, and what is inside it is in the list under a name
      // of its own.
      const content = yield* fs
        .readFileString(`${dir}/${name}`)
        .pipe(Effect.orElseSucceed(() => ""));
      read += `${name}:${Bun.hash(content).toString(16)}\n`;
    }
    for (const file of yield* outsideOf(dir)) {
      const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      read += `${file}:${Bun.hash(content).toString(16)}\n`;
    }
    return Bun.hash(read).toString(16);
  });

/**
 * The files outside `dir` its code imports by a relative path or a package import, what
 * those import in turn, and the `package.json` files above them that such imports resolve by.
 */
const outsideOf = Effect.fn("Engine.outsideOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const pending = (yield* sourcesIn(dir)).map((name) => `${dir}/${name}`);
  const outside = new Set<string>();
  const looked = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    for (let at = parentOf(file); !looked.has(at); at = parentOf(at)) {
      looked.add(at);
      if (at === dir || at.startsWith(`${dir}/`)) continue;
      const manifest = `${at}/package.json`;
      if (yield* fs.exists(manifest).pipe(Effect.orElseSucceed(() => false))) {
        outside.add(manifest);
      }
    }
    const loader = loaderOf(file);
    if (loader === null) continue;
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    for (const target of importedBy(file, text, loader)) {
      if (target.startsWith(`${dir}/`) || outside.has(target)) continue;
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

/**
 * What this code imports by a relative path or a package import, where Bun resolves it.
 * Unparseable code imports nothing, and an installed package is linked, never copied.
 */
const importedBy = (file: string, text: string, loader: "ts" | "tsx" | "js") => {
  let imports: ReadonlyArray<{ readonly path: string }> = [];
  try {
    imports = scanners[loader].scanImports(text);
  } catch {
    return [];
  }
  return imports.flatMap((one) => {
    if (!one.path.startsWith(".") && !one.path.startsWith("#")) return [];
    try {
      const target = Bun.resolveSync(one.path, directoryOf(file));
      return target.includes("/node_modules/") ? [] : [target];
    } catch {
      return [];
    }
  });
};

/**
 * A generation's own copy of the directory the entry lives in, so an edited helper reaches
 * new work without restarting the host. Bun's module registry has no invalidation:
 * re-importing the entry under a new query re-reads the entry, but its `./helper.ts`
 * resolves to the path already cached. A copy gives every file a path nothing has
 * imported yet. The directory and what it imports from outside it are copied to their
 * absolute paths under the generation, so every relative import names the same file, and
 * every `node_modules` a package is looked up in is linked where its copy looks.
 * It is a cache — a host wipes it on start and stages from the module as it is now, so
 * this is never the code a past run is recovered onto.
 */
export const stageGeneration: (options: {
  readonly dir: string;
  readonly name: string;
  readonly entry: string;
}) => Effect.Effect<string, EntryError, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Engine.stageGeneration",
)(function* (options: { readonly dir: string; readonly name: string; readonly entry: string }) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const from = directoryOf(options.entry);
  const outside = yield* outsideOf(from);
  const staged = (file: string) => path.join(options.dir, "generations", options.name, file);
  const failed = (cause: unknown) =>
    new EntryError({ file: options.entry, message: String(cause) });
  yield* fs.makeDirectory(staged(from), { recursive: true }).pipe(Effect.mapError(failed));
  for (const name of yield* fs.readDirectory(from).pipe(Effect.mapError(failed))) {
    if (unstaged(name)) continue;
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
  for (const start of [from, ...outside.map((file) => path.dirname(file))]) {
    for (let at = start; !looked.has(at); at = path.dirname(at)) looked.add(at);
  }
  for (const at of looked) {
    const installed = path.join(at, "node_modules");
    const link = path.join(staged(at), "node_modules");
    if (!(yield* fs.exists(installed).pipe(Effect.orElseSucceed(() => false)))) continue;
    if (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false))) continue;
    yield* fs
      .makeDirectory(staged(at), { recursive: true })
      .pipe(Effect.andThen(fs.symlink(installed, link)), Effect.mapError(failed));
  }
  return staged(options.entry);
});

const loaderOf = (name: string): "ts" | "tsx" | "js" | null => {
  if (/\.(ts|mts|cts)$/.test(name)) return "ts";
  if (name.endsWith(".tsx")) return "tsx";
  return /\.(js|mjs|cjs|jsx)$/.test(name) ? "js" : null;
};

const directoryOf = (file: string) => file.slice(0, file.lastIndexOf("/"));
const parentOf = (at: string) => at.slice(0, Math.max(at.lastIndexOf("/"), 1));

/** A file and what was in its directory when it was read, as one value. */
const sourceOf = (entry: string): Effect.Effect<string, never, FileSystem.FileSystem> =>
  revisionOf(directoryOf(entry)).pipe(Effect.map((revision) => `${entry}@${revision}`));

/** Every generation a host staged, gone: a new host stages from the sources again. */
export const clearGenerations = (dir: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.remove(`${dir}/generations`, { recursive: true })),
    Effect.ignore,
  );

/**
 * The host's own stack: Bun's SQLite under Effect's single-node cluster under its
 * workflow engine. Two settings are not the defaults, and both would otherwise turn
 * recoverable work terminal — the reason each is here is in ADR-0014.
 */
export function engineLayer(options: {
  readonly dir: string;
  /** How often the engine reads its storage for messages now due; upstream's default if unset. */
  readonly messagePoll?: Duration.Input | undefined;
}): Layer.Layer<
  | WorkflowEngine.WorkflowEngine
  | MessageStorage.MessageStorage
  | SqlClient.SqlClient
  | Reactivity.Reactivity,
  ConfigError
> {
  // One connection, two halves: the engine's own tables and the rows Collie keeps beside
  // them are in the same file, written by the same process.
  // A host that cannot open its own database has nothing to serve.
  const sql = SqliteClient.layer({ filename: `${options.dir}/host.db` }).pipe(
    Layer.orDie,
    Layer.provideMerge(Reactivity.layer),
  );
  const shardingConfig = {
    // A host told to stop must not take a running workflow down with it: the work
    // finishes its step, and what is left is picked up by the next host.
    preemptiveShutdown: false,
    // A workflow whose module is missing has no entity to receive its messages. The
    // default marks them failed after a minute, which turns "the file is not there
    // yet" into a terminal result; waiting is what lets a repair recover the work.
    entityRegistrationTimeout: Duration.infinity,
  };
  const polled =
    options.messagePoll === undefined
      ? shardingConfig
      : { ...shardingConfig, entityMessagePollInterval: options.messagePoll };
  // Loaded when a host builds it, not when anything imports this file: the cluster is
  // the heaviest thing here, and every other command the binary runs is a client.
  const engine = Layer.unwrap(
    Effect.promise(() =>
      Promise.all([
        import("effect/cluster/SingleRunner"),
        import("effect/cluster/ClusterWorkflowEngine"),
      ]),
    ).pipe(
      Effect.map(([SingleRunner, ClusterWorkflowEngine]) => {
        const cluster = SingleRunner.layer({ shardingConfig: polled }).pipe(
          Layer.provide([sql, BunCrypto.layer]),
        );
        // The message storage too: forgetting a Run clears what the engine kept of it.
        return ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster));
      }),
    ),
  );
  return engine.pipe(Layer.provideMerge(sql));
}

/** What the engine kept of one execution of a workflow registered under `name`, gone. */
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
    // Messages are found by entity type and id; the shard is part of the address only.
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

/** How long a start waits for the engine to take its Run before it is refused. */
const HAND_OVER_TIMEOUT = "30 seconds";

export const HOLD = "hold";
export const STOP = "stop";
/** Why work parked; the host clears it when taking that work up. */
export const PARKED = "parked";
/** A wait that ends by itself; the host clears it when the wait ends. */
export const AWAITING = "awaiting";

/** What a Run nobody classified proves: the approved set, and no ticket's evidence. */
const UNSPECIFIED = "unspecified";

/**
 * What a workflow reads about its own run: the controls an operator has set over it, and
 * the question it is waiting on.
 *
 * A control is one file in the host's own directory, and the host is its only writer —
 * no client writes one and nothing consumes it as a command. It stays a file rather than
 * a row because a workflow reads it at its boundaries, from the engine's own fiber:
 * answering that read out of this process's memory or its database settles the boundary
 * fast enough to race a resume, and the run parks again before the resume has landed.
 * `docs/adr/0021-one-host-answers-for-a-run.md` has the measurement.
 */
export const controlPath = (dir: string, control: string, runId: string): string =>
  `${dir}/${control}.${runId}`;

/**
 * Where one Run's evidence lives: the verification journal `verify.ts` writes and
 * reads, and the approved set the Run was started under. A directory rather than a table
 * because the collector is the same one the command line uses — what proves a Run is not
 * a different thing for being a module's.
 */
export const evidenceDir = (dir: string, runId: string): string => `${dir}/evidence/${runId}`;

/**
 * Where one Run's own work belongs: the plan it wrote, the review it left, and
 * anything else a card reads back. A directory per Run rather than a column, because what
 * a Run produces is files and the things that read them are ordinary readers of files.
 */
export const runDir = (dir: string, runId: string): string => `${dir}/runs/${runId}`;

/** The Run whose own plan directory this Input value is, and null where it is none. */
const planRunOf = (value: string): string | null =>
  /(?:^|\/)runs\/([^/]+)\/plan\/?$/.exec(value)?.[1] ?? null;

/**
 * A Run, then the Runs it came from: its parent and the Run whose plan it builds. Stops at
 * a Run the store has no row for, and at a cycle.
 */
const lineageIn = (store: StoreApi) =>
  Effect.fn("Engine.lineageOf")(function* (runId: string) {
    const lineage = [runId];
    for (let at = 0; at < lineage.length; at++) {
      const row = yield* store.run(lineage[at]!);
      if (row === null) continue;
      const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
      const plan = Object.values(input).filter(Schema.is(Schema.String)).map(planRunOf);
      for (const from of [row.parent, ...plan])
        if (from != null && !lineage.includes(from)) lineage.push(from);
    }
    return lineage;
  });

const decodeAskedAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ attachments: Schema.optional(Schema.Array(Schema.String)) }),
  ),
);

/** Where a Run keeps the merge request it opened. */
const mergeRequestPath = (dir: string, runId: string) => `${runDir(dir, runId)}/merge-request`;

/** The merge request a Run opened, or null where it recorded none. */
const mergeRequestOf = (fs: FileSystem.FileSystem, dir: string, runId: string) =>
  fs.readFileString(mergeRequestPath(dir, runId)).pipe(
    Effect.map((url) => url.trim() || null),
    Effect.orElseSucceed(() => null),
  );

const approvedPath = (dir: string, runId: string) => approvedFile(evidenceDir(dir, runId));

/**
 * This Run's checks as they were when the Run started. Frozen at
 * admission, so editing the file changes the next Run and never a live one.
 */
export const freezeApproved = Effect.fn("Engine.freezeApproved")(function* (options: {
  readonly dir: string;
  readonly runId: string;
  readonly project: string;
  readonly userDir: string;
  /** The set the start already settled; without it, the files are read here. */
  readonly approved?: ReadonlyArray<VerifySpec>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = approvedPath(options.dir, options.runId);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return;
  const approved =
    options.approved ??
    (yield* approvedFrom({
      cwd: options.project,
      userDir: options.userDir,
      project: yield* projectHere(options.project, runShell),
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => [])));
  yield* fs.makeDirectory(evidenceDir(options.dir, options.runId), { recursive: true });
  yield* fs.writeFileString(path, encodeApproved(approved));
});

const approvedOf = (dir: string, runId: string) => approvedIn(evidenceDir(dir, runId));

/** Where a host keeps what a Run claimed, so a resume knows whose the claim was. */
const claimPath = (dir: string, runId: string) => `${runDir(dir, runId)}/helle.json`;

// A single claim is how a host recorded one before a Run could hold several.
const decodeClaims = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([HelleClaimSchema, Schema.Array(HelleClaimSchema)])),
);
const encodeClaims = Schema.encodeSync(Schema.fromJsonString(Schema.Array(HelleClaimSchema)));

/** What this Run already claimed, empty where it has claimed nothing yet. */
const recordedClaims = (
  file: string,
): Effect.Effect<ReadonlyArray<HelleClaim>, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.flatMap(decodeClaims),
    Effect.map((read) => ("slug" in read ? [read] : read)),
    Effect.orElseSucceed((): ReadonlyArray<HelleClaim> => []),
  );

/** Writes a Run's claims, and removes the record where none are left. */
const writeClaims = (file: string, claims: ReadonlyArray<HelleClaim>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      claims.length === 0
        ? fs.remove(file, { force: true })
        : fs.writeFileString(file, encodeClaims(claims)),
    ),
  );

// Several Runs change one Run's record at once: one adopting a claim, the Run recording or
// releasing its own.
const changingClaims = Semaphore.makeUnsafe(1);

/** Changes a Run's claims as they are now, one change at a time. */
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

/** The Helle projects a repository's `.collie/helle.json` declares, null where it has none. */
const declaredProjects = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = `${cwd}/.collie/helle.json`;
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return null;
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
      // Roaming checkout names do not identify Helle projects.
      repoName: (yield* repositoryName(runShell, cwd)) ?? (yield* Path.Path).basename(cwd),
      deploys: deploys ?? null,
      declared: yield* declaredProjects(cwd),
    };
  });

/**
 * The Run's Check a command is, with the latest record this host collected of it on this
 * tree, or null where the command is none of the Run's Checks.
 */
export class Reliance extends Context.Service<
  Reliance,
  {
    readonly relied: (
      runId: string,
      command: Pick<Verification, "executable" | "argv" | "cwd">,
    ) => Effect.Effect<{ readonly check: string; readonly record: Verification | null } | null>;
  }
>()("collie/Reliance") {}

/** A Run's execution as the host that runs it can stop it and see it stopped. */
export class Executions extends Context.Service<
  Executions,
  {
    /**
     * An operator's stop: the Run and every child it started, flagged, woken and their
     * agents closed. Answers the Runs it reached and the agents that did not close.
     */
    readonly stop: (runId: string) => Effect.Effect<{
      readonly runs: ReadonlyArray<string>;
      readonly left: ReadonlyArray<string>;
    }>;
    /** Whether its execution has stopped: suspended, finished, or not one this host runs. */
    readonly stopped: (runId: string) => Effect.Effect<boolean>;
  }
>()("collie/Executions") {}

/**
 * Takes a claim over from this operator's other Runs that recorded it. Each is stopped
 * with every child it started, as an operator's stop does; their executions are waited
 * out; and their agents are closed again, for any that started before they stopped. Only
 * then is its record of the claim removed, so nothing it left running goes on changing
 * what the claim guards. An agent that will not close, or a Run still in a step when
 * patience runs out, refuses the adoption. Answers the Runs it was taken from.
 */
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
  const handed: string[] = [];
  for (const runId of options.runs) {
    if (runId === options.to) continue;
    const file = claimPath(options.dir, runId);
    const record = yield* recordedClaims(file);
    if (!record.some((one) => one.slug === options.slug)) continue;
    const refused = (left: ReadonlyArray<string>) =>
      new HelleError({
        message: `the claim on ${options.slug} is ${runId}'s, and its agents did not all close (${left.join("; ")}); close them, then resume ${options.to}`,
      });
    const tree = yield* options.stop(runId);
    if (tree.left.length > 0) return yield* refused(tree.left);
    const deadline = (yield* Clock.currentTimeMillis) + patience.forMs;
    for (const one of tree.runs) {
      while (!(yield* options.stopped(one))) {
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return yield* new HelleError({
            message: `the claim on ${options.slug} is ${runId}'s, and ${one} is still running a step its stop has not reached; resume ${options.to} once ${one} has stopped`,
          });
        }
        yield* Effect.sleep(Duration.millis(patience.everyMs));
      }
    }
    const late: string[] = [];
    for (const one of tree.runs) late.push(...(yield* options.halt(one)).left);
    if (late.length > 0) return yield* refused(late);
    yield* updateClaims(file, (now) => now.filter((one) => one.slug !== options.slug)).pipe(
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

/** Where a checkout was before a comparison at the default branch moved it. */
const AWAY_FILE = "away-from";

/** A comparison a crash interrupted leaves the checkout at the base; this puts it back. */
const restoreCheckout = (cwd: string, away: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const back = yield* fs.readFileString(away).pipe(Effect.orElseSucceed(() => ""));
    if (back === "") return;
    if ((yield* runShell("git", ["checkout", "-q", back], cwd)).code !== 0) {
      return yield* new WorkflowError({ reason: `the checkout could not be put back on ${back}` });
    }
    yield* fs.remove(away).pipe(Effect.ignore);
  });

/** The pass a workflow's verify asked for: at the default branch's base it is `baseline`. */
const passAsked = (asked: Parameters<Sdk.HostApi["verify"]>[0]): CheckPass => {
  if (asked.at === "default-base") return { pass: "baseline" };
  if (asked.pass === "fix" && asked.round !== undefined) return { pass: "fix", round: asked.round };
  return { pass: asked.pass ?? "check" };
};

/**
 * Runs `body` with the checkout at its merge-base with the default branch, then puts it
 * back. A checkout with changes of its own is refused: they would travel to the base.
 */
const atDefaultBase = <A, R>(
  cwd: string,
  away: string,
  body: (branch: string) => Effect.Effect<A, WorkflowError, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = (...args: string[]) => runShell("git", args, cwd);
    const refuse = (why: string) =>
      new WorkflowError({ reason: `not compared at the default branch: ${why}` });
    if ((yield* git("status", "--porcelain")).stdout.trim() !== "") {
      return yield* refuse("the checkout has changes of its own");
    }
    const branch = yield* defaultBase(runShell, cwd);
    if (branch === null) return yield* refuse("no default branch");
    const remote = yield* git("merge-base", "HEAD", `origin/${branch}`);
    const merged = remote.code === 0 ? remote : yield* git("merge-base", "HEAD", branch);
    if (merged.code !== 0) return yield* refuse(`no merge-base with ${branch}`);
    const head = (yield* git("rev-parse", "HEAD")).stdout.trim();
    const named = yield* git("symbolic-ref", "-q", "--short", "HEAD");
    const back = named.code === 0 ? named.stdout.trim() : head;
    yield* fs.writeFileString(away, back).pipe(Effect.orDie);
    if ((yield* git("checkout", "-q", "--detach", merged.stdout.trim())).code !== 0) {
      yield* fs.remove(away).pipe(Effect.ignore);
      return yield* refuse(`${merged.stdout.trim()} could not be checked out`);
    }
    return yield* body(branch).pipe(Effect.ensuring(restoreCheckout(cwd, away).pipe(Effect.orDie)));
  });

export const hostLayer = (options: {
  readonly dir: string;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly userDir?: string;
  /** Where a toast goes; left out, nothing is raised. */
  readonly toast?: Toast;
  /** The Herd this host works for; left out, nothing is judged or charged to one. */
  readonly herd?: Herd;
  /** This Machine's Usage readings; none where left out. */
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  /** The herdr a reviewed checkout is made through; the host's own by default. */
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  /** How often a wait for production asks the forge again. */
  readonly productionPoll?: Duration.Input;
  /** How long the checkouts issue text is checked against may take to find. */
  readonly issuePrivacyBudget?: Duration.Input;
  /** How often a wait for review reads the merge request again. */
  readonly reviewPoll?: Duration.Input;
}): Layer.Layer<Host | Notifier | Oversight | Reliance, never, Store | BunServices> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const dir = options.dir;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* Store;
      // Captured, so a workflow asks for a verification without asking for a filesystem.
      type Collecting = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
      const services = yield* Effect.context<Collecting>();
      const bun = yield* Effect.context<BunServices>();
      const under = <A, E>(effect: Effect.Effect<A, E, Collecting>) =>
        Effect.provideContext(effect, services);
      const set = (control: string, runId: string) =>
        fs.exists(controlPath(dir, control, runId)).pipe(Effect.orElseSucceed(() => false));
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
      const toast = options.toast;
      const notify: Notifier["Service"]["notify"] = (runId, kind, body, about = {}) =>
        toast === undefined
          ? Effect.void
          : under(
              Effect.gen(function* () {
                const settings =
                  options.userDir === undefined
                    ? {}
                    : (yield* loadDefaults(options.userDir)).notifications;
                if (!wanted(settings, kind)) return;
                // ponytail: one line per toast raised, read whole; a Run raises a handful.
                const said = `${kind}:${(about.key ?? "").replaceAll("\n", " ")}`;
                const file = notifiedPath(dir, runId);
                const before = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
                if (before.split("\n").includes(said)) return;
                yield* fs.writeFileString(file, `${said}\n`, { flag: "a" });
                const row = yield* store.run(runId);
                const cwd =
                  row === null
                    ? dir
                    : placedOf(
                        row,
                        yield* decodeStrings(row.options ?? "{}").pipe(
                          Effect.orElseSucceed((): Record<string, string> => ({})),
                        ),
                      ).cwd;
                yield* toast(
                  notificationTitle(kind, cwd, row?.task ?? runId, about.subject),
                  body,
                  SOUND[kind],
                );
              }),
            ).pipe(Effect.ignore);
      const lineageOf = lineageIn(store);
      const hostStarted = yield* nowIso();
      /** A pass this host collected that answers for this check now, said in the Run log. */
      const relyOn = (runId: string, run: CheckRun, spec: VerifySpec, recorded: CheckPass) =>
        Effect.gen(function* () {
          const kept = yield* reliedFor(evidenceDir(dir, runId), run, spec, hostStarted);
          if (kept !== null)
            yield* appendLog(
              runDir(dir, runId),
              `${recorded.pass}: ${spec.name} relies on verification ${kept.id}`,
            ).pipe(Effect.orDie);
          return kept;
        });
      /** Runs one approved command for a Run, under the pass it was asked for (ADR-0042). */
      const check = (asked: Parameters<Sdk.HostApi["verify"]>[0], recorded: CheckPass) =>
        under(
          Effect.gen(function* () {
            const approved = yield* approvedOf(dir, asked.runId);
            const spec = approved.find((entry) => entry.name === asked.name);
            if (spec === undefined) {
              return yield* new WorkflowError({
                reason: `"${asked.name}" is not among this Run's checks`,
              });
            }
            // The workflow's checkout has to be the Run's own; the grant's directory is resolved from it.
            const own = yield* treeOf(yield* store.run(asked.runId), asked.runId, dir);
            if (!(yield* insideRun(asked.cwd, own))) {
              return yield* new WorkflowError({
                reason: `"${asked.cwd}" is not inside run ${asked.runId}`,
              });
            }
            const journal = evidenceDir(dir, asked.runId);
            const marker = `${runDir(dir, asked.runId)}/${VERIFYING_FILE}`;
            const away = `${runDir(dir, asked.runId)}/${AWAY_FILE}`;
            yield* restoreCheckout(asked.cwd, away);
            const rerun =
              asked.pass === "rerun" || asked.at === "default-base" ? asked.test : undefined;
            if (asked.pass === "rerun" && rerun === undefined)
              return yield* new WorkflowError({ reason: "a rerun names the one test it runs" });
            if (asked.at === undefined && asked.expect !== "fail" && rerun === undefined) {
              const kept = yield* relyOn(asked.runId, { ...own, cwd: asked.cwd }, spec, recorded);
              if (kept !== null) return kept;
            }
            const env = yield* currentEnv.pipe(Effect.option);
            if (Option.isSome(env)) {
              const memory = yield* waitForMemory({
                env: { ...env.value, userDir: options.userDir ?? env.value.userDir },
                stateDir: dir,
                runId: asked.runId,
                what: `${recorded.pass}: ${spec.name}`,
                stopped: set(STOP, asked.runId),
              });
              if (memory === "stopped")
                return yield* new WorkflowError({
                  reason: `${spec.name} did not run: the Run was stopped while it waited for memory`,
                });
            }
            // Written once the checkout is where the check runs, so it names that revision.
            const verified = (base: string | null) =>
              Effect.gen(function* () {
                const head = yield* runShell("git", ["rev-parse", "HEAD"], asked.cwd);
                // A test is asked about once per base revision.
                if (base !== null && rerun !== undefined) {
                  const checkDir = yield* checkCwd({ ...own, cwd: asked.cwd }, spec);
                  const known = (yield* readVerifications(journal).pipe(Effect.orDie)).findLast(
                    (v) =>
                      v.pass === "baseline" &&
                      v.name === spec.name &&
                      v.cwd === checkDir &&
                      v.test?.file === rerun.file &&
                      v.test.name === rerun.name &&
                      v.start.head_sha === head.stdout.trim(),
                  );
                  if (known !== undefined) return known;
                }
                const started = yield* nowIso();
                // A file per run of the check, beside the journal its record goes to.
                const log = `${journal}/checks/${started.replace(/[:.]/g, "-")}-${spec.name.replace(/[^\w.-]/g, "_")}.log`;
                yield* fs
                  .writeFileString(
                    marker,
                    encodeVerifying({
                      name: spec.name,
                      executable: rerun === undefined ? spec.executable : "bun",
                      argv: rerun === undefined ? spec.argv : rerunArgv(rerun),
                      pass: recorded.pass,
                      round: recorded.round ?? null,
                      revision: head.code === 0 ? head.stdout.trim() : "",
                      base,
                      started,
                      log,
                    }),
                  )
                  .pipe(Effect.ignore);
                return yield* (
                  rerun === undefined
                    ? runApproved(
                        journal,
                        { ...own, cwd: asked.cwd },
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
                        { pass: asked.at === "default-base" ? "baseline" : "rerun" },
                        log,
                      )
                ).pipe(
                  Effect.tap((record) => noteVerification(journal, record)),
                  Effect.mapError((refused) => new WorkflowError({ reason: refused.why })),
                );
              });
            return yield* (
              asked.at === "default-base"
                ? atDefaultBase(asked.cwd, away, verified)
                : verified(null)
            ).pipe(Effect.ensuring(fs.remove(marker).pipe(Effect.ignore)));
          }),
        );
      const placing = options.placing
        ? Effect.succeed(options.placing)
        : currentEnv.pipe(
            Effect.map((env) => ({ herdr: new Herdr(env), env })),
            Effect.orDie,
          );
      /** The reviewed branch's checkout, found or cut as a build of the review's findings is (ADR-0054). */
      const checkoutReviewed = (runId: string) =>
        Effect.gen(function* () {
          const row = yield* store.run(runId);
          if (row === null) return { refused: `there is no Run ${runId}` };
          const launch = yield* decodeStrings(row.options ?? "{}").pipe(
            Effect.orElseSucceed((): Record<string, string> => ({})),
          );
          const placed = placedOf(row, launch);
          if (placed.worktree !== null) {
            return { cwd: placed.cwd, branch: placed.branch ?? placed.worktree.branch };
          }
          const input = yield* decodeInput(row.input).pipe(
            Effect.orElseSucceed((): Readonly<Record<string, Schema.Json>> => ({})),
          );
          const field = fieldWith(yield* WorkflowHints, "diff-target");
          const target = field === undefined ? undefined : input[field];
          const { herdr, env } = yield* placing;
          const made = yield* Effect.result(
            checkoutFor(herdr, {
              cwd: placed.cwd,
              stateDir: env.stateDir,
              workflow: row.workflow,
              checkout: "branch",
              name: runId,
              // As placement feeds a build of a review's findings: this Run is the review.
              inputs: {
                [REVIEWED]: isText(target) ? target : "",
                work: runDir(dir, runId),
                work_kind: "review",
              },
              strategies: { [REVIEWED]: "diff-target", work: "work-source" },
              login: env.gitlabLogin,
              recordedBy: (at) =>
                store.runs.pipe(
                  Effect.map((rows) => {
                    const one = rows.find((row) => placedOf(row, {}).worktree?.path === at);
                    // A review's fix round never takes over another Run's checkout.
                    return one === undefined
                      ? null
                      : {
                          run: one.run,
                          worktree: placedOf(one, {}).worktree ?? null,
                          release: Effect.succeed("a review's fix round takes over nothing"),
                        };
                  }),
                ),
            }),
          );
          if (made._tag === "Failure") {
            return { refused: `no checkout could be made: ${String(made.failure)}` };
          }
          const checkout = made.success;
          if (checkout.refused !== null) return { refused: checkout.refused };
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
        }).pipe(Effect.provideContext(bun));
      const issueCheckout = Effect.fn("Host.issueCheckout")(function* (runId: string) {
        const row = yield* store.run(runId);
        if (row === null) return yield* new WorkflowError({ reason: `there is no Run ${runId}` });
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
        if (!here.ok) return yield* new WorkflowError({ reason: here.reason });
        return { ...here, cwd, env };
      });
      const issuePrivacyBudget = Duration.fromInputUnsafe(options.issuePrivacyBudget ?? "1 minute");
      const walks = yield* Cache.makeWith(
        (root: string) =>
          Effect.gen(function* () {
            const { herdr } = yield* placing;
            const worktrees = yield* herdr.worktreesDirectory();
            return yield* publicationCheckouts(
              (yield* fs.exists(worktrees)) ? [root, worktrees] : [root],
            );
          }).pipe(Effect.provideContext(bun)),
        { capacity: 4, timeToLive: (exit) => (Exit.isSuccess(exit) ? "2 minutes" : 0) },
      );
      const remotesOf = (checkout: string) =>
        Effect.gen(function* () {
          const remotes = yield* runShell("git", ["remote", "-v"], checkout);
          if (remotes.code !== 0)
            return yield* new WorkflowError({
              reason: `issue privacy check could not read remotes: ${checkout}`,
            });
          return remotes.stdout.split("\n").flatMap((line) => {
            const name = remoteOf(line.split("\t")[1]?.replace(/\s+\((?:fetch|push)\)$/, "") ?? "");
            return name === null ? [] : [name];
          });
        });
      /** Every checkout issue text may not name, with its remotes; the walk under `root` is kept a while. */
      const inventoryOf = (root: string) =>
        Effect.gen(function* () {
          const walked = yield* Cache.get(walks, root);
          const { herdr } = yield* placing;
          const open = yield* herdr.workspaceList().pipe(Effect.orElseSucceed(() => []));
          const known = yield* publicationCheckouts(
            [],
            [
              ...new Set(
                [
                  ...(yield* store.runs).flatMap((row) => {
                    const placed = placedOf(row, {});
                    return [row.project, placed.cwd, placed.worktree?.path ?? ""];
                  }),
                  ...open.flatMap((workspace) => [workspace.cwd, workspace.worktree ?? ""]),
                ].filter((dir) => dir.startsWith("/")),
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
          const common = yield* runShell(
            "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            here.cwd,
          );
          if (common.code !== 0)
            return yield* new WorkflowError({
              reason: "issue checkout's Git identity could not be read",
            });
          const own = yield* fs.realPath(common.stdout.replace(/\n$/, ""));
          const ownRemote = here.project.split("/").slice(1).join("/");
          for (const { checkout, canonical, repository, names } of inventory.checkouts) {
            if (
              !(
                text.includes(checkout) ||
                expanded.includes(canonical) ||
                names.some(
                  (name) =>
                    (name.project !== here.project &&
                      (text.includes(name.project) ||
                        text.includes(name.project.replace("/", ":")))) ||
                    (name.path !== ownRemote && text.includes(name.path)),
                )
              )
            )
              continue;
            if (!repository)
              return yield* new WorkflowError({
                reason: `issue text names another checkout: ${checkout}`,
              });
            const shared = yield* runShell(
              "git",
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              canonical,
            );
            if (shared.code !== 0)
              return yield* new WorkflowError({
                reason: `issue privacy check could not identify checkout: ${checkout}`,
              });
            if ((yield* fs.realPath(shared.stdout.replace(/\n$/, ""))) === own) continue;
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
      /** Awaits, parking once overdue; parks a repair; null clears both. */
      const waitOn = (
        runId: string,
        wait:
          | { readonly on: string; readonly who: string | null }
          | { readonly repair: string }
          | null,
      ) =>
        Effect.gen(function* () {
          const path = controlPath(dir, AWAITING, runId);
          const before = yield* fs
            .readFileString(path)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(AwaitingJson)), Effect.option);
          const parked = yield* fs.exists(controlPath(dir, PARKED, runId));
          if (wait === null) {
            if (Option.isSome(before)) yield* fs.remove(path, { force: true });
            if (parked) yield* host.parked(runId, null);
            else if (Option.isSome(before)) yield* store.announce;
            return;
          }
          if ("repair" in wait) return yield* host.parked(runId, wait.repair);
          const awaiting = {
            on: wait.on,
            who: wait.who,
            since: Option.isSome(before) ? before.value.since : yield* nowIso(),
          };
          const overdue = overdueLine(awaiting, yield* Clock.currentTimeMillis);
          if (
            Option.isNone(before) ||
            before.value.on !== awaiting.on ||
            before.value.who !== awaiting.who
          ) {
            yield* fs.writeFileString(path, Schema.encodeSync(AwaitingJson)(awaiting));
            if (overdue === null && !parked) yield* store.announce;
          }
          if (overdue !== null || parked) yield* host.parked(runId, overdue);
        }).pipe(Effect.orDie);
      /** One read of the review of the merge request a Run recorded, judged. */
      const reviewRead = (asked: {
        readonly runId: string;
        readonly cwd: string;
        readonly proved: string;
        readonly seen: ReadonlyArray<string>;
      }) =>
        Effect.gen(function* () {
          const mr = yield* mergeRequestOf(fs, dir, asked.runId);
          const ref = mr === null ? null : mrRefOf(mr);
          if (mr === null || ref === null)
            return yield* new WorkflowError({
              reason: "this Run has recorded no merge request to read the review of",
            });
          const read = yield* under(forgeOf(ref).readReview(ref, asked.cwd, runShell));
          return { mr, ref, read, standing: standingOf(read, asked) };
        });
      const unrecorded = "this Run recorded no merge request to read deployments of";
      const recordedRef = (runId: string) =>
        Effect.map(mergeRequestOf(fs, dir, runId), (mr) => (mr === null ? null : mrRefOf(mr)));
      const readable = (asked: { readonly runId: string; readonly cwd: string }) =>
        Effect.gen(function* () {
          const { mr, ref, read } = yield* reviewRead({ ...asked, proved: "", seen: [] });
          if (!read.ok)
            return yield* new WorkflowError({ reason: `${mr} could not be read: ${read.reason}` });
          return { mr, ref, read };
        });
      const host = Host.of({
        dir,
        report: () =>
          Effect.fail(
            new WorkflowError({ reason: "Run reporting requires the host's workflow registry" }),
          ),
        issues: (runId) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(runId);
              const listed = yield* here.forge.issues(here.project, here.cwd, runShell);
              if (!listed.ok) return yield* new WorkflowError({ reason: listed.reason });
              return listed.issues;
            }),
          ),
        fileIssue: (asked) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(asked.runId);
              yield* checkIssueText(here, `${asked.title}\n${asked.body}`);
              const filed = yield* here.forge.fileIssue(
                here.project,
                redact(asked.title),
                redact(asked.body),
                here.cwd,
                runShell,
              );
              if (!filed.ok) return yield* new WorkflowError({ reason: filed.reason });
              return { number: filed.number, url: filed.url };
            }),
          ),
        commentIssue: (asked) =>
          under(
            Effect.gen(function* () {
              const here = yield* issueCheckout(asked.runId);
              yield* checkIssueText(here, asked.body);
              const commented = yield* here.forge.commentIssue(
                here.project,
                asked.number,
                redact(asked.body),
                here.cwd,
                runShell,
              );
              if (!commented.ok) return yield* new WorkflowError({ reason: commented.reason });
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
                        Effect.orElseSucceed((): Record<string, string> => ({})),
                        Effect.map((options) => ({
                          options,
                          task: row.task,
                          placed: placedOf(row, options),
                          started: Option.getOrUndefined(decodePlacing(row.placing ?? ""))?.started,
                        })),
                      ),
                ),
                // A Run nobody has a row for works nowhere in particular; its own directory
                // is still its own, so what it writes is not written into somebody else's.
                // Made for a Run there is one, so a workflow writes what it produces into
                // its own directory without first asking whether it is there — and asking
                // about a run that was never started leaves nothing behind.
                Effect.tap((admitted) =>
                  admitted === null
                    ? Effect.void
                    : fs.makeDirectory(runDir(dir, runId), { recursive: true }),
                ),
                Effect.map((admitted) => ({
                  cwd: admitted?.placed.cwd ?? dir,
                  dir: runDir(dir, runId),
                  options: admitted?.options ?? {},
                  task: admitted?.task ?? null,
                  workspace: admitted?.placed.workspace ?? null,
                  authority: authorityOf(admitted?.placed.worktree ?? null, admitted?.started),
                })),
                Effect.orElseSucceed(() => ({
                  cwd: dir,
                  dir: runDir(dir, runId),
                  options: {},
                  task: null,
                  workspace: null,
                  authority: authorityOf(null, undefined),
                })),
              ),
              lineageOf(runId),
              (at, lineage) => ({ ...at, lineage }),
            ),
          ),
        checkoutReviewed,
        held: (runId) => set(HOLD, runId),
        stopRequested: (runId) => set(STOP, runId),
        record: (runId, event) =>
          // A replay writes its records again, as it re-enters every step: the log is what
          // the Run did each time it ran, not a deduplicated story.
          appendLog(runDir(dir, runId), event).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.orDie,
          ),
        parked: (runId, why) => {
          const path = controlPath(dir, PARKED, runId);
          return (
            why === null
              ? fs.remove(path, { force: true }).pipe(Effect.orDie)
              : Effect.gen(function* () {
                  const before = yield* fs.readFileString(path).pipe(Effect.option);
                  yield* fs.writeFileString(path, why).pipe(Effect.orDie);
                  if (Option.getOrNull(before) === why) return;
                  yield* under(
                    Effect.gen(function* () {
                      yield* appendMetric(evidenceDir(dir, runId), {
                        at: yield* nowIso(),
                        kind: "halt",
                        subject: "",
                        value: 0,
                        note: why,
                      });
                    }),
                  );
                  yield* notify(runId, "needs-you", why, { key: `parked:${why}` });
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
            return rows.map((row) => {
              const actor =
                row.answerer ??
                audit.find((line) => line.operation === "answer" && line.request === row.request)
                  ?.actor;
              if (actor === undefined) return { name: row.decision, answer: row.answer };
              const { requestId: _, schedule: __, ...by } = actor;
              return { name: row.decision, answer: row.answer, by };
            });
          }),
        close: (runId, decision, value) =>
          store
            .settle({ run: runId, decision, value, request: `${runId}-${decision}-closed` })
            .pipe(Effect.asVoid),
        evidence: (runId, cwd) =>
          under(
            Effect.gen(function* () {
              const own = yield* treeOf(yield* store.run(runId), runId, dir);
              return yield* Effect.all({
                verifications: readVerifications(evidenceDir(dir, runId)).pipe(
                  Effect.orElseSucceed((): ReadonlyArray<Verification> => []),
                ),
                final: fingerprint(cwd),
                commands: Effect.forEach(yield* approvedOf(dir, runId), (spec) =>
                  commandOf({ ...own, cwd }, spec),
                ),
              });
            }),
          ).pipe(Effect.orDie),
        verify: (asked) => check(asked, passAsked(asked)),
        approved: (runId) => under(approvedOf(dir, runId)),
        config: (dotted) =>
          under(
            readConfig(options.userDir ?? dir).pipe(
              Effect.map((raw) => {
                const value = configValue(raw, dotted);
                return Schema.is(Schema.String)(value) ? value : "";
              }),
              Effect.orElseSucceed(() => ""),
            ),
          ),
        mr: (asked) =>
          under(
            Effect.gen(function* () {
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
                  gitlabHost: (yield* loadDefaults(options.userDir ?? dir)).gitlabHost,
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
              const spec = (yield* approvedOf(dir, asked.runId)).find(
                (one) => one.name === asked.name,
              );
              if (spec?.ci === undefined)
                return {
                  unproved: `"${asked.name}" is not one of this Run's checks left to CI`,
                  state: null,
                  url: null,
                  log: null,
                };
              const own = yield* treeOf(yield* store.run(asked.runId), asked.runId, dir);
              // A stop ends the wait: the workflow suspends on it, as it does on an agent's.
              const stopped = set(STOP, asked.runId).pipe(
                Effect.repeat({ until: (stop) => stop, schedule: Schedule.spaced("1 second") }),
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
                  mr: yield* mergeRequestOf(fs, dir, asked.runId),
                  wait: asked.wait ?? false,
                  settle: asked.settle ?? false,
                  run: runShell,
                }),
                stopped,
              );
            }),
          ).pipe(Effect.orDie),
        note: (asked) =>
          under(
            Effect.gen(function* () {
              const ref = mrRefOf(yield* mergeRequestOf(fs, dir, asked.runId));
              if (ref === null) return { ok: false, message: "this Run has no merge request" };
              return yield* forgeOf(ref).post(ref, asked.body, false, asked.cwd, runShell);
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
        }): Effect.Effect<Sdk.Claimed, WorkflowError | E, R> =>
          Effect.gen(function* () {
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
                      runs: (yield* store.runs).map((row) => row.run),
                      stop: (runId) =>
                        Option.isSome(executions)
                          ? executions.value.stop(runId)
                          : Effect.succeed({ runs: [runId], left: ["nothing here can stop it"] }),
                      halt: (runId) =>
                        Option.isSome(agents)
                          ? agents.value.halt(runId)
                          : Effect.succeed({ stopped: [], left: ["nothing here can close them"] }),
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
                          ...before.filter((one) => one.slug !== claim.slug),
                          claim,
                        ]),
                      ),
                      Effect.orDie,
                    );
                }),
              forget: (slug) =>
                updateClaims(file, (before) => before.filter((one) => one.slug !== slug)).pipe(
                  Effect.orDie,
                ),
              out: asked.say,
              // The question is the workflow's, so it is durable and asked once; this only
              // turns the answer into the word the gate reads.
              ask: () => asked.adopting.pipe(Effect.map((yes) => (yes ? "yes" : null))),
              queued: (slug, position) =>
                waitOn(asked.runId, {
                  on: `its turn for the Helle claim on ${slug}, at ${position} in its queue`,
                  who: "whoever holds it",
                }),
              ended: () => waitOn(asked.runId, null),
            });
            if (held._tag === "Unresolved") return { unresolved: held.why };
            return held.left === undefined
              ? { slugs: held.slugs }
              : { slugs: held.slugs, left: held.left };
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideContext(services),
            // Helle refusing to answer is this Run being unable to take the claim; the
            // author's own failures pass through untouched.
            Effect.mapError((cause: HelleError | E) =>
              cause instanceof HelleError ? new WorkflowError({ reason: cause.message }) : cause,
            ),
          ),
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
            if (held.length === 0) return [];
            const creds = yield* credentials({
              home: env.home,
              envFile: env.raw.HELLE_ENV_FILE ?? null,
              url: helleUrlOf(env.raw),
            });
            // One Helle refuses to give back stays recorded, for a later release to retry.
            const given = new Set<string>();
            for (const one of held) {
              const released = yield* releaseClaim(creds, one.slug).pipe(
                Effect.provide(FetchHttpClient.layer),
                Effect.result,
              );
              if (released._tag === "Success") given.add(one.slug);
            }
            yield* updateClaims(file, (now) => now.filter((one) => !given.has(one.slug)));
            return held.filter((one) => !given.has(one.slug)).map((one) => one.slug);
          }).pipe(
            Effect.provideContext(services),
            // Helle not asked at all gave nothing back.
            Effect.catch(() =>
              recordedClaims(claimPath(dir, runId)).pipe(
                Effect.map((held) => held.map((one) => one.slug)),
                Effect.provideContext(services),
              ),
            ),
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
              const sha = said.code === 0 ? (said.stdout.trim().split(/\s/)[0] ?? "") : "";
              return sha === ""
                ? Effect.fail(
                    new WorkflowError({
                      reason: `origin's default branch could not be read from ${cwd}: ${(said.stderr ?? "").trim()}`,
                    }),
                  )
                : Effect.succeed(sha);
            }),
          ),
        merge: (asked) =>
          Effect.gen(function* () {
            return yield* land({
              runDir: runDir(dir, asked.runId),
              mr: yield* mergeRequestOf(fs, dir, asked.runId),
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
            const controlled = Effect.gen(function* () {
              while (!((yield* set(HOLD, asked.runId)) || (yield* set(STOP, asked.runId))))
                yield* Effect.sleep("1 second");
              return { _tag: "Held" } satisfies ReviewStanding;
            });
            const polled = Effect.gen(function* () {
              for (;;) {
                const { mr, read, standing } = yield* reviewRead(asked);
                if (standing._tag !== "Waiting" && standing._tag !== "Unreadable") return standing;
                const wait = reviewWaitOf(mr, read);
                yield* waitOn(
                  asked.runId,
                  wait._tag === "Awaiting" ? wait : { repair: blockedLine(mr, wait.why) },
                );
                yield* Effect.sleep(options.reviewPoll ?? "5 minutes");
              }
            });
            const standing = yield* Effect.raceFirst(controlled, polled);
            yield* waitOn(asked.runId, null);
            return standing;
          }),
        reply: (asked) =>
          Effect.gen(function* () {
            const { mr, ref, read } = yield* readable(asked);
            const comment = read.comments.find((one) => one.id === asked.comment);
            if (comment === undefined)
              return yield* new WorkflowError({
                reason: `${mr} has no comment ${asked.comment} to reply to`,
              });
            if (comment.answered) return "already" as const;
            const replied = yield* under(
              forgeOf(ref).reply(ref, comment, redact(asked.body), asked.cwd, runShell),
            );
            if (!replied.ok)
              return yield* new WorkflowError({
                reason: `the forge refused the reply to ${comment.url}: ${replied.reason}`,
              });
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
              open: read.comments
                .filter((one) => one.external && !one.answered)
                .map((one) => one.id),
            };
          }),
        fastForward: (asked) =>
          under(
            fastForward({
              runDir: runDir(dir, asked.runId),
              cwd: asked.cwd,
              head: asked.head,
              run: runShell,
            }),
          ).pipe(Effect.orDie),
        readTag: (asked) =>
          Effect.gen(function* () {
            return yield* under(
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
          }),
        readProduction: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            if (ref === null) return { _tag: "Unproved", why: unrecorded } satisfies ProductionRead;
            return yield* under(readProduction({ ...asked, ref, run: runShell }));
          }),
        readStage: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            if (ref === null) return { _tag: "Failed", why: unrecorded } satisfies StageRead;
            return yield* under(readStage({ ...asked, ref, run: runShell }));
          }),
        readRollback: (asked) =>
          Effect.gen(function* () {
            const ref = yield* recordedRef(asked.runId);
            if (ref === null) return { _tag: "Unshown", why: unrecorded } satisfies RollbackRead;
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
            const short = asked.sha.slice(0, 8);
            const plays = asked.jobs.map((job) => `\`${job.name}\` at ${job.url ?? asked.url}`);
            const held = asked.slug === undefined ? null : `The claim on \`${asked.slug}\` is held`;
            const awaited =
              plays.length > 0 && asked.played !== true
                ? null
                : waitOn(asked.runId, {
                    on: `production to carry \`${short}\` of ${asked.url}${plays.length === 0 ? "" : `, from ${plays.join(", ")}`}${asked.slug === undefined ? "" : `, holding the claim on \`${asked.slug}\``}`,
                    who: null,
                  });
            yield* (
              awaited ??
                host.parked(
                  asked.runId,
                  `Waiting for production: play ${plays.join(", ")}. ${held ?? "The Run waits"} until the forge shows production carries \`${short}\`.`,
                )
            );
            const { gitlabHost } = yield* loadDefaults(options.userDir ?? dir).pipe(
              Effect.orElseSucceed(() => ({ gitlabHost: undefined })),
            );
            const controlled = Effect.gen(function* () {
              while (!((yield* set(HOLD, asked.runId)) || (yield* set(STOP, asked.runId))))
                yield* Effect.sleep("1 second");
              return false;
            });
            const carried = Effect.gen(function* () {
              while (!(yield* productionCarries(asked.cwd, asked.sha, runShell, gitlabHost))) {
                if (awaited !== null) yield* awaited;
                yield* Effect.sleep(options.productionPoll ?? "5 minutes");
              }
              return true;
            });
            const carries = yield* Effect.raceFirst(controlled, carried);
            yield* waitOn(asked.runId, null);
            return carries;
          }).pipe(Effect.provideContext(services)),
        mergeRequest: (runId, url) =>
          fs.makeDirectory(runDir(dir, runId), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(mergeRequestPath(dir, runId), `${url}\n`)),
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
          under(
            fs.readFileString(asked.file).pipe(
              Effect.flatMap((body) =>
                Effect.flatMap(loadDefaults(options.userDir ?? dir), (defaults) =>
                  postNote(
                    {
                      target: asked.target,
                      cwd: asked.cwd,
                      body,
                      approve: asked.approve === true,
                      gitlabHost: defaults.gitlabHost,
                    },
                    runShell,
                  ),
                ),
              ),
              Effect.orElseSucceed(() => ({
                ok: false,
                message: `there is no ${asked.file} to post`,
              })),
            ),
          ),
      });
      let herdSocket = options.herd?.socketPath ?? null;
      let locatedAt = Number.NEGATIVE_INFINITY;
      /** The host's Herd: its own socket, else herdr's, asked again each minute until it answers. */
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
      /** A Run as a card sees it: where it works, and where its records are. */
      const watched = (runId: string): Effect.Effect<Watched> =>
        Effect.gen(function* () {
          const row = yield* store.run(runId);
          const task =
            row?.task == null
              ? null
              : yield* readTask(dir, row.task).pipe(
                  Effect.provideContext(bun),
                  Effect.orElseSucceed(() => null),
                );
          const placed =
            row === null
              ? null
              : placedOf(
                  row,
                  yield* decodeStrings(row.options ?? "{}").pipe(
                    Effect.orElseSucceed((): Record<string, string> => ({})),
                  ),
                );
          const worktree = placed?.worktree?.path ?? null;
          return {
            runId,
            stateDir: dir,
            runDir: runDir(dir, runId),
            evidenceDir: evidenceDir(dir, runId),
            agentsDir: `${dir}/agents/${runId}`,
            cwd: worktree ?? placed?.cwd ?? dir,
            worktree,
            mr: yield* mergeRequestOf(fs, dir, runId),
            asking: (yield* store.asked(runId)).some((one) => one.answer === null),
            held: yield* set(HOLD, runId),
            family: row === null ? [runId] : familyOf(yield* store.runs, row),
            dirOf: (id: string) => runDir(dir, id),
            herd: task?.herd ?? (yield* hostHerd),
          };
        });
      /** A card that is something a human could go and try is worth telling them about. */
      const told = (runId: string, cards: ReadonlyArray<Card>) =>
        Effect.forEach(cards, (card) =>
          card.significance === "try-it"
            ? notify(runId, "slice-ready", card.readiness, { key: card.id })
            : Effect.void,
        );
      /** What judging a Run's drift takes, or null where there is no Herd to charge it to. */
      const judging = (at: Watched) =>
        Effect.gen(function* () {
          if (options.herd === undefined || at.herd === null) return null;
          const built = yield* evaluationDeps({ ...options.herd, herdKey: at.herd });
          return {
            evaluator: built.evaluator,
            budgetFile: yield* budgetPath(dir, built.herdKey),
            limits: built.limits,
            newId: Crypto.Crypto.pipe(
              Effect.flatMap((one) => one.randomUUIDv4),
              Effect.orDie,
            ),
            log: (line: string) => said(at, line).pipe(Effect.provideContext(services)),
          } satisfies JudgementDeps;
        }).pipe(Effect.orElseSucceed(() => null));
      const drift: Oversight["Service"]["drift"] = (runId, where, judged) =>
        Effect.gen(function* () {
          const at = yield* watched(runId);
          const deps =
            judged === "none" ? null : yield* judging(at).pipe(Effect.provideContext(bun));
          // Corrected through the caller's own agents: the work that drifted is theirs.
          // Not at the finish, where there is no next piece of work to bring back.
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
          // The Herd's cross-run check, stood for at every boundary; at the finish the Run
          // stands as it leaves, which is what writes an unanswered check down as owed.
          if (judged !== "none")
            yield* standForElection(at, where, judged === "finish", deps).pipe(
              Effect.provideContext(bun),
            );
          for (const constraint of done.sent)
            yield* notify(runId, "correction-sent", constraint, {
              key: `correction:${constraint}`,
              subject: constraint,
            });
          for (const constraint of done.escalated)
            yield* notify(runId, "drift-unresolved", constraint, {
              key: `escalated:${constraint}`,
              subject: constraint,
            });
        }).pipe(Effect.ignore);
      const oversight = Oversight.of({
        card: (runId, what) =>
          watched(runId).pipe(
            Effect.flatMap((at) => under(writeCard(at, what))),
            Effect.flatMap((card) => told(runId, [card])),
            Effect.ignore,
          ),
        checkpoints: (runId, step) =>
          watched(runId).pipe(
            Effect.flatMap((at) => under(cardCheckpoints(at, step))),
            Effect.flatMap((cards) => told(runId, cards)),
            Effect.ignore,
          ),
        drift,
        finish: (runId) =>
          Effect.gen(function* () {
            const at = yield* watched(runId);
            // Bounded: an approved command that hangs would hold the Run's ending for ever.
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
            if (proposed !== null)
              yield* notify(runId, "proposal-pending", `a follow-up for what is still blocking`, {
                key: proposed,
              });
            const card = yield* under(
              writeCard(settled, { kind: "final", step: "finish", claims: [] }),
            );
            yield* told(runId, [card]);
            // Once, here: the finish is the only moment at which nobody is left to make an
            // owed cross-run check, which is what makes it something a human has to know.
            if (card.cross_run === "pending")
              yield* notify(runId, "drift-unresolved", "cross_run_pending", { key: "cross_run" });
          }).pipe(Effect.ignore),
      });
      const relied: Reliance["Service"]["relied"] = (runId, command) =>
        under(
          Effect.gen(function* () {
            const own = yield* treeOf(yield* store.run(runId), runId, dir);
            const executable = yield* resolveExecutable(command.executable, command.cwd);
            if (executable === null) return null;
            for (const spec of yield* approvedOf(dir, runId)) {
              if (!ranCommand({ ...command, executable }, yield* commandOf(own, spec))) continue;
              const record = yield* recordFor(evidenceDir(dir, runId), own, spec, hostStarted);
              if (record !== null)
                yield* appendLog(
                  runDir(dir, runId),
                  `check: ${spec.name} answered by verification ${record.id}`,
                ).pipe(Effect.orDie);
              return { check: spec.name, record };
            }
            return null;
          }),
        ).pipe(Effect.orElseSucceed(() => null));
      return Context.make(Host, host).pipe(
        Context.add(Notifier, Notifier.of({ notify })),
        Context.add(Oversight, oversight),
        Context.add(Reliance, Reliance.of({ relied })),
      );
    }),
  );

/**
 * A Run and every Run the cross-run question relates it to: its children, its parent, and
 * that parent's other children.
 */
const familyOf = (rows: ReadonlyArray<RunRow>, row: RunRow): ReadonlyArray<string> => {
  const related = new Set([row.run]);
  for (const one of rows) {
    if (one.parent === row.run) related.add(one.run);
    if (row.parent !== null && (one.run === row.parent || one.parent === row.parent))
      related.add(one.run);
  }
  return [...related];
};

/** Where a toast is raised: herdr's, in a host. */
export type Toast = (title: string, body: string, sound: Sound) => Effect.Effect<void>;

/** The Herd a host works for: whose budget a judgement is charged to, and whose prompts it reads. */
export interface Herd {
  readonly socketPath: string | null;
  readonly pluginRoot: string;
  /** Where herdr's server listens, asked while `socketPath` is null. */
  readonly locate?: Effect.Effect<string | null, never, BunServices>;
}

/** Which toasts a Run has raised, so a replay or a second host does not raise them again. */
const notifiedPath = (dir: string, runId: string) => `${dir}/notified.${runId}`;

/**
 * The next generation of an entry: opaque, distinct, and never a name already used. A
 * workflow's registration name is the tag its executions are stored under, so a run
 * recovers only if the next host registers the module under the name that run started on.
 * Loading the same file again mints the next name rather than replacing the old one.
 *
 * The public workflow id, this registration name and a run id stay three different things;
 * only the first is what an operator types.
 */
export const nextRegistrationName = (
  known: ReadonlyArray<{ readonly workflow: string }>,
  id: string,
): string => `${id}@${known.filter((entry) => entry.workflow === id).length + 1}`;

/** The exit a decision is answered with, encoded by the decision's own schema. */
export const answerDecision = (
  registration: Registration,
  options: { readonly name: string; readonly executionId: string; readonly value: string },
): Effect.Effect<void, never, WorkflowEngine.WorkflowEngine> => {
  // A question is its name: one asked as the work reached it is found by that alone.
  const decision = DurableDeferred.make(options.name, { success: Schema.String });
  const token = DurableDeferred.tokenFromExecutionId(decision, {
    workflow: registration.workflow,
    executionId: options.executionId,
  });
  return DurableDeferred.done(decision, { token, exit: Exit.succeed(options.value) });
};

/**
 * What a poll says about a run. A failure carries the module it happened in, because a
 * service the author never provided is invisible until the body asks for it, and the
 * sentence a human needs names the file to open.
 */
export const RunStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "suspended"]) }),
  /** The result as the workflow's own success schema encodes it. */
  Schema.Struct({ status: Schema.Literal("complete"), value: Schema.Json }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.String,
    entry: Schema.String,
    /** A failure of the workflow's own, as its error schema encodes it. */
    error: Schema.optionalKey(Schema.Json),
  }),
]);

export const pollStatus = (
  result: Option.Option<Workflow.Result<unknown, unknown>>,
  entry: string,
  success?: Schema.Codec<unknown, unknown, never, never>,
  error?: Schema.Codec<unknown, unknown, never, never>,
): typeof RunStatus.Type => {
  if (Option.isNone(result)) return { status: "pending" };
  const value = result.value;
  if (value._tag === "Suspended") return { status: "suspended" };
  return exitStatus(value.exit, entry, success, error);
};

/** A finished execution as a client reads it. */
const exitStatus = (
  exit: Exit.Exit<unknown, unknown>,
  entry: string,
  success?: Schema.Codec<unknown, unknown, never, never>,
  error?: Schema.Codec<unknown, unknown, never, never>,
): typeof RunStatus.Type => {
  if (Exit.isSuccess(exit)) {
    // Encoded by its own schema, so a client can decode it again; as it is where that fails.
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
  // A failure of the workflow's own is what it says it is, in the words its schema writes.
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

/**
 * Why a run failed, in one sentence. A workflow that reported its own failure said it in
 * `reason`, and that is what an operator is owed — a child refusing input names the field
 * there. Anything else is a defect, where the first line is the sentence: a service a
 * module never provided reads as "Service not found: <its key>".
 */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && isWorkflowError(failure.value)) return failure.value.reason;
  const [reason = ""] = Cause.pretty(cause).split("\n");
  return reason;
};

/**
 * What this Run was pointed at, from whichever field carries the diff-target inference.
 * The field's own name is the author's, so a module that calls it `change` is read the
 * same as one that calls it `target`.
 */
const pointedAt = (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
): string | null => {
  const field = Object.entries(generation.hints).find(([, hint]) => hint === "diff-target")?.[0];
  const value = field === undefined ? undefined : input[field];
  return isText(value) && value !== "" ? value : null;
};

const isText = Schema.is(Schema.String);

/** A merge request as the forge names it, or null for anything that names no project's. */
const mrKeyOf = (said: string | null) => {
  const ref = mrRefOf(said);
  return ref === null || ref.project === null ? null : `${ref.project}!${ref.iid}`;
};

/** The field a module gives this strategy, if it gives it to one. */
const fieldWith = (hints: Readonly<Record<string, InputStrategy>>, strategy: InputStrategy) =>
  Object.entries(hints).find(([, hint]) => hint === strategy)?.[0];

/** Where placement reads a reviewed target the building module has no field for. */
const REVIEWED = "reviewed";

/** The input a run was admitted with, as the row keeps it. */
const decodeInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const decodeStrings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

/**
 * What a caller said, in the two halves a front door keeps apart. `text` is what a human
 * typed — `--input k=v`, an answer to a prompt — and `json` is what already has a type:
 * `--inputs-json`, an action's arguments, a chained run's values.
 */
export interface Given {
  readonly json: Readonly<Record<string, Schema.Json>>;
  readonly text: Readonly<Record<string, string>>;
  /** The names in `text` a front door worked out rather than was told. */
  readonly inferred?: ReadonlyArray<string>;
}

/** Where a settled value came from: already typed, as text a human wrote, or worked out. */
export const GIVEN = "given";
export const TYPED = "typed";
export const INFERRED = "inferred";

/**
 * The author's input, settled against the author's schemas before anything exists.
 *
 * Text is tried as text first and parsed as JSON only where the schema will not take the
 * text, so `--input ref=12` is the string for a string-or-number union and `--input
 * count=12` is the number for a number. A typed value is decoded as it came, which is how
 * `--inputs-json` settles the same tie the other way. A field nobody gave is left out
 * rather than given an empty string, so an optional one stays absent and a required one is
 * the schema's own complaint.
 */
export const settleInput = (
  fields: InputFields,
  given: Given,
): Effect.Effect<Settled, HostRefused> => {
  const undeclared = [...Object.keys(given.json), ...Object.keys(given.text)]
    .filter((name) => !(name in fields))
    .sort();
  if (undeclared.length > 0) {
    const names = undeclared.map((name) => `"${name}"`).join(", ");
    return refusedInput(
      `${names} ${undeclared.length === 1 ? "is not an input" : "are not inputs"}`,
    );
  }
  const input: Record<string, Schema.Json> = {};
  const provenance: Record<string, string> = {};
  for (const [name, field] of Object.entries(fields)) {
    const typed = given.json[name];
    if (typed !== undefined) {
      input[name] = typed;
      provenance[name] = GIVEN;
      continue;
    }
    const text = given.text[name];
    if (text === undefined) continue;
    const settled = asText(field, text);
    if (settled === undefined) {
      return refusedInput(`"${name}" is not ${describe(field)}: ${text}`);
    }
    input[name] = settled.value;
    provenance[name] = given.inferred?.includes(name) ? INFERRED : TYPED;
  }
  return Effect.succeed({ input, provenance });
};

/**
 * The author's values as their own schemas settled them, and where each came from. Held
 * encoded: the payload is decoded from this, and the row keeps the same JSON, so a value
 * is written down exactly as it was admitted.
 */
export interface Settled {
  readonly input: Record<string, Schema.Json>;
  readonly provenance: Record<string, string>;
}

const asParsedJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));
const asJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** One field's value from what a human typed: as text, or as the JSON the text spells. */
const asText = (field: InputField, text: string) => {
  const decode = Schema.decodeUnknownResult(field);
  if (decode(text)._tag === "Success") return { value: text };
  const parsed = asParsedJson(text);
  if (parsed._tag === "Failure") return undefined;
  return decode(parsed.success)._tag === "Success" ? { value: parsed.success } : undefined;
};

/** What a field will take, as short as a refusal can say it. */
const describe = (field: InputField): string => {
  const drawn = jsonSchemaFor(field).document;
  if (!isDrawn(drawn)) return "what this input takes";
  const options = drawn.enum;
  if (Array.isArray(options)) return `one of ${options.map(asWord).join(", ")}`;
  const kind = drawn.type;
  return isWord(kind) ? `a ${kind}` : "what this input takes";
};

const isWord = Schema.is(Schema.String);
const asWord = (value: Schema.Json) => (isWord(value) ? value : asJsonText(value));

const isDrawn = Schema.is(Schema.Record(Schema.String, Schema.Json));

/** A refusal a front door turns into `invalid_input` and exit 2, rather than a failure. */
const refusedInput = (reason: string) =>
  Effect.fail(new HostRefused({ reason: `${REFUSED_INPUT}: ${reason}` }));

/**
 * The host's own launch options, checked against what the module says about itself. An
 * outcome a workflow fixes is not one a caller may ask to be something else: a Run that
 * promised evidence it cannot produce finds out at the gate before its merge request.
 */
const refuseOptions = (
  generation: Generation,
  options: Readonly<Record<string, string>>,
): Effect.Effect<void, HostRefused> => {
  const strange = Object.keys(options).filter((name) => !(name in RESERVED_INPUTS));
  if (strange.length > 0) {
    return refusedInput(
      `no host option is called ${strange.map((name) => `"${name}"`).join(", ")}: ` +
        `the host's own are ${Object.keys(RESERVED_INPUTS).join(", ")}`,
    );
  }
  const asked = options.outcome?.trim();
  if (asked === undefined || asked === "") return Effect.void;
  const fixed = generation.fixedOutcome;
  if (fixed !== null && fixed !== asked) {
    return refusedInput(
      `"${generation.id}" always proves ${fixed}, so it cannot be asked for ${asked}`,
    );
  }
  return Effect.void;
};

/** What a caller asked of the checkout, decoded from the host's own `workspace` option. */
type CheckoutRequest =
  /** What the workflow declares: its own worktree where it declares one, else where it started. */
  | { readonly kind: "declared" }
  /** A herdr worktree workspace of the Run's own. */
  | { readonly kind: "separate" }
  /** The checkout the Run starts from, by its absolute path. */
  | { readonly kind: "existing"; readonly path: string };

const isSeparate = Schema.is(Schema.Literal("new"));

/** The `workspace` option as the typed request it is, refused naming the field where it is not one. */
const checkoutRequest = Effect.fn("Engine.checkoutRequest")(function* (
  generation: Generation,
  asked: Readonly<Record<string, string>>,
  /** The Projects root the front door resolved, which `projects-root` names; null for none. */
  root: string | null,
) {
  const given = asked.workspace?.trim() ?? "";
  if (given === "") return { kind: "declared" } satisfies CheckoutRequest;
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
  if (!path.startsWith("/")) {
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

/** Where a Run works, as the host placed it before the Run existed. */
const Placed = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** A workspace of its own, where it asked for one; null lives in its Task's. */
  workspace: Schema.NullOr(Schema.String),
  /** The worktree it was given, which says who takes it away again. */
  worktree: Schema.NullOr(WorktreeRecordSchema),
});
type Placed = typeof Placed.Type;
const PlacedJson = Schema.fromJsonString(Placed);
const decodePlaced = Schema.decodeUnknownOption(PlacedJson);
const encodePlaced = Schema.encodeSync(PlacedJson);

const CLAIM_STRIPES = 16;
const stripeOf = (key: string) => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % CLAIM_STRIPES;
};

/** A checkout a claimant cut, as its receipt records it. */
const Cut = Schema.Struct({
  placed: Placed,
  opened: Schema.NullOr(Schema.Struct({ id: Schema.String, label: Schema.NullOr(Schema.String) })),
});
type Cut = typeof Cut.Type;

/**
 * What a claimant places a Run from: the checkout it starts in, and a fresh Task's name.
 * `checkout` and `workspace` are null once asked for, and what was made once it answered.
 */
const Placing = Schema.Struct({
  requestedBy: Schema.optional(RequestedBy),
  /** The human door that started it and their words, where one did. */
  started: Schema.optional(StartedSchema),
  branchBase: Schema.optional(Schema.String),
  closes: Schema.optional(Schema.Literal("reported")),
  from: Schema.String,
  taskLabel: Schema.NullOr(Schema.String),
  /** The Projects root the start was given, kept so a re-placement and a child name the same. */
  root: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspace: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkout: Schema.optionalKey(Schema.NullOr(Cut)),
});
type Placing = typeof Placing.Type;
const PlacingJson = Schema.fromJsonString(Placing);
const decodePlacing = Schema.decodeUnknownOption(PlacingJson);
const encodePlacing = Schema.encodeSync(PlacingJson);

/** Whether a Run's report is owed: an agent started it, or its Task closes once it is reported. */
export const owesReport = (row: RunRow) =>
  Option.match(decodePlacing(row.placing ?? ""), {
    onNone: () => false,
    onSome: (placing) => placing.requestedBy !== undefined || placing.closes === "reported",
  });

/** What a Run's agents are told it authorises; a record from before this was kept authorises nothing. */
const authorityOf = (
  worktree: WorktreeRecord | null,
  started: Started | undefined,
): RunAuthority => ({
  created:
    worktree?.created_branch === true && worktree.created_on !== null
      ? { branch: worktree.branch, checkout: worktree.path, origin: worktree.created_on }
      : null,
  roaming: worktree !== null && worktree.branch === "",
  started: started ?? null,
});

/** A row claimed and not placed yet: nothing hands it to the engine until it is. */
const unplaced = (row: RunRow) => row.checkout === null && row.placing !== null;

/** The directories a Run owns: its cwd and its worktree, as its placement recorded them. */
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
            Effect.orElseSucceed((): Record<string, string> => ({})),
          ),
        );
  return { id: runId, cwd: placed?.cwd ?? dir, worktree: placed?.worktree?.path ?? null };
});

/** Where a row works: as placed, or, while it is being placed, as its receipt says so far. */
const workingPlace = (row: RunRow): Placed => {
  if (!unplaced(row)) return placedOf(row, {});
  const receipt = Option.getOrUndefined(decodePlacing(row.placing ?? ""));
  return receipt?.checkout?.placed ?? { ...placedOf(row, {}), cwd: receipt?.from ?? row.project };
};

/** Where a Run works: as the host placed it, or for a row from before that, as it started. */
const placedOf = (row: RunRow, options: Readonly<Record<string, string>>): Placed =>
  Option.getOrElse(decodePlaced(row.checkout ?? ""), () => ({
    cwd: options.workspace?.startsWith("/") ? options.workspace : row.project,
    branch: null,
    workspace: null,
    worktree: null,
  }));

/** A launch as the branch resolver reads one: its text, each work source's kind, and the task. */
const branchInputs = Effect.fn("Engine.branchInputs")(function* (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
  options: Readonly<Record<string, string>>,
) {
  const inputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) if (isText(value)) inputs[name] = value;
  for (const [name, hint] of Object.entries(generation.hints)) {
    const value = inputs[name];
    if (hint !== "work-source" || value === undefined) continue;
    const source = yield* classifyWorkSource(value).pipe(
      Effect.orElseSucceed(() => ({ kind: "text" })),
    );
    inputs[`${name}_kind`] = source.kind;
  }
  if (options.task !== undefined) inputs[TASK_INPUT] = options.task;
  return inputs;
});

/**
 * The plan a Run fans out over: one spanning repositories, where the Run was given no
 * `repo` share of it. Null for every other Run.
 */
const fanOutOf = Effect.fn("Engine.fanOutOf")(function* (
  generation: Generation,
  input: Readonly<Record<string, Schema.Json>>,
  options: Readonly<Record<string, string>>,
  root: string,
) {
  const field = fieldWith(generation.hints, "work-source");
  const value = field === undefined ? undefined : input[field];
  if ((options.repo ?? "") !== "" || !isText(value)) return null;
  const source = yield* classifyWorkSource(value).pipe(Effect.orElseSucceed(() => null));
  if (source?.kind !== "plan-dir") return null;
  const plan = yield* planReposOf(source.value, root).pipe(Effect.orElseSucceed(() => null));
  return plan === null || isSingleRepo(plan) ? null : plan;
});

/**
 * The checks a start is admitted with, settled before anything exists. None is fine: the
 * Run's agent names them (ADR-0055). A checks file that does not read is refused by name,
 * and so is `--verify` for a plan that spans repositories.
 */
const checksOfStart = Effect.fn("Engine.checksOfStart")(function* (o: {
  readonly generation: Generation;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly launch: Readonly<Record<string, string>>;
  readonly from: string;
  readonly project: string;
  readonly verify: ReadonlyArray<VerifySpec> | undefined;
  readonly userDir: string;
}) {
  const readApproved = (cwd: string) =>
    Effect.gen(function* () {
      return yield* approvedFrom({
        cwd,
        userDir: o.userDir,
        project: yield* projectHere(cwd, runShell),
      }).pipe(Effect.catch((cause) => refusedInput(cause.message)));
    });
  const approved = o.verify ?? (yield* readApproved(o.project));
  const fanOut = yield* fanOutOf(o.generation, o.input, o.launch, o.from);
  // Placement refuses a plan it cannot fan out, and says why.
  if (fanOut === null || fanOut.refusal !== null) return approved;
  if (o.verify !== undefined)
    return yield* refusedInput(
      "--verify gives one repository's checks, and this plan spans repositories: each is held to its own .collie/verify.json or remembered checks",
    );
  const path = yield* Path.Path;
  for (const repo of fanOut.repos) yield* readApproved(path.join(o.from, repo.path));
  return approved;
});

/**
 * A new Run's Intent, version 1: the workspace's defaults and what was named at launch
 * from the front door, what its work source asks for, and what it may verify. A Run
 * started from another inherits that one's Intent as it stands. Written once, before the
 * engine has the work; a retry of the same request finds it written.
 */
const seedIntentOf = (options: {
  readonly dir: string;
  readonly row: RunRow;
  readonly generation: Generation;
  readonly seed: IntentSeed | undefined;
  readonly parent: RunRow | null;
}) =>
  writeSeed(options).pipe(
    // Said in the Run's own log: a Run without its Intent still runs, and whoever reads
    // why its drift was never checked is told.
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
  if ((yield* readIntent(at).pipe(Effect.orElseSucceed(() => null))) !== null) return;
  const input = yield* decodeInput(options.row.input).pipe(
    Effect.orElseSucceed((): Readonly<Record<string, Schema.Json>> => ({})),
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

/**
 * What a launch records beside the author's own input: the caller's host options, and the
 * outcome this Run has to prove — the module's own fixed kind, or the one the caller
 * selected. A card reads this and never the workflow's id.
 */
const launchOptions = (generation: Generation, asked: Readonly<Record<string, string>>) =>
  generation.fixedOutcome === null ? asked : { ...asked, outcome: generation.fixedOutcome };

/**
 * A run as a front door shows it: the identities it was admitted under, what it was
 * started with, and what the engine says about it now. The status is a projection read
 * from the engine when asked — never a second record of what the work has done.
 */
/** A question a run has been asked, as a front door shows it. */
export const OpenDecision = Schema.Struct({
  name: Schema.String,
  prompt: Schema.String,
  /** The answers it takes; empty is a question answered in the operator's own words. */
  options: Schema.Array(Schema.String),
  /** What settled it, or null while it is still open. */
  answer: Schema.NullOr(Schema.String),
});
export type OpenDecision = typeof OpenDecision.Type;

/** What became of one delivery to a run's agent. */
export const Steered = Schema.Struct({
  agent: Schema.String,
  /** What could be got out of herdr about it, never "it was accepted for sending". */
  delivered: Schema.Boolean,
  detail: Schema.String,
  /** Not delivered because no incarnation of the agent is alive, rather than refused. */
  gone: Schema.optionalKey(Schema.Boolean),
  /** The Run's Workflow has ended, so a gone agent's request is carried on by a new Run. */
  finished: Schema.optionalKey(Schema.Boolean),
  /** Whether the agent was seen to take it — a turn, its submit hook, Enter on it — and how. */
  observed: Schema.optionalKey(Schema.Boolean),
  how: Schema.optionalKey(Schema.String),
  /** The pane it went to. */
  pane: Schema.optionalKey(Schema.String),
  /** Said to whoever sent it where the words were kept as a file rather than typed. */
  kept: Schema.optionalKey(Schema.String),
  /** The kind of each credential-shaped value taken out before anything was written. */
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const RunView = Schema.Struct({
  requestedBy: Schema.optional(RequestedBy),
  report: Schema.optional(RunReport),
  closes: Schema.optional(Schema.Literal("reported")),
  runId: Schema.String,
  workflow: Schema.String,
  project: Schema.String,
  task: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  registration: Schema.String,
  /** The module file this run was admitted on, recorded so a deleted one is still named. */
  entry: Schema.String,
  input: Schema.Record(Schema.String, Schema.Json),
  /** Where each of those values came from, and the host options it was launched with. */
  provenance: Schema.Record(Schema.String, Schema.String),
  /** Which inference each input carries, as its module declares it now; empty without one. */
  strategies: Schema.Record(Schema.String, Schema.String),
  options: Schema.Record(Schema.String, Schema.String),
  /** Where it works: its own worktree, on `branch`, or the checkout it was started for. */
  cwd: Schema.String,
  branch: Schema.NullOr(Schema.String),
  /** A workspace of its own, where it asked for one; null lives in its Task's. */
  workspace: Schema.NullOr(Schema.String),
  /** The worktree it was given, which says who takes it away again. */
  worktree: Schema.NullOr(WorktreeRecordSchema),
  /**
   * What this Run has to prove, as the module fixed it or the caller selected it. A fact
   * on the Run rather than a reading of its id, so a renamed or user-authored workflow
   * is held to what it declared and to nothing its name suggests.
   */
  outcome: Schema.String,
  /** When this Run was admitted, which is when it began. */
  created: Schema.String,
  status: RunStatus,
  /** Every question this run has been asked, answered or not, oldest first. */
  waiting: Schema.Array(OpenDecision),
  /** The controls an operator has set over it: a hold, a stop, or neither. */
  controls: Schema.Array(Schema.String),
  /** Why the engine could not be asked, or null when it was. */
  diagnostic: Schema.NullOr(Schema.String),
  /** Why the Run parked its own work and what picks it up again, or null. */
  parked: Schema.NullOr(Schema.String),
  /** What it waits for that needs nobody to repair anything, or null. */
  awaiting: Schema.NullOr(AwaitingSchema),
  /** The merge request the Run opened, as its workflow recorded it, or null. */
  mr: Schema.NullOr(Schema.String),
  /** Its landing of that merge request through the host's merge, or null. */
  landing: Schema.NullOr(LandingSchema),
});
export type RunView = typeof RunView.Type;

/** What a run reads as, for comparing one poll with the last. */
const encodeView = Schema.encodeSync(Schema.fromJsonString(RunView));

/**
 * How often a host asks the engine about work it has not finished. One fiber does it for
 * every client, so watching costs the same whether nobody or the whole board is looking.
 */
const SWEEP_INTERVAL = "500 millis";

/** How long a woken run is given to settle before a caller is told it was woken. */
const WAKE_INTERVAL = "250 millis";
const WAKE_TRIES = 8;

const VIEW_CONCURRENCY = 8;

/** What a host is holding, as a caller may see it: live names and unloadable ones. */
export const Registrations = Schema.Struct({
  live: Schema.Array(Schema.String),
  unavailable: Schema.Array(Schema.String),
});

/**
 * One loaded generation of a module: the id an operator types, the opaque name Effect
 * stores its executions under, and the live registration itself.
 */
export interface Generation {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly entry: string;
  /** What the module declares it takes, which is what settles a launch. */
  readonly fields: InputFields;
  /** Which input carries which inference, as the module attached it. */
  readonly hints: Readonly<Record<string, InputStrategy>>;
  /** The outcome this module fixes, so asking it for another is refused. */
  readonly fixedOutcome: string | null;
  /** What it needs of the repository, which is what the host places a Run of it on. */
  readonly checkout: CheckoutKind;
  readonly closes?: "reported";
  /** The file and the revision this was built from: what makes a later start the same code. */
  readonly source: string;
  readonly metadata: Schema.Json;
  /** What a finished Run of this module offers next, with the author's own eligibility. */
  readonly offers: ReadonlyArray<Declared>;
  /** What the workflow prefers for its own agents. */
  readonly agents: WorkflowAgentPreferences | undefined;
  readonly registration: Registration;
}

/** What the registry's own work takes, which is what a host holds already. */
export type HostServices =
  | WorkflowEngine.WorkflowEngine
  | Host
  | Agents
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Which modules a host holds and what it does with them, in front of one state directory.
 * Both hosts run on this, so the rule that a run stays on the generation it started on is
 * decided once rather than twice.
 *
 * Registrations are built in the scope the registry is built in — the host's — so they
 * outlive whichever client asked for one and are finalized when the host goes.
 */
export interface RegistryApi {
  readonly load: (entry: string) => Effect.Effect<Generation, EntryError, HostServices>;
  /**
   * The generation new work goes to: the one already built from this file at this
   * revision, or a new one. An edit is therefore a new generation and an unchanged file is
   * not, without either being asked for.
   */
  readonly use: (options: {
    readonly entry: string;
    readonly revision: string;
  }) => Effect.Effect<Generation, EntryError, HostServices>;
  readonly registrations: Effect.Effect<typeof Registrations.Type>;
  readonly newest: (id: string) => Effect.Effect<Generation, HostRefused>;
  /**
   * The generation a start of this id in this project goes to, through whatever search
   * path the host was built with. A host with none has only what was loaded into it, so
   * this is `newest` there.
   */
  readonly resolve: (options: {
    readonly project: string;
    readonly id: string;
  }) => Effect.Effect<Generation, HostRefused, HostServices>;
  /**
   * Admits work and hands it to the engine. The request id is the claim: the same one
   * twice is the same run, and one whose arguments have changed is refused rather than
   * quietly becoming something else. A caller that already has an identity for the work
   * brings it; otherwise the host mints one.
   */
  readonly start: (
    options: StartOptions,
  ) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
  /** Refuses a start as `start` would, before anything is claimed, and starts nothing. */
  readonly check: (options: StartOptions) => Effect.Effect<void, HostRefused, HostServices>;
  /**
   * Executes a Run admitted with `handsOver` on the caller's own fiber, as a parent
   * executes its child: the Run's end wakes the caller's workflow.
   */
  readonly result: (runId: string) => Effect.Effect<unknown, WorkflowError>;
  readonly status: (
    runId: string,
  ) => Effect.Effect<typeof RunStatus.Type, HostRefused, HostServices>;
  /**
   * Settles the question a run is waiting on. A name the run is not asking, one it has
   * already answered, and a value the question does not take are all refused before
   * anything is completed — so nothing an operator sends twice becomes work twice.
   * A null name means the one open question, which is refused where there is not exactly one.
   */
  readonly answer: (options: {
    readonly runId: string;
    readonly decision: string | null;
    readonly value: string;
    /** The caller's claim on this answer, so the same one arriving twice is one answer. */
    readonly request: string;
    readonly by?: Asker & { readonly schedule?: ScheduledBy | undefined };
  }) => Effect.Effect<typeof Answered.Type, HostRefused, HostServices>;
  /** Sets or clears one durable control over one run, and says whether it reached it. */
  readonly control: (options: {
    readonly runId: string;
    readonly control: string;
    readonly set: boolean;
    /** A stop of this Run without the children it started. */
    readonly alone?: boolean;
    /** Why a stop ends the Run's agents, for its log. */
    readonly reason?: string;
  }) => Effect.Effect<typeof Controlled.Type, HostRefused, HostServices>;
  /**
   * Grants this run one command Collie may run itself, or withdraws the grant of that
   * name where the command is null, and answers with what the run may run now.
   */
  readonly grant: (options: {
    readonly runId: string;
    readonly name: string;
    readonly command: Omit<VerifySpec, "name"> | null;
  }) => Effect.Effect<ReadonlyArray<VerifySpec>, HostRefused, HostServices>;
  /** Says something to the agent this run has, through the one sender. */
  readonly steer: (options: {
    readonly runId: string;
    readonly text: string;
    /** The caller's claim on the delivery, so the same message twice is one message. */
    readonly request: string;
    readonly to?: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: AgentsSdk.DeliveryMode;
    readonly actor?: Asker;
  }) => Effect.Effect<typeof Steered.Type, HostRefused, HostServices>;
  /** Puts every agent's question no step is reading on its Run, and sends back the answers. */
  readonly tendQuestions: Effect.Effect<void, never, HostServices>;
  /** Every question this run has been asked, answered or not, oldest first. */
  readonly waiting: (runId: string) => Effect.Effect<ReadonlyArray<OpenDecision>>;
  /** One run as a front door shows it, or null where nothing was admitted under that id. */
  readonly view: (runId: string) => Effect.Effect<RunView | null>;
  /** Every run this host has rows for, newest last, narrowed to one Task where named. */
  readonly views: (task: string | null) => Effect.Effect<ReadonlyArray<RunView>>;
  /** Records `url` as the merge request `runId` opened, as the MR step does, without its notice. */
  readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
  /**
   * Forgets these Runs' rows, and what the engine keeps of their executions, in one
   * transaction (ADR-0045 D5). Answers with the Runs it forgot; a row the engine never
   * accepted is left.
   */
  readonly retire: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, never, MessageStorage.MessageStorage>;
  /** The same run, again, whenever anything about it changes. */
  readonly watch: (runId: string) => Stream.Stream<RunView | null>;
  /**
   * Rebuilds what this host could not register from the modules as they are now and hands
   * over anything still outstanding. A repaired file is picked up without a restart.
   */
  readonly recover: Effect.Effect<typeof Registrations.Type, never, HostServices>;
  readonly resume: (
    runId: string,
  ) => Effect.Effect<typeof Controlled.Type, HostRefused, HostServices>;
  /**
   * What this Run offers to do next, decided by the module as it is now rather than as it
   * was when the Run started: an author who edits their actions changes what is offered.
   * An offer that cannot be made is listed with the reason rather than left out.
   */
  readonly offers: (
    runId: string,
  ) => Effect.Effect<ReadonlyArray<Offer>, HostRefused, HostServices>;
  /**
   * Carries one out. The offer is looked up again, its eligibility asked again and its
   * arguments decoded again, so one that has gone, stopped being eligible or was given
   * something it will not take starts nothing at all.
   */
  readonly invoke: (options: {
    readonly runId: string;
    readonly offer: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
  }) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
  /** The generation a run is on and the execution it was admitted as. */
  readonly routed: (
    runId: string,
  ) => Effect.Effect<{ readonly generation: Generation; readonly execution: string }, HostRefused>;
}

/** What a start is given. */
export interface StartOptions {
  readonly requestedBy?: RequestedBy;
  /** The human door that started it and their words, where one did. */
  readonly started?: Started;
  readonly branchBase?: string | undefined;
  readonly generation: Generation;
  readonly request: string;
  readonly project: string;
  readonly runId?: string;
  /** What the caller said, in the two halves a front door keeps apart. */
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly text?: Readonly<Record<string, string>>;
  readonly inferred?: ReadonlyArray<string>;
  /** The Projects root the front door resolved, which `workspace=projects-root` names. */
  readonly root?: string | undefined;
  /** The host's own launch options, which never reach the author's payload. */
  readonly options?: Readonly<Record<string, string>>;
  /** What this work belongs to: a Task, and the run it came out of. */
  readonly task?: string | null;
  /** A new Task to open for it, under this label, on the checkout it is given. */
  readonly taskLabel?: string | undefined;
  readonly parent?: string | null;
  /** What the front door knows of the Run's Intent. */
  readonly intent?: IntentSeed;
  /** The approved set given with the start, over the project's and the user's files. */
  readonly verify?: ReadonlyArray<VerifySpec> | undefined;
  /** Paths on this Machine, copied into the Run before its first step. */
  readonly attachments?: ReadonlyArray<string> | undefined;
  /** The caller executes the Run itself with `result`, so the engine is not handed it. */
  readonly handsOver?: boolean;
}

/** What a start records and returns: the run it is, and whether this call is what made it. */
export interface Admitted {
  readonly runId: string;
  readonly registration: string;
  readonly execution: string;
  /** False when the request had already been admitted: a retry, not a second run. */
  readonly fresh: boolean;
}

/**
 * Where a host may be made to die, for the proof that neither window loses work: with the
 * run recorded and the engine not yet told, and with the engine told and the receipt not
 * yet written. Only a test sets one, through the host's `COLLIE_HOST_CRASH_AT`.
 */
export type CrashPoint = "admitted" | "executed" | "answered" | "reported";

/**
 * How a host turns a public workflow id into the module this project should run. It is
 * the host's own search path, passed in rather than reached for: the registry decides
 * which generation a run is on, and where a module was saved is somebody else's question.
 *
 * A parent starting a child asks this too, so a project's override is what its parents'
 * work gets — rather than whichever generation of that id this host loaded last.
 */
export type Locate = (options: {
  readonly project: string;
  readonly id: string;
}) => Effect.Effect<
  { readonly entry: string; readonly revision: string },
  HostRefused,
  FileSystem.FileSystem
>;

/** The registry a host holds, as a service its handlers ask for. */
export class Registry extends Context.Service<Registry, RegistryApi>()("collie/Registry") {}

export interface RegistryOptions {
  readonly crashAt?: CrashPoint;
  readonly locate?: Locate;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly userDir?: string;
  /** The herdr checkouts and Task workspaces are made through; the host's own by default. */
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  /** Whether a child's own Task is named by the namer's model, or by the stand-in. */
  readonly namesTasks?: boolean;
}

export const registryLayer = (
  dir: string,
  options?: RegistryOptions,
): Layer.Layer<
  Registry,
  never,
  HostServices | Store | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner | BunServices
> => Layer.effect(Registry)(makeRegistry(dir, options));

/**
 * One host's foundation: the engine, the rows beside it, and the run's own view of its
 * controls and questions. Composed here so there is one SQLite client and one Store
 * behind all three, rather than a second connection reading what the first wrote.
 */
export const foundationLayer = (options: {
  readonly dir: string;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly userDir?: string;
  /** Where a toast goes; left out, nothing is raised. */
  readonly toast?: Toast;
  /** The Herd this host works for; left out, nothing is judged or charged to one. */
  readonly herd?: Herd;
  /** This Machine's Usage readings; none where left out. */
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  readonly messagePoll?: Duration.Input | undefined;
  /** The herdr a reviewed checkout is made through; the host's own by default. */
  readonly placing?: { readonly herdr: Herdr; readonly env: PluginEnv };
  readonly productionPoll?: Duration.Input;
  readonly issuePrivacyBudget?: Duration.Input;
  readonly reviewPoll?: Duration.Input;
}): Layer.Layer<
  | Host
  | Notifier
  | Oversight
  | Reliance
  | Store
  | WorkflowEngine.WorkflowEngine
  | MessageStorage.MessageStorage
  | SqlClient.SqlClient
  | Reactivity.Reactivity,
  ConfigError,
  BunServices
> =>
  hostLayer(options).pipe(
    Layer.provideMerge(storeLayer.pipe(Layer.provideMerge(engineLayer(options)))),
  );

const makeRegistry: (
  dir: string,
  options?: RegistryOptions,
) => Effect.Effect<
  RegistryApi,
  never,
  | HostServices
  | Store
  | Crypto.Crypto
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | BunServices
> = Effect.fn("Engine.makeRegistry")(function* (dir: string, options?: RegistryOptions) {
  const crashAt = options?.crashAt;
  const locate = options?.locate;
  const userDir = options?.userDir ?? dir;
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const fs = yield* FileSystem.FileSystem;
  const store = yield* Store;
  const crypto = yield* Crypto.Crypto;
  const hostScope = yield* Effect.scope;
  const placing =
    options?.placing ??
    (yield* currentEnv.pipe(
      Effect.map((env) => ({ herdr: new Herdr(env), env })),
      Effect.orDie,
    ));
  // Captured, so placing a Run asks git and herdr without its callers providing either.
  const bun = yield* Effect.context<BunServices | Crypto.Crypto>();

  /**
   * Every `diff-target` as `mr:`, `branch:` or `worktree`, since every reader decides from
   * that shape; any other is refused here, before anything exists.
   */
  const settleTargets = Effect.fn("Engine.settleTargets")(function* (
    generation: Generation,
    settled: Settled,
    cwd: string,
  ) {
    const field = fieldWith(generation.hints, "diff-target");
    const value = field === undefined ? undefined : settled.input[field];
    if (field === undefined || !isText(value) || value.trim() === "") return settled;
    const target = yield* classifyGivenTarget(value, { cwd }).pipe(Effect.provideContext(bun));
    if (target === null) {
      return yield* refusedInput(
        `"${field}" is not a merge request, a branch diff or the working tree: ${value}`,
      );
    }
    return { ...settled, input: { ...settled.input, [field]: target.value } };
  });
  /** Every generation this host is holding, by its registration name. */
  const live = new Map<string, Generation>();
  /** Why a recorded generation is not holdable, so a caller hears the file, not a timeout. */
  const unavailable = new Map<string, string>();
  /** Which generation of an id new work goes to. */
  const newestOf = new Map<string, string>();
  let known = yield* store.generations;
  // Staged copies last only as long as this host: every generation below is staged from
  // the module as it is now, never restored.
  yield* clearGenerations(dir);
  const waking = yield* Semaphore.make(1);
  const clearParked = (runId: string) =>
    fs
      .remove(controlPath(dir, PARKED, runId), { force: true })
      .pipe(Effect.orDie, Effect.andThen(store.announce));

  const restoreParked = (runId: string, old: Option.Option<string>) =>
    Effect.gen(function* () {
      if (
        Option.isSome(old) &&
        !(yield* fs.exists(controlPath(dir, PARKED, runId)).pipe(Effect.orDie))
      ) {
        yield* fs.writeFileString(controlPath(dir, PARKED, runId), old.value).pipe(Effect.orDie);
        yield* store.announce;
      }
    });

  const register = Effect.fn("Engine.register")(function* (
    route: {
      readonly workflow: string;
      readonly name: string;
      readonly entry: string;
    },
    recovered?: Set<string>,
  ) {
    const entry = yield* stageGeneration({ dir, name: route.name, entry: route.entry }).pipe(
      Effect.flatMap(loadEntry),
    );
    const registration = entry.make(route.name);
    const pending: Array<{ row: RunRow; parked: Option.Option<string> }> = [];
    if (recovered !== undefined) {
      for (const row of yield* store.runs) {
        if (row.generation !== route.name || unplaced(row)) continue;
        if (Option.isNone(yield* payloadOf(registration, row).pipe(Effect.option))) continue;
        const status = pollStatus(
          yield* engine.poll(registration.workflow, row.execution),
          route.entry,
        ).status;
        if (status === "pending") {
          pending.push({
            row,
            parked: yield* fs.readFileString(controlPath(dir, PARKED, row.run)).pipe(Effect.option),
          });
          yield* clearParked(row.run);
        }
      }
    }
    // The composition root, and the only place a host binds anything into a module's
    // own Layer: explicitly provided to this generation, never a table something looks
    // itself up in. Everything else the module needs it provides for itself.
    yield* Layer.buildWithScope(
      registration.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Children)(children),
            Layer.succeed(Executions)(executions),
            Layer.succeed(Host)(
              Host.of({
                ...Context.get(hostServices, Host),
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
        Effect.forEach(pending, ({ row, parked }) =>
          (entriesOf.get(registration.workflow)?.get(row.run) ?? 0) > 0
            ? Effect.void
            : restoreParked(row.run, parked),
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
      checkout: entry.metadata?.checkout ?? "none",
      source: yield* sourceOf(route.entry),
      metadata: describeMetadata(entry.metadata),
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
      if (accepted || (entriesOf.get(registration.workflow)?.get(row.run) ?? 0) > 0)
        recovered?.add(row.run);
      else yield* restoreParked(row.run, parked);
    }
    return generation;
  });

  /**
   * The host's own services, under whatever the caller already has. A child is executed
   * on the parent's fiber, and merging this way is what leaves the parent's workflow
   * instance and scope in place — which is the whole linkage between the two.
   */
  const hostServices = yield* Effect.context<HostServices>();
  const reportsReady = yield* Deferred.make<void>();
  /** Every other Run's landing and how it ended, weighed by `takeOver`. */
  const landingTakeover = Effect.fn("Host.takeOverLanding")(function* (asked: {
    readonly runId: string;
    readonly cwd: string;
  }) {
    const rows = (yield* store.runs).filter((row) => row.run !== asked.runId);
    const runs = (yield* Effect.forEach(rows, viewOf)).map((view) => ({
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
      mr: yield* mergeRequestOf(fs, dir, asked.runId),
      runs,
      cwd: asked.cwd,
      run: runShell,
    }).pipe(
      Effect.catchTag("PlatformError", (cause) => Effect.die(cause)),
      Effect.provideContext(bun),
    );
  });
  const machineReport = Effect.fn("Host.report")(function* (since: string) {
    yield* Deferred.await(reportsReady);
    const from = epochMs(since);
    if (!Number.isFinite(from))
      return yield* new WorkflowError({ reason: `since is not a date: ${since}` });
    const rows = (yield* store.runs).filter((row) => epochMs(row.admitted) >= from);
    const views = yield* Effect.forEach(rows, viewOf);
    const metrics = new Map<string, Metrics>();
    const recorded = new Map<string, Recorded>();
    for (const view of views) {
      const lines = yield* readMetrics(evidenceDir(dir, view.runId)).pipe(
        Effect.provideContext(bun),
      );
      const records = yield* outcomeRecordsOf(dir, view.runId).pipe(
        Effect.orElseSucceed((): OutcomeRecords | null => null),
        Effect.provideContext(bun),
      );
      metrics.set(view.runId, metricsOf(lines, view.created));
      recorded.set(view.runId, { records, metrics: lines });
    }
    return reportOf(views, metrics, since, recorded);
  });
  const lending = <A, E>(effect: Effect.Effect<A, E, HostServices>): Effect.Effect<A, E> =>
    Effect.updateContext(effect, (caller: Context.Context<never>) =>
      Context.merge(hostServices, caller),
    );

  /** A child's run id: its parent's, and what the parent called this invocation. */
  const childRunId = (ask: ChildAsk & { readonly runId: string }) =>
    `${ask.runId}.${ask.invocation}`;

  /**
   * A Run's own harness, model and effort, checked the way its agents will be given them:
   * over the operator's configuration and under what the workflow prefers.
   */
  const refuseAgent = Effect.fn("Engine.refuseAgent")(function* (
    generation: Generation,
    options: Readonly<Record<string, string>>,
  ) {
    const asked = preferencesIn(options);
    if (Object.keys(asked).length === 0) return;
    const defaults = yield* loadDefaults(userDir).pipe(
      Effect.orElseSucceed(() => FALLBACK_DEFAULTS),
    );
    const configured = {
      harness: defaults.harness,
      model: defaults.model,
      effort: defaults.effort,
    };
    const resolved = resolveChoice([configured, generation.agents, asked], defaults.models);
    if (!resolved.ok) return yield* refusedInput(resolved.problem);
  });

  const refused = (reason: string) => new WorkflowError({ reason });

  /** What the review Run whose directory this is was pointed at, or null. */
  const reviewedTarget = Effect.fn("Engine.reviewedTarget")(function* (dirOfRun: string) {
    const row = yield* store.run(dirOfRun.replace(/\/+$/, "").split("/").at(-1) ?? "");
    const generation = row === null ? undefined : live.get(row.generation);
    if (row === null || generation === undefined) return null;
    return pointedAt(
      generation,
      yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({}))),
    );
  });

  /**
   * Where a Run will work, settled before it exists. A workflow that declares a checkout is
   * cut one from the checkout it starts from, and one that cannot be is refused here, while
   * there is nothing to clean up. A fresh Task's workspace is opened now, on that checkout,
   * or is the worktree workspace herdr opened for it — never a second one beside it.
   */
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
    // A fan-out has no checkout of its own: each repository's Run cuts its own.
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
    if (ask.checkout !== undefined) ({ placed, opened } = ask.checkout);
    else if (generation.checkout !== "none" && fanOut === null) {
      const inputs = yield* branchInputs(generation, ask.input, ask.options);
      // A build of a review's findings works on the branch that review was pointed at.
      const source = fieldWith(generation.hints, "work-source");
      const reviewed =
        source !== undefined &&
        inputs[`${source}_kind`] === "review" &&
        fieldWith(generation.hints, "diff-target") === undefined
          ? yield* reviewedTarget(inputs[source] ?? "")
          : null;
      if (reviewed !== null) inputs[REVIEWED] = reviewed;
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
        cwd: from,
        stateDir: placing.env.stateDir,
        workflow: generation.id,
        checkout: generation.checkout,
        separate: ask.request.kind === "separate",
        name: ask.runId,
        inputs,
        strategies:
          reviewed === null ? generation.hints : { ...generation.hints, [REVIEWED]: "diff-target" },
        sources: ask.provenance,
        openLabel: ask.taskLabel ?? null,
        explicit: ask.options.branch ?? null,
        branchBase: ask.branchBase,
        login: placing.env.gitlabLogin,
        githubLogin: placing.env.githubLogin,
        gitlabHost: yield* gitlabHostOf(placing.env).pipe(Effect.orElseSucceed(() => undefined)),
        recordedBy: (at) =>
          Effect.gen(function* () {
            const rows = yield* store.runs;
            const others = rows.filter((row) => row.run !== ask.runId);
            const recorders = others
              .filter((row) => workingPlace(row).worktree?.path === at)
              .map((row) => row.run);
            const latest = others.findLast((row) => workingPlace(row).worktree?.path === at);
            if (latest === undefined) return null;
            // Whoever works in it, recorded or not and by whatever path, gives it up too.
            const real = (dir: string) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
            const here = yield* real(at);
            const users: string[] = [];
            for (const row of others) {
              const cwd = yield* real(workingPlace(row).cwd);
              if (cwd === here || cwd.startsWith(`${here}/`)) users.push(row.run);
            }
            const runs = new Set(
              [...recorders, ...users].flatMap((run) => [run, ...descendantsOf(rows, run)]),
            );
            return {
              run: latest.run,
              worktree: workingPlace(latest).worktree ?? null,
              release: releaseRuns([...runs]).pipe(
                Effect.flatMap((why) => (why === null ? agentIn(here) : Effect.succeed(why))),
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
      const own = checkout.worktree?.managed_by === "herdr" ? checkout.workspaceId : null;
      opened = own === null ? null : { id: own, label: checkout.workspaceLabel };
      placed = {
        cwd: checkout.cwd,
        branch: checkout.branch,
        workspace: ask.taskLabel === undefined ? own : null,
        worktree: checkout.worktree,
      };
      yield* ask.record({ checkout: { placed, opened } });
    }
    if (ask.taskLabel === undefined) return { placed, task: ask.task };
    // One workspace per Task: a start about a Task's work — a release of its merge request,
    // a review of it, a fix of that review — is that Task's, wherever it came from.
    if (ask.workspace === undefined && opened === null) {
      const joined = yield* taskWorking(generation, ask, placed);
      if (joined !== null) return { placed, task: joined.id };
    }
    const label = opened?.label ?? ask.taskLabel;
    const openWorkspace = Effect.gen(function* () {
      if (ask.workspace === null) {
        return yield* new PlacementUncertain({
          reason: `a workspace "${label}" on ${placed.cwd} may have been opened for ${ask.runId} before the host stopped, and nothing records which. Close it if it is there, and start again under a new request id.`,
        });
      }
      yield* ask.record({ workspace: null });
      const made = yield* placing.herdr.workspaceCreate({ cwd: placed.cwd, label }).pipe(
        Effect.mapError((cause) => {
          const reason = `No workspace could be opened for this task: ${herdrFailureReason(cause)}`;
          return cause.answered === true
            ? new HostRefused({ reason })
            : new PlacementUncertain({ reason });
        }),
      );
      yield* ask.record({ workspace: made.workspaceId });
      return { workspace: made.workspaceId, rootPane: made.rootTab?.paneId ?? null };
    });
    const { workspace, rootPane } =
      opened !== null
        ? { workspace: opened.id, rootPane: placed.worktree?.root_pane_id ?? null }
        : ask.workspace !== undefined && ask.workspace !== null
          ? { workspace: ask.workspace, rootPane: null }
          : yield* openWorkspace;
    // A workspace an earlier attempt recorded may already have its Task.
    const known =
      ask.workspace === undefined
        ? null
        : yield* taskOfWorkspace(placing.env.stateDir, workspace).pipe(Effect.orDie);
    const task =
      known ??
      (yield* newTask({
        workspace,
        label,
        cwd: placed.cwd,
        rootPane,
        herd: yield* herdOf(placing.env.socketPath).pipe(Effect.orElseSucceed(() => null)),
      }).pipe(
        Effect.flatMap((made) => writeTask(placing.env.stateDir, made)),
        Effect.orDie,
      ));
    return { placed, task: task.id };
  }, Effect.provideContext(bun));

  /**
   * The Task whose work this Run is about, or null: one whose Runs opened or were given the
   * merge request its diff target names, or, while herdr has its workspace, were placed on
   * its branch. Where several are, the one whose matching Run came first.
   */
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
    const mr = mrKeyOf(pointedAt(generation, ask.input));
    if (branch === null && mr === null) return null;
    const open = new Set(
      branch === null
        ? []
        : (yield* placing.herdr
            .workspaceList()
            .pipe(Effect.orElseSucceed((): ReadonlyArray<{ workspaceId: string }> => []))).map(
            (one) => one.workspaceId,
          ),
    );
    const tasks = new Map(
      (yield* listTasks(placing.env.stateDir).pipe(Effect.orElseSucceed(() => []))).map(
        (task) => [task.id, task] as const,
      ),
    );
    for (const row of yield* store.runs) {
      const task = row.task === null || row.run === ask.runId ? undefined : tasks.get(row.task);
      if (task === undefined) continue;
      if (mr !== null) {
        const recorded = live.get(row.generation);
        const given = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
        const mrs = [
          yield* mergeRequestOf(fs, dir, row.run),
          recorded === undefined ? null : pointedAt(recorded, given),
        ].map(mrKeyOf);
        if (mrs.includes(mr)) return task;
      }
      if (branch === null || !open.has(task.workspace) || unplaced(row)) continue;
      const at = placedOf(row, {});
      if (at.branch === null) continue;
      if ((yield* about({ cwd: at.cwd, branch: at.branch, name: row.run, inputs: {} })) === branch)
        return task;
    }
    return null;
  }, Effect.provideContext(bun));

  // One admission of a request at a time: placing is external, and only its claimant places.
  const claiming = yield* Effect.forEach(Array.from({ length: CLAIM_STRIPES }), () =>
    Semaphore.make(1),
  );
  const claimingOf = (request: string) => claiming[stripeOf(request)]!;

  /**
   * Places a claimed Run, as its claimant only. Refused, a claim this admission made is
   * withdrawn; one found claimed may have made something already, so it is kept.
   */
  const placeClaimed = Effect.fn("Engine.placeClaimed")(function* (row: RunRow, fresh: boolean) {
    const generation = live.get(row.generation);
    const placing = decodePlacing(row.placing ?? "");
    if (!unplaced(row) || generation === undefined || Option.isNone(placing)) return row;
    let receipt = placing.value;
    const strings = (text: string | null) =>
      decodeStrings(text ?? "{}").pipe(Effect.orElseSucceed((): Record<string, string> => ({})));
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
      // An uncertain one keeps its claim: the same request again must not open another.
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
        // A Run this host holds no generation for has nothing executing here.
        Effect.orElseSucceed(() => true),
      ),
  };

  /**
   * Another workflow, as part of this one. Selected in the parent's own project and
   * decoded against the child's own schema before a row exists, so input the child will
   * not take is the parent's failure rather than a half-made Run.
   */
  const children: ChildrenApi = {
    start: (ask: ChildAsk) => lending(admitChild(ask)),
    result: (child: ChildRun) => lending(runChild(child)),
  };

  const admitChild = Effect.fn("Engine.children.start")(function* (given: ChildAsk) {
    const parentId = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id;
    if (parentId === undefined) return yield* refused("a child is started from inside a Run");
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
      Effect.orElseSucceed((): Record<string, string> => ({})),
    );
    // What the parent prefers where it starts the child, as options the child is given:
    // serializable, so no Context, service or Layer of the parent's crosses over.
    const inherited = foldPreferences([preferencesIn(parentOptions), ...(yield* AgentScopes)]);
    // The host's own options, held to the same rule a front door's are: a name that is
    // not the host's would be a field the child's author never declared.
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
    // Where its parent works, unless it named a checkout of its own.
    const from = request.kind === "existing" ? request.path : placedOf(parent, parentOptions).cwd;
    const settled = yield* settleInput(generation.fields, { json: ask.input, text: {} }).pipe(
      Effect.flatMap((given) => settleTargets(generation, given, from)),
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const payload = yield* Schema.decodeUnknownEffect(
      generation.registration.workflow.payloadSchema,
    )({ runId, input: settled.input }).pipe(
      Effect.mapError((cause) => refused(`${REFUSED_INPUT}: ${cause.message}`)),
    );
    const launch = Object.entries(generation.hints).find(([, strategy]) =>
      EXCLUSIVE_STRATEGIES.includes(strategy),
    )?.[0];
    const named = launch === undefined ? "" : settled.input[launch];
    // An admitted child's saved placement also covers replay and crash recovery.
    const taskLabel =
      ask.ownTask === true && (yield* store.run(runId)) === null
        ? yield* freshTaskLabel(
            { ...placing.env, cwd: from },
            {
              workflow: generation.id,
              named: isText(named) ? named : "",
            },
            options?.namesTasks === true,
          ).pipe(
            Effect.provideContext(bun),
            Effect.mapError((cause) => refused(`no Task could be named: ${cause.message}`)),
          )
        : null;
    const claimed = yield* claimAndPlace({
      // The invocation is the claim, so replaying the parent admits nothing new and
      // changing what an invocation is given is refused rather than run twice.
      request: runId,
      run: runId,
      workflow: generation.id,
      project: parent.project,
      input: settled.input,
      provenance: settled.provenance,
      options: launchOptions(generation, asked),
      placing: encodePlacing({ from, taskLabel, root, closes: generation.closes }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: ask.ownTask === true ? null : parent.task,
      parent: ask.runId,
    }).pipe(Effect.mapError((failure) => refused(failure.reason)));
    // A child is a Run, so what it may verify is frozen with it rather than read when
    // it asks. It is held to what its parent was, grants included, as an offer's start
    // is; one that works in a checkout of its own is held to what that checkout approves.
    const parentChecks = request.kind === "existing" ? [] : yield* approvedOf(dir, parent.run);
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: request.kind === "existing" ? request.path : parent.project,
      userDir,
      approved: parentChecks.length > 0 ? parentChecks : undefined,
    }).pipe(Effect.provideContext(bun), Effect.ignore);
    yield* seedIntentOf({ dir, row: claimed.row, generation, seed: undefined, parent }).pipe(
      Effect.provideContext(bun),
      Effect.ignore,
    );
    if (claimed.row.accepted === null) yield* attachInto(claimed.row);
    // The parent hands its own children over, so the receipt is written here: a host
    // sweep dispatching one would give the engine a child with no parent to wake.
    yield* store.accepted(claimed.row.run);
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
    if (row === null) return yield* refused(`no run "${child.runId}" was started here`);
    const payload = yield* payloadOf(found.generation.registration, row).pipe(
      Effect.mapError(() => refused(`${found.generation.entry} no longer takes ${row.input}`)),
    );
    // Executed on the parent's own fiber, which is what links the two: the engine
    // reads the parent's instance from here, so the child's completion wakes the
    // parent and interrupting the parent reaches the child.
    const workflow = found.generation.registration.workflow;
    const written = Schema.encodeUnknownOption(Schema.toCodecJson(workflow.errorSchema));
    // A release that derives ids differently would otherwise run a finished child again.
    // ponytail: the engine registers the child with the parent a few synchronous steps
    // later than `workflow.execute` would; a yield in between re-executes the same id.
    const derived = row.execution === (yield* workflow.executionId(payload));
    return yield* Effect.suspend(() =>
      derived
        ? workflow.execute(payload)
        : engine.execute(workflow, {
            executionId: row.execution,
            payload,
            suspendedRetrySchedule: workflow.suspendedRetrySchedule,
          }),
    ).pipe(
      Effect.mapError((failure) => {
        if (isWorkflowError(failure)) return failure;
        // A child's own typed failure, as its error schema writes it.
        const encoded = written(failure);
        const text =
          Option.isSome(encoded) && isJson(encoded.value) ? asJsonText(encoded.value) : "";
        return refused(`${child.workflow} failed: ${text}`);
      }),
    );
  });

  /** A host dying where the proof needs one to; nothing else ever sets this. */
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
        Schema.decodeUnknownEffect(registration.workflow.payloadSchema)({
          runId: row.run,
          input,
        }),
      ),
    );

  /**
   * Gives the engine work that is recorded and not yet accepted, and writes the receipt.
   * A start, a retry of one that crashed before the engine heard, and a host that starts
   * with rows outstanding all come through here — under the identity the row was
   * admitted with, so the engine's own idempotency makes a repeat a no-op rather than a
   * second run.
   *
   * Nothing happens where it cannot be handed over: the module is not registered here,
   * or no longer takes what it was started with. The row stays as it is, for a repair.
   */
  const handOver = Effect.fn("Engine.handOver")(function* (row: RunRow, clear = true) {
    const generation = live.get(row.generation);
    if (generation === undefined || unplaced(row)) return false;
    const payload = yield* payloadOf(generation.registration, row).pipe(Effect.result);
    if (payload._tag === "Failure") return false;
    yield* attachInto(row);
    yield* crash("admitted");
    const before = entriesOf.get(generation.registration.workflow)?.get(row.run) ?? 0;
    const old = yield* fs.readFileString(controlPath(dir, PARKED, row.run)).pipe(Effect.option);
    if (clear) yield* clearParked(row.run);
    // Upstream retries a send it cannot route without end; the row stays unaccepted for the next host.
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

  /** A Run's own attachments, then its Lineage's, copied in before its first step. */
  const attachInto = (row: RunRow) =>
    Effect.gen(function* () {
      const own = Option.match(decodeAskedAttachments(row.asked ?? "{}"), {
        onNone: () => [],
        onSome: (asked) => asked.attachments ?? [],
      });
      const inherited: string[] = [];
      for (const from of (yield* lineageIn(store)(row.run)).slice(1))
        for (const one of yield* listAttachments(attachmentsDir(runDir(dir, from))))
          inherited.push(one.path);
      yield* copyInto(attachmentsDir(runDir(dir, row.run)), [...own, ...inherited]);
    }).pipe(
      Effect.provideContext(bun),
      // ponytail: a file gone since it was checked starts the Run without it; refuse instead if that bites.
      Effect.catch((cause) =>
        Effect.logWarning(`${row.run}'s attachments could not be copied: ${reason(cause)}`),
      ),
    );

  /**
   * Admitted work a host did not live to place or hand over, finished under its claim. The
   * row is read again under the claim: another pass may have placed or handed it over since.
   */
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

  /** Every recorded answer handed again to a run still waiting; the engine keeps one completion. */
  const reconcileAnswers = Effect.gen(function* () {
    const woken: string[] = [];
    for (const row of yield* store.runs) {
      const generation = live.get(row.generation);
      if (generation === undefined) continue;
      const answered = (yield* store.asked(row.run)).filter(
        (one) => one.answer !== null && one.asker === null,
      );
      if (answered.length === 0) continue;
      const state = pollStatus(
        yield* engine.poll(generation.registration.workflow, row.execution),
        generation.entry,
      );
      if (state.status !== "suspended") continue;
      const before = entriesOf.get(generation.registration.workflow)?.get(row.run) ?? 0;
      const old = yield* fs.readFileString(controlPath(dir, PARKED, row.run)).pipe(Effect.option);
      yield* clearParked(row.run);
      for (const one of answered) {
        yield* answerDecision(generation.registration, {
          name: one.decision,
          executionId: row.execution,
          value: one.answer ?? "",
        });
      }
      if (yield* waitForEntry(generation.registration.workflow, row.run, before))
        woken.push(row.run);
      else yield* restoreParked(row.run, old);
    }
    return woken;
  }).pipe(waking.withPermits(1));

  /** The file a generation was built from, which a row keeps naming after it has gone. */
  const entryOf = (name: string) => known.find((route) => route.name === name)?.entry ?? "";

  /** The projects a Run still holds a claim on, as one line; null where it holds none. */
  const claimOf = (runId: string) =>
    recordedClaims(claimPath(dir, runId)).pipe(
      Effect.map((held) => (held.length === 0 ? null : held.map((one) => one.slug).join(", "))),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  /** A finished execution's status: it is never resumed, so it cannot change. */
  const finished = new Map<string, typeof RunStatus.Type>();
  const polled = Effect.fn("Engine.polled")(function* (generation: Generation, execution: string) {
    const workflow = generation.registration.workflow;
    const status = pollStatus(
      yield* engine.poll(workflow, execution),
      generation.entry,
      workflow.successSchema,
      workflow.errorSchema,
    );
    if (status.status === "complete" || status.status === "failed") finished.set(execution, status);
    return status;
  });

  const viewOf = Effect.fn("Engine.viewOf")(function* (row: RunRow) {
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const placing = Option.getOrUndefined(decodePlacing(row.placing ?? ""));
    const report = Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.fromJsonString(RunReport))(
        yield* fs
          .readFileString(`${runDir(dir, row.run)}/report.json`)
          .pipe(Effect.orElseSucceed(() => "")),
      ),
    );
    const admitted = {
      requestedBy: placing?.requestedBy,
      closes: placing?.closes,
      report,
      runId: row.run,
      workflow: row.workflow,
      project: row.project,
      task: row.task,
      parent: row.parent,
      registration: row.generation,
      entry: entryOf(row.generation),
      input,
      provenance: yield* decodeStrings(row.provenance ?? "{}").pipe(
        Effect.orElseSucceed((): Record<string, string> => ({})),
      ),
      options: yield* decodeStrings(row.options ?? "{}").pipe(
        Effect.orElseSucceed((): Record<string, string> => ({})),
      ),
    };
    const { cwd, branch, workspace, worktree } = placedOf(row, admitted.options);
    const outcome = admitted.options.outcome ?? UNSPECIFIED;
    const generation = live.get(row.generation);
    const about = {
      ...admitted,
      strategies: generation?.hints ?? {},
      cwd,
      branch,
      workspace,
      worktree,
      outcome,
      created: row.admitted,
      waiting: yield* asked(row.run),
      controls: yield* controlsOf(row.run),
      parked: yield* fs
        .readFileString(controlPath(dir, PARKED, row.run))
        .pipe(Effect.orElseSucceed(() => null)),
      awaiting: yield* fs.readFileString(controlPath(dir, AWAITING, row.run)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AwaitingJson)),
        Effect.orElseSucceed(() => null),
      ),
      mr: yield* mergeRequestOf(fs, dir, row.run),
      landing: yield* readLanding(runDir(dir, row.run)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    };
    // Not registered here is not a verdict on the work: the rows are all still there,
    // and what is missing is the module, named so somebody can put it back.
    if (generation === undefined) {
      return {
        ...about,
        status: { status: "pending" as const },
        diagnostic:
          unavailable.get(row.generation) ?? `${row.generation} is not registered in this host`,
      };
    }
    const status = finished.get(row.execution) ?? (yield* polled(generation, row.execution));
    // A failed Run keeps a claim it may have left shared work half-done under.
    const kept = status.status === "failed" ? yield* claimOf(row.run) : null;
    return {
      ...about,
      status,
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
    const path = controlPath(dir, control, runId);
    yield* (set ? fs.writeFileString(path, "") : fs.remove(path).pipe(Effect.ignore)).pipe(
      Effect.orDie,
    );
  });

  /** Which controls an operator has set over this run. */
  const controlsOf = Effect.fn("Engine.controlsOf")(function* (runId: string) {
    const set: string[] = [];
    for (const control of [HOLD, STOP]) {
      const on = yield* fs
        .exists(controlPath(dir, control, runId))
        .pipe(Effect.orElseSucceed(() => false));
      if (on) set.push(control);
    }
    return set;
  });

  /**
   * Wakes a run and waits for it to settle where it is going next.
   *
   * A woken run runs before it parks again, and a completion that arrives inside that
   * window is delivered to a run that is not waiting on anything yet — so it is lost,
   * and resuming afterwards does not bring it back. Returning only once the run has
   * settled is what makes the next thing an operator does land on it.
   */
  const wake = Effect.fn("Engine.wake")(function* (
    runId: string,
    found: {
      readonly generation: Generation;
      readonly execution: string;
    },
  ) {
    const workflow = found.generation.registration.workflow;
    const status = pollStatus(
      yield* engine.poll(workflow, found.execution),
      found.generation.entry,
    ).status;
    if (status === "suspended") {
      const entries = entriesOf.get(workflow);
      const before = entries?.get(runId) ?? 0;
      const old = yield* fs.readFileString(controlPath(dir, PARKED, runId)).pipe(Effect.option);
      yield* clearParked(runId);
      yield* engine
        .resume(workflow, found.execution)
        .pipe(Effect.onError(() => restoreParked(runId, old)));
      const entered = yield* waitForEntry(workflow, runId, before);
      if (!entered) {
        yield* restoreParked(runId, old);
        return yield* new HostRefused({ reason: `${runId} did not take up its suspended work` });
      }
    }
    yield* engine.poll(workflow, found.execution).pipe(
      Effect.map((result) => pollStatus(result, found.generation.entry).status),
      Effect.flatMap((status) =>
        status === "pending" ? Effect.fail(new Error("still running")) : Effect.void,
      ),
      Effect.retry({ times: WAKE_TRIES, schedule: Schedule.spaced(WAKE_INTERVAL) }),
      Effect.ignore,
    );
    return status === "suspended";
  }, waking.withPermits(1));

  /** Every question this run has been asked, with the answers its options allow. */
  const asked = Effect.fn("Engine.asked")(function* (runId: string) {
    const rows = yield* store.asked(runId);
    const none: ReadonlyArray<string> = [];
    return yield* Effect.forEach(rows, (row) =>
      decodeOptions(row.options).pipe(
        Effect.orElseSucceed(() => none),
        Effect.map((options) => ({
          name: row.decision,
          prompt: row.prompt,
          options,
          answer: row.answer,
        })),
      ),
    );
  });

  const view = (runId: string) =>
    store
      .run(runId)
      .pipe(Effect.flatMap((row) => (row === null ? Effect.succeed(null) : viewOf(row))));

  /**
   * What the engine last said about each run it may still change. Upstream's tables are
   * upstream's: a write there invalidates nothing of Collie's, so one fiber asks on a
   * schedule every client shares and says so once — rather than each client looping.
   */
  const watched = new Map<string, { readonly row: RunRow; said: string }>();
  const remember = (row: RunRow) => watched.set(row.run, { row, said: "" });
  for (const row of yield* store.runs) remember(row);
  /** How many clients are listening. A host nobody is watching asks nothing at all. */
  let watchers = 0;

  const sweep = Effect.gen(function* () {
    if (watchers === 0) return;
    let changed = false;
    for (const [runId, entry] of watched) {
      const view = yield* viewOf(entry.row);
      const said = encodeView(view);
      if (said === entry.said) continue;
      entry.said = said;
      changed = true;
      // A run the engine has finished with cannot change again, so nothing asks after.
      if (view.status.status === "complete" || view.status.status === "failed") {
        watched.delete(runId);
      }
    }
    if (changed) yield* store.announce;
  });
  yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  /** What this host is holding, as a caller may see it. */
  const held = Effect.sync(() => ({
    live: [...live.keys()].sort(),
    unavailable: [...unavailable.entries()].map(([name, why]) => `${name}: ${why}`).sort(),
  }));

  const newest = Effect.fn("Engine.newest")(function* (id: string) {
    const generation = live.get(newestOf.get(id) ?? "");
    if (!generation) {
      return yield* new HostRefused({ reason: `no workflow "${id}" is loaded here` });
    }
    return generation;
  });

  const routed = Effect.fn("Engine.routed")(function* (runId: string) {
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

  /** Whether a Run has ended, a stop included: no step is left to hold, and a gone agent's work goes on elsewhere. */
  const hasEnded = Effect.fn("Engine.hasEnded")(function* (runId: string) {
    // A stopped Run writes no final card; its stop is the record.
    if ((yield* controlsOf(runId)).includes(STOP)) return true;
    return yield* workflowEnded(runId);
  });

  /** Whether a Run's Workflow ran to its end: the status a stop must not rewrite. */
  const workflowEnded = Effect.fn("Engine.workflowEnded")(function* (runId: string) {
    const found = yield* routed(runId).pipe(Effect.option);
    // With its module gone the engine cannot be asked, and the finish's record answers.
    if (Option.isNone(found)) return (yield* finishedOnRecord(runDir(dir, runId))) !== null;
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

  /** Why a live agent in any session works inside `dir`, or null when none does. */
  const agentIn = Effect.fn("Engine.agentIn")(function* (dir: string) {
    const real = (at: string) => fs.realPath(at).pipe(Effect.orElseSucceed(() => at));
    // Unlike liveHerds, an unlisted session is a refusal: its agents may work in it.
    const listed = yield* Effect.result(placing.herdr.sessionList());
    if (listed._tag === "Failure")
      return "herdr would not list its sessions, whose agents may work in it";
    const sessions =
      listed.success.length === 0
        ? [placing.herdr]
        : listed.success.map((one) => placing.herdr.inSession(one.socketPath));
    for (const herdr of sessions) {
      const panes = yield* Effect.result(herdr.paneList());
      if (panes._tag === "Failure") return "herdr would not say which agents work in it";
      for (const pane of panes.success) {
        if (!pane.agent) continue;
        for (const at of [pane.cwd, pane.foregroundCwd]) {
          if (at === null) continue;
          const there = yield* real(at);
          if (there === dir || there.startsWith(`${dir}/`)) {
            return `agent ${pane.agent} in pane ${pane.paneId} works in it`;
          }
        }
      }
    }
    const servers = yield* unlistedServers(placing.env.stateDir, sessions);
    if (servers === null) return "herdr would not say which agents it has";
    for (const record of servers) {
      const there = yield* real(record.cwd);
      if (there === dir || there.startsWith(`${dir}/`))
        return `${record.agent}'s server may still be writing in it`;
    }
    return null;
  }, Effect.provideContext(bun));

  /** Closes ended Runs' agents; null once closed, or why not. A stopped Run may resume. */
  const releaseRuns = Effect.fn("Engine.releaseRuns")(function* (runs: ReadonlyArray<string>) {
    for (const runId of runs) {
      if (!(yield* workflowEnded(runId))) return `${runId} has not ended and may still go on in it`;
    }
    const agents = yield* Agents;
    const left: string[] = [];
    for (const runId of runs) left.push(...(yield* agents.halt(runId)).left);
    return left.length === 0 ? null : `its agents did not all close (${left.join("; ")})`;
  }, Effect.provideContext(hostServices));

  /** Sets a control, and a stop over every child the Run started, then wakes what must look again. */
  const applyControl = Effect.fn("Engine.applyControl")(function* (
    runId: string,
    control: string,
    set: boolean,
    recovered?: ReadonlySet<string>,
    alone = false,
  ) {
    // A stop reaches the children a Run started: they are its work too.
    const runs =
      control === STOP && !alone ? [runId, ...descendantsOf(yield* store.runs, runId)] : [runId];
    // Written before anything is woken, so a run that wakes up never finds the request
    // that stopped it still there.
    const stopped = new Set<string>();
    for (const one of runs) {
      if (control === STOP && !set && (yield* controlsOf(one)).includes(STOP)) stopped.add(one);
      yield* setControl(one, control, set);
    }
    // A file, not a row: nothing tells a watcher about it unless this does.
    yield* store.announce;
    // A hold is read at the next boundary and needs no waking. Everything else does: a
    // run parked on its question has nothing that would make it look again.
    const woken: string[] = [];
    if (!(control === HOLD && set)) {
      for (const one of runs) {
        if (recovered?.has(one) && !stopped.has(one)) continue;
        const found = yield* routed(one).pipe(Effect.option);
        if (Option.isSome(found) && (yield* wake(one, found.value))) woken.push(one);
      }
    }
    return { runs, woken };
  });

  /** A stop, and the agents of every Run it reached closed: the Runs, and what did not close. */
  const stopTree = Effect.fn("Engine.stopTree")(function* (
    runId: string,
    alone = false,
    reason?: string,
  ) {
    const { runs } = yield* applyControl(runId, STOP, true, undefined, alone);
    // Closing their panes is what stops the agents; the Run only stops looking.
    const agents = yield* Agents;
    const left: string[] = [];
    for (const one of runs) left.push(...(yield* agents.halt(one, reason)).left);
    return { runs, left };
  });

  // One registration at a time. Two clients starting different modules of one id at the
  // same moment would otherwise mint one name for both and stage over each other.
  const registering = yield* Semaphore.make(1);
  // A grant is a read and a write of one file: two at once would each drop the other's.
  const granting = yield* Semaphore.make(1);

  const mint = Effect.fn("Engine.Registry.mint")(function* (file: string) {
    // Read as it is now to learn the id this file claims, then register the next
    // generation of that id.
    const described = yield* loadEntry(file);
    const route = {
      workflow: described.id,
      name: nextRegistrationName(known, described.id),
      entry: file,
    };
    const generation = yield* register(route);
    known = [...known, route];
    yield* store.remember(route);
    return generation;
  });

  const useEntry = (options: { readonly entry: string; readonly revision: string }) =>
    registering.withPermits(1)(
      Effect.gen(function* () {
        const source = `${options.entry}@${options.revision}`;
        for (const generation of live.values()) {
          if (generation.source === source) return generation;
        }
        return yield* mint(options.entry);
      }),
    );

  const resolve = Effect.fn("Engine.Registry.resolve")(function* (options: {
    readonly project: string;
    readonly id: string;
  }) {
    if (locate === undefined) return yield* newest(options.id);
    const found = yield* locate(options);
    return yield* useEntry(found).pipe(
      Effect.mapError(
        (failure) => new HostRefused({ reason: `${failure.file}: ${failure.message}` }),
      ),
    );
  });

  /**
   * A Run, the module it would be offered from now, and the facts those offers are
   * decided on. The generation is resolved in the Run's own project rather than taken
   * from the row: what is offered is the current code's to say, and a module that has
   * been edited away leaves the Run readable and its offers refused with the reason.
   */
  /** A follow-up takes what its workflow needs and the offer does not fill, so a front door asks for it. */
  const unfilled = (offer: Offer, project: string, filled: Readonly<Record<string, Schema.Json>>) =>
    resolve({ project, id: offer.workflow }).pipe(
      Effect.map((target) => {
        const rest = Object.entries(target.fields).filter(([name]) => !(name in filled));
        if (rest.length === 0) return offer;
        return {
          ...offer,
          arguments: jsonSchemaFor(Schema.Struct(Object.fromEntries(rest))).document,
        };
      }),
      Effect.orElseSucceed(() => offer),
    );

  const offeredBy = Effect.fn("Engine.Registry.offeredBy")(function* (runId: string) {
    const row = yield* store.run(runId);
    if (row === null) {
      return yield* new HostRefused({ reason: `no run "${runId}" was started here` });
    }
    const generation = yield* resolve({ project: row.project, id: row.workflow });
    const options = yield* decodeStrings(row.options ?? "{}").pipe(
      Effect.orElseSucceed((): Record<string, string> => ({})),
    );
    const found = yield* routed(runId);
    const state = pollStatus(
      yield* engine.poll(found.generation.registration.workflow, found.execution),
      found.generation.entry,
    );
    const asked = options.outcome ?? UNSPECIFIED;
    const where = runDir(dir, runId);
    // The facts a host has about a Run. What it was launched with and how it
    // ended are the row's; the tickets it wrote and the findings it left are read from
    // its own directory, because producing them is the only way a Run can have them.
    const disposition = latest(
      yield* readDispositions(where).pipe(Effect.orElseSucceed((): Array<Disposition> => [])),
    );
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const facts: ActionFacts = {
      outcome: isOutcome(asked) ? asked : "unspecified",
      succeeded: state.status === "complete",
      // Where the host placed it: a branch it inferred is as much the Run's as one named.
      branch: placedOf(row, options).branch,
      mrUrl: yield* mergeRequestOf(fs, dir, runId),
      planIssues: yield* planIssuesIn(where),
      disposed: disposition !== null,
      openFindings: yield* openFindingsIn(where),
      diffTarget: pointedAt(generation, input),
      claim: yield* claimOf(runId),
    };
    // A plan spanning repositories is a fan-out, which an offer does not start.
    const refused = new Map<string, string>();
    for (const offer of generation.offers) {
      const field = Object.entries(offer.inputs).find(([, source]) => source === "plan-dir")?.[0];
      if (field === undefined) continue;
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
            `its plan spans repositories (${read.success.repos.map((one) => one.path).join(", ")}), which a card does not fan out. \`collie run start ${offer.workflow === SELF ? row.workflow : offer.workflow} --input ${field}=${where}/plan\` does, one Run per repository.`,
        );
      }
    }
    // A follow-up works in its parent's checkout, which a Run still going, or a stopped one
    // that can be resumed, would be working in too.
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
        if (offer.kind === "follow-up") refused.set(offer.id, notYet);
      }
    }
    return { row, generation, facts, where, refused, input };
  });

  /** What a start is checked against before anything exists to clean up. */
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
    if (unattachable !== null)
      return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${unattachable}` });
    const request = yield* checkoutRequest(generation, asked, options.root ?? null);
    const launch = launchOptions(generation, asked);
    // An empty set given is none given, so the project's verify.json still applies.
    const verify = options.verify?.length ? options.verify : undefined;
    // Settled before anything exists to clean up: an input the workflow's own schema
    // rejects names its field here, and no row, claim or execution is created.
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
    const payload = yield* Schema.decodeUnknownEffect(
      generation.registration.workflow.payloadSchema,
    )({ runId, input: settled.input }).pipe(
      Effect.mapError((cause) => new HostRefused({ reason: `${REFUSED_INPUT}: ${cause.message}` })),
    );
    // A retry of a Run already admitted is not a new start: it keeps what it froze, or
    // freezes what it carries.
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
          }).pipe(Effect.provideContext(bun))
        : verify;
    return { request, launch, settled, payload, approved };
  });

  const startWork = Effect.fn("Engine.Registry.start")(function* (options: StartOptions) {
    const generation = options.generation;
    const runId =
      options.runId ?? `run-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`;
    const asked = options.options ?? {};
    const { request, launch, settled, payload, approved } = yield* settleStart(options, runId);
    const claimed = yield* claimAndPlace({
      request: options.request,
      run: runId,
      workflow: generation.id,
      project: options.project,
      input: settled.input,
      provenance: {
        ...settled.provenance,
        // A host option a front door worked out, such as the checkout it placed the Run in.
        ...Object.fromEntries(
          (options.inferred ?? []).filter((name) => name in asked).map((name) => [name, INFERRED]),
        ),
      },
      options: launch,
      placing: encodePlacing({
        requestedBy: options.requestedBy,
        started: options.started,
        branchBase: options.branchBase,
        closes: generation.closes,
        from: request.kind === "existing" ? request.path : options.project,
        taskLabel: options.taskLabel ?? null,
        root: options.root ?? null,
      }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: options.task ?? null,
      parent: options.parent ?? null,
      attachments: options.attachments,
    });
    // Frozen with the Run, so editing the project's list changes the next one.
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: options.project,
      userDir,
      approved,
    }).pipe(Effect.provideContext(bun), Effect.ignore);
    yield* seedIntentOf({
      dir,
      row: claimed.row,
      generation,
      seed: options.intent,
      parent: options.parent ? yield* store.run(options.parent) : null,
    }).pipe(Effect.provideContext(bun), Effect.ignore);
    // A retry of work the engine already has is nothing more to do; one that crashed
    // before it heard is handed over now, under the identity it was admitted with.
    // A caller that executes the Run itself has the receipt first, as a parent does.
    if (claimed.row.accepted === null)
      yield* options.handsOver === true ? store.accepted(claimed.row.run) : handOver(claimed.row);
    return {
      runId: claimed.row.run,
      registration: claimed.row.generation,
      execution: claimed.row.execution,
      fresh: claimed.fresh,
    };
  });

  const recover = () =>
    Effect.gen(function* () {
      const recovered = new Set<string>();
      yield* registering.withPermits(1)(
        Effect.forEach(known, (route) =>
          live.has(route.name)
            ? Effect.void
            : register(route, recovered).pipe(
                Effect.catchTag("EntryError", (failure) =>
                  Effect.sync(() =>
                    unavailable.set(route.name, `${failure.file}: ${failure.message}`),
                  ),
                ),
              ),
        ),
      );
      for (const row of yield* store.pending) {
        if (yield* recoverAdmission(row)) recovered.add(row.run);
      }
      for (const one of yield* reconcileAnswers) recovered.add(one);
      return { registrations: yield* held, takenUp: recovered };
    });

  // What was registered before this host existed, rebuilt from the modules as they are
  // now. A file that has gone leaves its generation unavailable and every other one
  // registered, which is what keeps one broken module from stopping the rest.
  for (const route of known) {
    yield* register(route).pipe(
      Effect.catchTag("EntryError", (failure) =>
        Effect.sync(() => unavailable.set(route.name, `${failure.file}: ${failure.message}`)),
      ),
    );
  }

  yield* Deferred.succeed(reportsReady, undefined);

  // What a host admitted and did not live to hand over. Every crash window ends here.
  // Forked, so a hand-over that stalls does not keep the host from serving.
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      for (const row of yield* store.pending) yield* recoverAdmission(row);
      yield* reconcileAnswers;
    }),
  );

  return {
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
    views: (task: string | null) =>
      store.runs.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(task === null ? rows : rows.filter((row) => row.task === task), viewOf, {
            concurrency: VIEW_CONCURRENCY,
          }),
        ),
      ),
    mergeRequest: (runId: string, url: string) =>
      fs
        .makeDirectory(runDir(dir, runId), { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(mergeRequestPath(dir, runId), `${url}\n`)),
          Effect.andThen(store.announce),
          Effect.orDie,
        ),
    watch: (runId: string) =>
      store
        .watching(view(runId))
        .pipe(
          Stream.onStart(Effect.sync(() => (watchers += 1))),
          Stream.ensuring(Effect.sync(() => (watchers -= 1))),
        ),

    recover: recover().pipe(Effect.map((result) => result.registrations)),

    resume: Effect.fn("Engine.Registry.resume")(function* (runId: string) {
      const recovered = yield* recover();
      const controlled = yield* applyControl(runId, STOP, false, recovered.takenUp).pipe(
        Effect.result,
      );
      const recorded = { runId, control: STOP, set: false, left: [] };
      if (controlled._tag === "Failure")
        return {
          ...recorded,
          applied: recovered.takenUp.has(runId),
          detail: controlled.failure.reason,
        };
      if (recovered.takenUp.has(runId) || controlled.success.woken.includes(runId))
        return { ...recorded, applied: true, detail: "" };
      const found = yield* routed(runId).pipe(Effect.result);
      if (found._tag === "Failure")
        return { ...recorded, applied: false, detail: found.failure.reason };
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
                ? unfilled(offer, row.project, inputsFor(offer, { runDir: where, facts, input }))
                : Effect.succeed(offer),
          ),
        ),
      ),

    invoke: Effect.fn("Engine.Registry.invoke")(function* (options: {
      readonly runId: string;
      readonly offer: string;
      readonly input: Readonly<Record<string, Schema.Json>>;
      readonly request: string;
      readonly attachments?: ReadonlyArray<string> | undefined;
    }) {
      const { row, generation, facts, where, refused, input } = yield* offeredBy(options.runId);
      // Asked again here, of the module as it is now: the card this was read from may
      // have been drawn before the file was edited, and a card is not authority.
      const offer = offersFrom(generation.offers, facts, {
        self: generation.id,
        keepUnavailable: true,
        refused,
      }).find((one) => one.id === options.offer);
      if (offer === undefined || offer.unavailable !== null) {
        const why = offer?.unavailable ? `: ${offer.unavailable}` : " now";
        return yield* new HostRefused({
          reason: `run "${options.runId}" does not offer "${options.offer}"${why}`,
        });
      }
      const starting = yield* resolve({ project: row.project, id: offer.workflow });
      // What the offer said Collie fills in, filled from the Run it is about. The
      // caller's own values win: an offer names where a value comes from, and a caller
      // that has a better one for the same field is not overruled by a default.
      const filled = { ...inputsFor(offer, { runDir: where, facts, input }), ...options.input };
      // Held to what its parent was, grants included, where the parent had anything.
      const inherited = yield* approvedOf(dir, row.run);
      // The offer's own workflow settles what it was given, so arguments it will not
      // take are refused here and nothing is started.
      return yield* startWork({
        generation: starting,
        request: options.request,
        project: row.project,
        input: filled,
        task: row.task,
        parent: row.run,
        verify: inherited,
        attachments: options.attachments,
        // A follow-up carries on the parent's work, so it is on the parent's branch.
        options:
          offer.kind === "follow-up" && facts.branch !== null ? { branch: facts.branch } : {},
      });
    }),

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
      if (found._tag === "Failure" && (yield* store.run(options.runId)) === null)
        return yield* found.failure;
      const asks = yield* asked(options.runId);
      const open = asks.filter((one) => one.answer === null);
      const sole = options.decision === null ? soleOpen(options.runId, open) : null;
      if (sole !== null) return yield* sole;
      const name = options.decision ?? open[0]?.name ?? "";
      // Every question, not only the open ones: one already answered and one never
      // asked are different refusals, and an operator is owed the difference.
      const question = asks.find((one) => one.name === name);
      if (question === undefined) {
        return yield* new HostRefused({
          reason: `run "${options.runId}" is not waiting on a decision called "${name}"`,
        });
      }
      // An option is its own title: taken in any case, kept as declared.
      const named = question.options.find(
        (option) => option.toLowerCase() === options.value.toLowerCase(),
      );
      if (question.options.length > 0 && named === undefined) {
        return yield* new HostRefused({
          reason: `"${options.value}" is not one of ${question.options.join(", ")}`,
        });
      }
      const value = named ?? options.value;
      // An agent's question needs no workflow to wake: a finished Run's module may be gone.
      const byAgent = (yield* store.asked(options.runId)).some(
        (row) => row.decision === name && row.asker !== null,
      );
      if (!byAgent && found._tag === "Failure") return yield* found.failure;
      // Recorded first, and only the caller the write hands the row to completes the
      // deferred: two answers racing are separated by the database, not by timing.
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
      if (settled._tag === "accepted") yield* crash("answered");
      // Completed again on a repeat: the recording host may have died before the run was told.
      // An agent's question is answered to its agent; waking the workflow would replay it.
      if (settled.row.asker === null && found._tag === "Success")
        yield* answerDecision(found.success.generation.registration, {
          name,
          executionId: found.success.execution,
          value,
        });

      return { runId: options.runId, decision: name, value, fresh: settled._tag === "accepted" };
    }, waking.withPermits(1)),

    control: Effect.fn("Engine.Registry.control")(function* (options: {
      readonly runId: string;
      readonly control: string;
      readonly set: boolean;
      readonly alone?: boolean;
      readonly reason?: string;
    }) {
      if (options.control === HOLD && (yield* hasEnded(options.runId)))
        return yield* new HostRefused({
          reason: "a finished Run has no step left to hold; stop closes its agents",
        });
      // A finished Run's status is history: a stop closes its live agents and sets nothing.
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
      // Resolved as the gate resolves it, so a check that could never run is refused now.
      if (options.command !== null) {
        const own = yield* treeOf(row, options.runId, dir);
        const at =
          options.command.cwd === "worktree"
            ? (own.worktree ?? own.cwd)
            : (yield* Path.Path).resolve(own.cwd, options.command.cwd);
        if (!(yield* insideRun(at, own)))
          return yield* new HostRefused({
            reason: `${REFUSED_INPUT}: check "${options.name}" would run in "${at}", which is not inside run ${options.runId}`,
          });
      }
      return yield* granting.withPermits(1)(
        Effect.gen(function* () {
          const kept = (yield* approvedOf(dir, options.runId)).filter(
            (spec) => spec.name !== options.name,
          );
          const next =
            options.command === null ? kept : [...kept, { name: options.name, ...options.command }];
          yield* fs.makeDirectory(evidenceDir(dir, options.runId), { recursive: true });
          yield* fs.writeFileString(approvedPath(dir, options.runId), encodeApproved(next));
          return next;
        }).pipe(Effect.orDie),
      );
    }),

    steer: Effect.fn("Engine.Registry.steer")(function* (options: {
      readonly runId: string;
      readonly text: string;
      readonly request: string;
      readonly to?: string;
      readonly operation?: string;
      readonly agent?: string;
      readonly mode?: AgentsSdk.DeliveryMode;
      readonly actor?: Asker;
    }) {
      // A row is enough: a finished Run's agents need its launch journal, not its module.
      if ((yield* store.run(options.runId)) === null) {
        return yield* new HostRefused({ reason: `no run "${options.runId}" was started here` });
      }
      const sent = yield* (yield* Agents).steer(options);
      return sent.gone === true ? { ...sent, finished: yield* hasEnded(options.runId) } : sent;
    }),

    tendQuestions: Effect.gen(function* () {
      const host = yield* Host;
      yield* (yield* Agents).tendQuestions((runId) => ({
        ask: (question, asker) => host.asking(runId, question, asker),
        asked: host.asked(runId),
        close: (decision, value) => host.close(runId, decision, value),
      }));
    }),
  } satisfies RegistryApi;
});

const decodeOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

/** Every child this Run started, however deep; an offer's Run has a request of its own. */
const descendantsOf = (rows: ReadonlyArray<RunRow>, runId: string): ReadonlyArray<string> => {
  const children = rows
    .filter((row) => row.parent === runId && row.request === row.run)
    .map((row) => row.run);
  return children.flatMap((child) => [child, ...descendantsOf(rows, child)]);
};

/**
 * Why a caller who named no question cannot be given one, or null where exactly one is
 * open. Nothing is guessed at: an answer landing on the wrong question is the mistake
 * this exists to prevent.
 */
const soleOpen = (runId: string, open: ReadonlyArray<OpenDecision>): HostRefused | null => {
  if (open.length === 1) return null;
  return new HostRefused({
    reason:
      open.length === 0
        ? `run "${runId}" is not waiting on a decision`
        : `run "${runId}" is waiting on ${open.map((one) => `"${one.name}"`).join(", ")}: say which`,
  });
};

const encodeCheckProject = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ extends: Schema.String, files: Schema.Array(Schema.String) }),
  ),
);

/**
 * The authoring setup, written as the files an author opens and edits rather than encoded
 * from a value: `paths` is what makes `collie` resolve to the declarations beside
 * it, and `effect` is pinned to the host's so the types are about the Effect that runs.
 */
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

/** Every file the toolchain puts beside a workflow directory, which is each Machine's own. */
export const TOOLCHAIN_NAMES: ReadonlyArray<string> = [
  ...Object.keys(TOOLCHAIN_FILES),
  SDK_FILE,
  "bun.lock",
  "node_modules",
];

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = Schema.is(JsonObject);
const readJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const writeJsonObject = Schema.encodeSync(Schema.fromJsonString(JsonObject, { space: 2 }));
const objectIn = (value: Schema.Json | undefined): Readonly<Record<string, Schema.Json>> =>
  isJsonObject(value) ? value : {};

/**
 * An author's package.json with what a module is typechecked against added where it is
 * missing, and the host's own Effect over any other: two Effects are two sets of types.
 */
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

/** An author's tsconfig.json with `collie` mapped to the declarations beside it. */
const mergedCompiler = (dir: string, tsconfig: Readonly<Record<string, Schema.Json>>) => {
  const options = objectIn(tsconfig.compilerOptions);
  const paths = objectIn(options.paths);
  // Paths resolve from baseUrl where one is set, so the mapping cannot be relative to it.
  const declarations = isText(options.baseUrl) ? `${dir}/collie.d.ts` : "./collie.d.ts";
  return {
    ...tsconfig,
    compilerOptions: { ...options, paths: { collie: [declarations], ...paths } },
  };
};

/**
 * Writes the authoring setup beside a workflow directory and installs its toolchain with
 * the embedded Bun, so a machine with neither Bun nor Node on it can still typecheck a
 * module. An existing package.json or tsconfig.json is the author's: what the setup needs
 * is merged into it and nothing of theirs is replaced.
 */
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
  // Collie's own, so an upgraded installation's declarations replace the last one's.
  yield* fs.writeFileString(`${dir}/${SDK_FILE}`, SDK_DECLARATIONS).pipe(Effect.orDie);
  const unmerged: string[] = [];
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
    if (merged !== existing.value) yield* fs.writeFileString(path, merged).pipe(Effect.orDie);
  }
  const installed = yield* runBun(dir, ["install"]).pipe(Effect.mapError(unavailable));
  if (installed.code !== 0) {
    return yield* unavailable(
      `cannot install the workflow toolchain in ${dir}: ${installed.output}`,
    );
  }
  if (unmerged.length > 0) {
    return yield* unavailable(
      `${unmerged.join(" and ")} in ${dir} is not plain JSON, so nothing was merged into it: add "effect" and "typescript" to package.json and map "collie" to ./collie.d.ts under compilerOptions.paths`,
    );
  }
  // A successful dry run or an install omitting dev dependencies is not a toolchain.
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

/**
 * Provisions again where the installed Effect is not the host's, as after an upgrade, so
 * a module is checked against the Effect it will run on. A directory with no Effect
 * installed is left alone.
 */
export const refreshToolchain = Effect.fn("Engine.refreshToolchain")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const installed = yield* fs
    .readFileString(`${dir}/node_modules/effect/package.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(InstalledPackage)), Effect.option);
  if (Option.isSome(installed) && installed.value.version !== TOOLCHAIN.effect) {
    yield* provisionToolchain(dir);
  }
});

/**
 * Typechecks one entry file against the provisioned toolchain and reports every
 * diagnostic with the source it is in. Errors in one file say nothing about another, so
 * a host checking several reports each on its own.
 */
export const typecheckEntry: (options: {
  readonly dir: string;
  readonly file: string;
}) => Effect.Effect<
  ReadonlyArray<string>,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Engine.typecheckEntry")(function* (options: {
  readonly dir: string;
  readonly file: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const compiler = `${options.dir}/node_modules/typescript/lib/tsc.js`;
  if (!(yield* fs.exists(compiler).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new ToolchainError({
      code: "toolchain_unavailable",
      message: `no typechecker in ${options.dir}; provision it while you have a network`,
    });
  }
  // One file at a time, through a project that extends the author's settings. Naming a
  // file on tsc's command line makes it ignore the tsconfig beside it, which would check
  // the module against defaults nobody wrote and report nothing useful.
  // A project of its own, so two checks in one directory never compile each other's file.
  const project = `${options.dir}/${CHECK_PROJECT}-${Bun.hash(options.file).toString(16)}.json`;
  yield* fs
    .writeFileString(
      project,
      encodeCheckProject({ extends: "./tsconfig.json", files: [options.file] }),
    )
    .pipe(Effect.orDie);
  const unavailable = (message: string) =>
    new ToolchainError({ code: "toolchain_unavailable", message });
  const ran = yield* runBun(options.dir, [
    "run",
    compiler,
    "--pretty",
    "false",
    "-p",
    project,
  ]).pipe(Effect.mapError(unavailable), Effect.ensuring(fs.remove(project).pipe(Effect.ignore)));
  if (ran.code === 0) return [];
  const diagnostics = ran.output.split("\n").filter((line) => /\(\d+,\d+\): error /.test(line));
  // tsc exits non-zero for the diagnostics it printed; a failure that printed none is the
  // toolchain's problem, not the module's, and must not read as a clean module.
  if (diagnostics.length === 0) {
    return yield* unavailable(
      `the typechecker exited ${ran.code} without checking: ${ran.output.trim()}`,
    );
  }
  return diagnostics;
});

/**
 * The embedded Bun. A compiled executable with `BUN_BE_BUN` set is the `bun` CLI, so
 * installing a package and running a compiler need neither Bun nor Node on the machine;
 * running from source, `execPath` is already Bun and the variable changes nothing.
 */
const runBun = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  { readonly code: number; readonly output: string },
  string,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "collie-bun-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        cwd,
        env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin", TMPDIR: tmp },
        // Registry credentials, proxy settings and package caches belong to the caller.
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const output = yield* collect(child.stdout).pipe(
      Effect.zipWith(collect(child.stderr), (out, err) => out + err),
    );
    return { code: Number(yield* child.exitCode), output };
  }).pipe(
    Effect.scoped,
    Effect.catch((cause) => Effect.fail(String(cause))),
  );

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      (): string => "",
      (all, chunk) => all + chunk,
    ),
  );
