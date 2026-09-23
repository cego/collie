// Effect's own workflow engine, proven from the compiled binary.
//
// A workflow lives in a TypeScript file outside this checkout. This module is what lets
// the packaged executable load one, give it the binary's own Effect rather than a second
// copy, and run it on ClusterWorkflowEngine over real SQLite — so a host that dies leaves
// completed work completed and a pending decision pending. Nothing here interprets a
// workflow: the module is code, and Effect executes it.
//
// `docs/adr/0014-native-workflows-run-on-effects-own-engine.md` records why each of the
// pieces below is upstream's rather than Collie's.

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import {
  Cause,
  Context,
  Crypto,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ConfigError } from "effect/Config";
import type { PlatformError } from "effect/PlatformError";
import { FetchHttpClient } from "effect/unstable/http";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as WorkflowModules from "effect/unstable/workflow";
import * as EffectRoot from "effect";
import * as Agents from "./agents";
import { NativeAgents } from "./agents";
import * as Sdk from "./sdk";
import {
  NativeChildren,
  NativeHost,
  RESERVED_INPUTS,
  WorkflowError,
  checkEntry,
  describeMetadata,
  jsonSchemaFor,
  type ChildAsk,
  type ChildRun,
  type ChildrenApi,
  type ActionFacts,
  type InputField,
  type InputFields,
  type WorkflowMetadata,
  type Registration,
  type WorkflowEntry,
} from "./sdk";
import { configValue, readConfig } from "./config";
import { currentEnv } from "./env";
import {
  HelleClaimSchema,
  HelleError,
  credentials,
  releaseClaim,
  waitForHelle,
  type HelleClaim,
} from "./helle";
import { Kept, describeKept, importHistory } from "./history";
import { currentPid, signalProcess } from "./lock";
import type { InputStrategy } from "./definitions";
import { noteVerification } from "./metrics";
import {
  gitlabForProject,
  gitlabReadiness,
  mrFacts,
  parseMrTarget,
  postNote,
  projectHere,
  shell as runShell,
} from "./mr";
import { openFindingsIn } from "./output";
import { planIssuesIn } from "./plan";
import { SELF, inputsFor, offersFrom, type Declared, type Offer } from "./offers";
import { isOutcome } from "./outcome";
import { History, RequestConflict, Store, storeLayer, type RunRow } from "./store";
import { repositoryName } from "./worktree";
import { approvedFrom, VerifySpecSchema, type VerifySpec } from "./verify-spec";
import {
  collect as collectVerification,
  fingerprint,
  readVerifications,
  type Verification,
} from "./verify";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

/** A module that cannot be loaded, named by its own file. Schema-backed, so the local
 *  host can fail a client with the same value rather than a copy of it. */
export class NativeEntryError extends Schema.TaggedError<NativeEntryError>()("NativeEntryError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** What a refusal says first where the input is why, which a front door reads back. */
export const REFUSED_INPUT = "invalid_input";

/** Anything else a host will not do, said in one sentence a caller can show. */
export class HostRefused extends Schema.TaggedError<HostRefused>()("HostRefused", {
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
 * `effect/unstable/workflow/Workflow` are the binary's objects as surely as `effect` is.
 */
const NAMESPACES = [
  ["effect", EffectRoot],
  ["effect/unstable/workflow", WorkflowModules],
] as const;

export const sdkModules = (): ReadonlyArray<readonly [string, object]> => {
  // Two files, one module: `sdk.ts` is what a module declares about itself and `agents.ts`
  // is what it does with an agent. They are apart because the second reaches for herdr
  // and the first must not, and an author has no reason to know that.
  const served: Array<readonly [string, object]> = [["collie/native", { ...Sdk, ...Agents }]];
  for (const [prefix, namespace] of NAMESPACES) {
    served.push([prefix, namespace]);
    for (const [name, member] of Object.entries(namespace))
      served.push([`${prefix}/${name}`, member]);
  }
  return served;
};

/** Kept in step with package.json, which `native.test.ts` checks: the host and an
 *  author's declarations have to be the same Effect, or the types are about another one. */
export const TOOLCHAIN = {
  effect: "4.0.0-rc.117",
  typescript: "^7.0.2",
} as const;

/**
 * The declarations an author typechecks `collie/native` against, kept in step with
 * `src/sdk.ts` by `native-sdk.test.ts` — which typechecks a module using the whole
 * surface, so a declaration that has drifted fails a test rather than an author's build.
 */
export const SDK_DECLARATIONS = `declare module "collie/native" {
  import type { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
  import type { DurableDeferred } from "effect/unstable/workflow/DurableDeferred";
  import type { Workflow } from "effect/unstable/workflow/Workflow";
  import type {
    WorkflowEngine,
    WorkflowInstance,
  } from "effect/unstable/workflow/WorkflowEngine";

  /** What this working tree was when a command ran on it. */
  export interface Snapshot {
    readonly head_sha: string;
    readonly fingerprint: string;
  }

  /** A command Collie watched, bound to the tree it ran on. Never an Output's claim. */
  export interface Verification {
    readonly name: string;
    readonly cwd: string;
    readonly start: Snapshot;
    readonly end: Snapshot;
    readonly exit: number;
    readonly expect: "pass" | "fail";
    readonly result: "pass" | "fail" | "unstable";
    readonly at: string;
    readonly by: "agent" | "collie";
  }

  /** What the journal holds and the tree in front of you, for checks to be read against. */
  export interface CheckEvidence {
    readonly verifications: ReadonlyArray<Verification>;
    readonly final: Snapshot;
  }

  /** A Run as the host admitted it: where it works, where its work belongs, what it was given. */
  export interface Place {
    readonly cwd: string;
    readonly dir: string;
    /** The host's own launch options — the RESERVED_INPUTS names — as a caller gave them. */
    readonly options: Readonly<Record<string, string>>;
  }

  /** What became of a note: whether it landed, and the sentence a human reads either way. */
  export interface Posted {
    readonly ok: boolean;
    readonly message: string;
  }

  /** One command a human approved Collie to run for this Run. */
  export interface VerifySpec {
    readonly name: string;
    readonly executable: string;
    readonly argv: ReadonlyArray<string>;
    readonly cwd: string;
  }

  /** What opening a merge request from here needs, and what it would be filled in with. */
  export interface MrReady {
    readonly ok: boolean;
    /** Why it cannot be done here. Empty where it can. */
    readonly reason: string;
    /** The configured assignee, else whoever glab is logged in as; empty for neither. */
    readonly assignee: string;
    /** The repository's merge request template, relative to the checkout; empty for none. */
    readonly template: string;
    readonly issues: ReadonlyArray<string>;
  }

  /** What the host lends a workflow. Hold and stop are read fresh on every replay. */
  export interface NativeHostApi {
    readonly dir: string;
    /** This Run as the host admitted it; its directory is made as this is answered. */
    readonly place: (runId: string) => Effect.Effect<Place>;
    readonly held: (runId: string) => Effect.Effect<boolean>;
    readonly stopRequested: (runId: string) => Effect.Effect<boolean>;
    readonly record: (runId: string, event: string) => Effect.Effect<void>;
    /** Why this Run parked its own work, shown beside its status; null clears it. */
    readonly parked: (runId: string, why: string | null) => Effect.Effect<void>;
    readonly asking: (runId: string, question: DecisionSpec) => Effect.Effect<void>;
    /** What has been verified for this run, and the tree in front of it now. */
    readonly evidence: (runId: string, cwd: string) => Effect.Effect<CheckEvidence>;
    /** Runs one approved command and records it. A name nobody approved is refused. */
    readonly verify: (options: {
      readonly runId: string;
      readonly name: string;
      readonly cwd: string;
      readonly expect?: "pass" | "fail";
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
    }) => Effect.Effect<Posted>;
    /** What this Run may have Collie run for it; a workflow cannot add to the list. */
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
     * Blocks until this Run holds the shared claim on the repository it works in, and
     * answers null where that repository has none. Waiting here costs wall clock and no
     * model tokens. adopting is asked only where the claim was already the operator's.
     */
    readonly claim: <E, R>(options: {
      readonly runId: string;
      readonly cwd: string;
      readonly adopting: Effect.Effect<boolean, E, R>;
      readonly say: (line: string) => Effect.Effect<void, E, R>;
    }) => Effect.Effect<{ readonly slug: string } | null, WorkflowError | E, R>;
    /** Gives the claim back. Only a Run that finished its work releases. */
    readonly release: (runId: string) => Effect.Effect<void>;
  }
  export const NativeHost: Context.Service<NativeHostApi, NativeHostApi>;
  export type NativeHost = NativeHostApi;

  /** How every native workflow reports a failure. */
  export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
    "WorkflowError",
    { reason: Schema.String },
  ) {}

  /** A workflow under Collie's envelope: the host supplies runId, you supply input. */
  export function defineWorkflow<
    Input extends Schema.Struct.Fields,
    Success extends Schema.Top,
  >(options: {
    readonly name: string;
    readonly input: Input;
    readonly success: Success;
  }): Workflow<
    string,
    Schema.Struct<{ runId: typeof Schema.String; input: Schema.Struct<Input> }>,
    Success,
    typeof WorkflowError
  >;

  /** A question as the host records it: its identity, what it asks, what it takes. */
  export interface DecisionSpec {
    readonly name: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }

  /** A decision a run waits on, answered with the text an operator types. */
  export interface NativeDecision extends DurableDeferred<typeof Schema.String> {
    readonly asks: DecisionSpec;
  }
  export function decision(
    name: string,
    asks?: { readonly prompt?: string; readonly options?: ReadonlyArray<string> },
  ): NativeDecision;

  /** Waits for this question to be answered, having told the host it is open. */
  export function ask(
    runId: string,
    question: NativeDecision,
    /** What it takes this time, where a menu offers less than it declares. */
    options?: ReadonlyArray<string>,
  ): Effect.Effect<string, never, NativeHost | WorkflowEngine | WorkflowInstance>;

  /** What a parent asks for when part of its own work is another workflow. */
  export interface ChildAsk {
    readonly runId: string;
    /** Stable within the parent: the same one twice is the same child. */
    readonly invocation: string;
    readonly workflow: string;
    readonly input: Readonly<Record<string, unknown>>;
    /** The host's own options for the child; only the host's own names are taken. */
    readonly options?: Readonly<Record<string, string>>;
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
  export const NativeChildren: Context.Service<ChildrenApi, ChildrenApi>;
  export type NativeChildren = ChildrenApi;

  /** One child workflow, started and waited on. */
  export function child(
    ask: ChildAsk,
  ): Effect.Effect<unknown, WorkflowError, NativeChildren>;

  export interface Registration {
    readonly workflow: Workflow<string, any, any, typeof WorkflowError>;
    /** The host's own services, and the file system and paths a module reads work from. */
    readonly layer: Layer.Layer<
      never,
      never,
      | WorkflowEngine
      | NativeHost
      | NativeAgents
      | NativeChildren
      | FileSystem.FileSystem
      | Path.Path
    >;
    readonly decisions: Readonly<Record<string, NativeDecision>>;
  }

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
  }

  /** Nobody can say whether the agent is there, so nothing was started. */
  export class AgentUncertain extends Schema.TaggedError<AgentUncertain>()(
    "AgentUncertain",
    { operation: Schema.String, reason: Schema.String },
  ) {}

  /** The agent's pane would not take its prompt for as long as that was worth waiting. */
  export class PromptRefused extends Schema.TaggedError<PromptRefused>()(
    "PromptRefused",
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
     * pane of whoever is live in that role, and otherwise to stop and ask the human.
     */
    readonly askRoute: (role: string, cwd: string) => Effect.Effect<string>;
    readonly launch: (ask: AgentAsk) => Effect.Effect<Launched, AgentUncertain | PromptRefused>;
    readonly collect: (
      launched: Launched,
      unless?: string | null,
    ) => Effect.Effect<string | null, AgentUncertain>;
    readonly repair: (
      launched: Launched,
      problem: string,
    ) => Effect.Effect<boolean, AgentUncertain | PromptRefused>;
    readonly steer: (options: {
      readonly runId: string;
      readonly text: string;
      readonly request: string;
      readonly operation?: string;
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
  }
  export const NativeAgents: Context.Service<AgentsApi, AgentsApi>;
  export type NativeAgents = AgentsApi;

  /** What you ask for: the work, not the steps it takes. */
  export interface AgentWork<Output extends OutputContract> {
    readonly runId: string;
    readonly operation: string;
    readonly cwd: string;
    readonly instructions: string;
    readonly output: Output;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly role?: string;
    /** The agent this work goes to, where several operations are one agent's list. */
    readonly agent?: string;
    readonly workflow?: string;
    /** The skill this work is started with, where the work is one a skill describes. */
    readonly skill?: string;
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly permissions?: "bypass" | "harness";
    /** What the instructions render beside the inputs, for Markdown that names its own. */
    readonly vars?: Readonly<Record<string, unknown>>;
  }

  /** One agent, once, and its Output as a value of your own type. */
  export function agentWork<Output extends OutputContract>(
    work: AgentWork<Output>,
  ): Effect.Effect<
    Output["Type"],
    WorkflowError,
    NativeAgents | NativeHost | WorkflowEngine | WorkflowInstance
  >;

  /** Everything a prompt is built from, none of which is an Activity. */
  export interface PromptParts {
    readonly role: string;
    readonly instructions: string;
    readonly output: string;
    readonly contract: Projection;
    readonly inputs?: Readonly<Record<string, unknown>>;
    readonly vars?: Readonly<Record<string, unknown>>;
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
  export type Source = "run-dir" | "plan-dir" | "diff-target" | "branch" | "merge-request";

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

  /** Data a card and a launch read; never anything a workflow body consults. */
  export interface WorkflowMetadata {
    readonly hints?: Readonly<Record<string, string>>;
    readonly outcome?: OutcomeContract;
    readonly followUps?: ReadonlyArray<FollowUp>;
    readonly actions?: ReadonlyArray<ActionProvider>;
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
    | { ok: false; halt: Halt; reasons: string[]; outstanding: Finding[] };

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

  /** Which of the three kinds of change a settled diff target names. */
  export function targetKind(target: string): "mr" | "branch" | "worktree" | "";

  /** The glab arguments that point a command at a project rather than at the cwd. */
  export function repoArgs(project: string | null): string[];

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
   * A Markdown file as the content it is: what stands above the first heading, and one
   * entry per "## name" section below it. Front matter is not content and is left out.
   */
  export function contentOf(markdown: string): {
    readonly preamble: string;
    readonly sections: ReadonlyMap<string, string>;
  };

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
  }

  /** The verification names a ticket's **Checks:** line promises. */
  export function checksIn(text: string): string[];

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
  ): Effect.Effect<PlanRepos, never, FileSystem.FileSystem | Path.Path>;

  /** Whether this plan is one repository and that repository is the run's own root. */
  export function isSingleRepo(plan: PlanRepos): boolean;

  /** The approved commands as a human would type them, for a prompt to name them. */
  export function renderApproved(approved: ReadonlyArray<VerifySpec>): string;

  /** What was actually collected, and by whom, for a merge request to say what it proved. */
  export function renderEvidence(
    got: { readonly verifications: ReadonlyArray<Verification>; readonly final: Snapshot },
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
    name: "collie-native-sdk",
    setup(build) {
      for (const [specifier, namespace] of sdkModules()) {
        // Spread rather than passed on: Bun's object loader takes a plain object, and
        // the values in it stay the very functions and keys the binary is running on.
        build.module(specifier, () => ({ exports: { ...namespace }, loader: "object" }));
      }
    },
  });
}

const EntryContract = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.optionalKey(Schema.Unknown),
});

/**
 * Imports a workflow entry file and holds it to the published contract. A module that
 * does not compile, does not exist, does not export the contract or contradicts itself
 * fails naming its own file — so one bad entry says which one it is and leaves every
 * other entry loadable.
 *
 * Importing runs the module's top level, which is the author's code — and deliberately
 * so, since `make` is a function it exports. It does not run a workflow body, acquire an
 * agent or open a worktree; nothing here is a sandbox. The metadata is checked here, at
 * load, which is why a contradiction never reaches a Run.
 */
export const loadEntry: (
  file: string,
  revision?: string,
) => Effect.Effect<WorkflowEntry, NativeEntryError> = Effect.fn("Native.loadEntry")(function* (
  file: string,
  revision?: string,
) {
  installSdk();
  // Bun's module registry has no invalidation, so an entry read twice at one path is the
  // first read both times. A revision in the specifier is a path nothing has imported.
  const loaded = yield* Effect.tryPromise({
    try: () => import(revision === undefined ? file : `${file}?v=${revision}`),
    catch: (cause) => new NativeEntryError({ file, message: String(cause) }),
  });
  const described = yield* Schema.decodeUnknownEffect(EntryContract)(loaded).pipe(
    Effect.mapError(
      () =>
        new NativeEntryError({
          file,
          message: "a workflow entry exports id, title, description and input",
        }),
    ),
  );
  if (!Predicate.isFunction(loaded.make)) {
    return yield* new NativeEntryError({
      file,
      message: "a workflow entry exports make(registrationName)",
    });
  }
  // SAFETY: the contract above decoded and `make` is a function. What the author's
  // schemas and metadata hold is checked next, and what `make` returns is checked when
  // the host builds its Layer.
  const entry = { ...described, make: loaded.make } as WorkflowEntry;
  const problems = checkEntry(entry);
  if (problems.length > 0) {
    return yield* new NativeEntryError({ file, message: problems.join("; ") });
  }
  return entry;
});

/**
 * What a generation of an entry would be staged from, as one value. A generation is a copy
 * of the whole directory, so an edited helper or Markdown prompt is as much a change as an
 * edited entry — and a directory nothing has touched is the same code to run.
 */
export const revisionOf: (dir: string) => Effect.Effect<string, never, FileSystem.FileSystem> =
  Effect.fn("Native.revisionOf")(function* (dir: string) {
    const fs = yield* FileSystem.FileSystem;
    const names = yield* fs
      .readDirectory(dir, { recursive: true })
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    let read = "";
    for (const name of names.sort()) {
      // A directory reads as nothing, and what is inside it is in the list under a name
      // of its own. An installed dependency counts by its name alone: the toolchain a
      // module is typechecked against lives here too, and reading all of it would cost
      // more than every start it is on the way of.
      const content = name.startsWith("node_modules/")
        ? ""
        : yield* fs.readFileString(`${dir}/${name}`).pipe(Effect.orElseSucceed(() => ""));
      read += `${name}:${Bun.hash(content).toString(16)}\n`;
    }
    return Bun.hash(read).toString(16);
  });

/**
 * A generation's own copy of the directory the entry lives in, so an edited helper reaches
 * new work without restarting the host. Bun's module registry has no invalidation:
 * re-importing the entry under a new query re-reads the entry, but its `./helper.ts`
 * resolves to the path already cached. A copy gives every file a path nothing has
 * imported yet. It is a cache — a host wipes it on start and stages from the module as it
 * is now, so this is never the code a past run is recovered onto.
 */
export const stageGeneration: (options: {
  readonly dir: string;
  readonly name: string;
  readonly entry: string;
}) => Effect.Effect<string, NativeEntryError, FileSystem.FileSystem> = Effect.fn(
  "Native.stageGeneration",
)(function* (options: { readonly dir: string; readonly name: string; readonly entry: string }) {
  const fs = yield* FileSystem.FileSystem;
  const slash = options.entry.lastIndexOf("/");
  const from = options.entry.slice(0, slash);
  const staged = `${options.dir}/generations/${options.name}`;
  yield* fs
    .copy(from, staged, { overwrite: true })
    .pipe(
      Effect.mapError(
        (cause) => new NativeEntryError({ file: options.entry, message: String(cause) }),
      ),
    );
  return `${staged}${options.entry.slice(slash)}`;
});

const directoryOf = (file: string) => file.slice(0, file.lastIndexOf("/"));

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
export function hostLayer(options: {
  readonly dir: string;
  readonly registrationTimeout?: Duration.Input;
}): Layer.Layer<
  WorkflowEngine.WorkflowEngine | SqlClient.SqlClient | Reactivity.Reactivity,
  ConfigError
> {
  // One connection, two halves: the engine's own tables and the rows Collie keeps beside
  // them are in the same file, written by the same process.
  const sql = SqliteClient.layer({ filename: `${options.dir}/native.db` }).pipe(
    Layer.provideMerge(Reactivity.layer),
  );
  const cluster = SingleRunner.layer({
    shardingConfig: {
      // A host told to stop must not take a running workflow down with it: the work
      // finishes its step, and what is left is picked up by the next host.
      preemptiveShutdown: false,
      // A workflow whose module is missing has no entity to receive its messages. The
      // default marks them failed after a minute, which turns "the file is not there
      // yet" into a terminal result; waiting is what lets a repair recover the work.
      entityRegistrationTimeout: options.registrationTimeout ?? Duration.infinity,
    },
  }).pipe(Layer.provide([sql, BunCrypto.layer]));
  return ClusterWorkflowEngine.layer.pipe(Layer.provide(cluster), Layer.provideMerge(sql));
}

export const HOLD = "hold";
export const STOP = "stop";
/** Not a control: the Run's own word on why it parked, which only the Run writes. */
export const PARKED = "parked";

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
 * Where one native Run's evidence lives: the verification journal `verify.ts` writes and
 * reads, and the approved set the Run was started under. A directory rather than a table
 * because the collector is the same one the command line uses — what proves a Run is not
 * a different thing for being a module's.
 */
export const evidenceDir = (dir: string, runId: string): string => `${dir}/evidence/${runId}`;

/**
 * Where one native Run's own work belongs: the plan it wrote, the review it left, and
 * anything else a card reads back. A directory per Run rather than a column, because what
 * a Run produces is files and the things that read them are ordinary readers of files.
 */
export const runDir = (dir: string, runId: string): string => `${dir}/runs/${runId}`;

const approvedPath = (dir: string, runId: string) => `${evidenceDir(dir, runId)}/approved.json`;

const ApprovedJson = Schema.fromJsonString(Schema.Array(VerifySpecSchema));
const decodeApproved = Schema.decodeUnknownEffect(ApprovedJson);
const encodeApproved = Schema.encodeSync(ApprovedJson);

/**
 * What this Run may have Collie run for it, as it was when the Run started. Frozen at
 * admission, so editing the file changes the next Run and never a live one.
 */
export const freezeApproved = Effect.fn("Native.freezeApproved")(function* (options: {
  readonly dir: string;
  readonly runId: string;
  readonly project: string;
  readonly configDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = approvedPath(options.dir, options.runId);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return;
  const approved = yield* approvedFrom({
    cwd: options.project,
    configDir: options.configDir,
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => []));
  yield* fs.makeDirectory(evidenceDir(options.dir, options.runId), { recursive: true });
  yield* fs.writeFileString(path, encodeApproved(approved));
});

const approvedOf = Effect.fn("Native.approvedOf")(function* (dir: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const none: ReadonlyArray<VerifySpec> = [];
  const text = yield* fs
    .readFileString(approvedPath(dir, runId))
    .pipe(Effect.orElseSucceed(() => "[]"));
  return yield* decodeApproved(text).pipe(Effect.orElseSucceed(() => none));
});

/** Where a host keeps what a Run claimed, so a resume knows whose the claim was. */
const claimPath = (dir: string, runId: string) => `${runDir(dir, runId)}/helle.json`;

const decodeClaim = Schema.decodeUnknownEffect(Schema.fromJsonString(HelleClaimSchema));
const encodeClaim = Schema.encodeSync(Schema.fromJsonString(HelleClaimSchema));

/** What this Run already claimed, and null where it has claimed nothing yet. */
const recordedClaim = (
  file: string,
): Effect.Effect<HelleClaim | null, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.flatMap(decodeClaim),
    Effect.orElseSucceed((): HelleClaim | null => null),
  );

export const nativeHostLayer = (options: {
  readonly dir: string;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly configDir?: string;
}): Layer.Layer<
  NativeHost,
  never,
  Store | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(NativeHost)(
    Effect.gen(function* () {
      const dir = options.dir;
      const fs = yield* FileSystem.FileSystem;
      const store = yield* Store;
      // Captured, so a workflow asks for a verification without asking for a filesystem.
      type Collecting = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;
      const services = yield* Effect.context<Collecting>();
      const under = <A, E>(effect: Effect.Effect<A, E, Collecting>) =>
        Effect.provideContext(effect, services);
      const set = (control: string, runId: string) =>
        fs.exists(controlPath(dir, control, runId)).pipe(Effect.orElseSucceed(() => false));
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
      return NativeHost.of({
        dir,
        place: (runId) =>
          under(
            store.run(runId).pipe(
              Effect.flatMap((row): Effect.Effect<Record<string, string>> =>
                row === null
                  ? Effect.succeed({})
                  : decodeStrings(row.options ?? "{}").pipe(
                      Effect.map((options) => ({
                        ...options,
                        workspace: options.workspace ?? row.project,
                      })),
                      Effect.orElseSucceed(() => ({ workspace: row.project })),
                    ),
              ),
              // A Run nobody has a row for works nowhere in particular; its own directory
              // is still its own, so what it writes is not written into somebody else's.
              // Made for a Run there is one, so a workflow writes what it produces into
              // its own directory without first asking whether it is there — and asking
              // about a run that was never started leaves nothing behind.
              Effect.tap((options) =>
                "workspace" in options
                  ? fs.makeDirectory(runDir(dir, runId), { recursive: true })
                  : Effect.void,
              ),
              Effect.map((options) => ({
                cwd: options.workspace ?? dir,
                dir: runDir(dir, runId),
                options,
              })),
              Effect.orElseSucceed(() => ({ cwd: dir, dir: runDir(dir, runId), options: {} })),
            ),
          ),
        held: (runId) => set(HOLD, runId),
        stopRequested: (runId) => set(STOP, runId),
        record: (runId, event) =>
          fs
            .writeFileString(`${dir}/events.${runId}.log`, `${event}\n`, { flag: "a" })
            .pipe(Effect.orDie),
        parked: (runId, why) => {
          const path = controlPath(dir, PARKED, runId);
          return (
            why === null ? fs.remove(path, { force: true }) : fs.writeFileString(path, why)
          ).pipe(Effect.orDie);
        },
        asking: (runId, question) =>
          store.asking({
            run: runId,
            decision: question.name,
            prompt: question.prompt,
            options: question.options,
          }),
        evidence: (runId, cwd) =>
          under(
            Effect.all({
              verifications: readVerifications(evidenceDir(dir, runId)).pipe(
                Effect.orElseSucceed((): ReadonlyArray<Verification> => []),
              ),
              final: fingerprint(cwd),
            }),
          ).pipe(Effect.orDie),
        verify: (asked) =>
          under(
            approvedOf(dir, asked.runId).pipe(
              Effect.flatMap((approved) => {
                const spec = approved.find((entry) => entry.name === asked.name);
                if (spec === undefined) {
                  return Effect.fail(
                    new WorkflowError({
                      reason: `"${asked.name}" is not among this Run's approved verifications`,
                    }),
                  );
                }
                const journal = evidenceDir(dir, asked.runId);
                return collectVerification(journal, {
                  run: asked.runId,
                  name: spec.name,
                  executable: spec.executable,
                  argv: spec.argv,
                  cwd: asked.cwd,
                  by: "collie",
                  expect: asked.expect ?? "pass",
                }).pipe(
                  Effect.tap((record) => noteVerification(journal, record)),
                  Effect.mapError((refused) => new WorkflowError({ reason: refused.why })),
                );
              }),
            ),
          ),
        approved: (runId) => under(approvedOf(dir, runId)),
        config: (dotted) =>
          under(
            readConfig(options.configDir ?? dir).pipe(
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
              const project = parseMrTarget(asked.target ?? "")?.project ?? null;
              const ready = yield* asked.target === undefined
                ? gitlabReadiness(asked.cwd, runShell)
                : gitlabForProject(project, asked.cwd, runShell);
              if (!ready.ok) {
                return { ok: false, reason: ready.reason, assignee: "", template: "", issues: [] };
              }
              const facts = yield* mrFacts(
                {
                  cwd: asked.cwd,
                  inputs: {
                    source: asked.source?.value ?? "",
                    source_kind: asked.source?.kind ?? "",
                  },
                  strategies: { source: "work-source" },
                  configuredAssignee: configValue(
                    yield* readConfig(options.configDir ?? dir),
                    "gitlab.assignee",
                  ),
                },
                runShell,
              );
              return {
                ok: true,
                reason: "",
                assignee: facts.assignee ?? "",
                template: facts.template ?? "",
                issues: facts.issues,
              };
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
        claim: <E, R>(asked: {
          readonly runId: string;
          readonly cwd: string;
          readonly adopting: Effect.Effect<boolean, E, R>;
          readonly say: (line: string) => Effect.Effect<void, E, R>;
        }): Effect.Effect<{ readonly slug: string } | null, WorkflowError | E, R> =>
          Effect.gen(function* () {
            const env = yield* currentEnv.pipe(Effect.orDie);
            const file = claimPath(dir, asked.runId);
            return yield* waitForHelle({
              home: env.home,
              envFile: env.raw.HELLE_ENV_FILE ?? null,
              gitlabPath: yield* projectHere(asked.cwd, runShell),
              // git's repository, never the checkout's basename: a roaming Run's directory
              // is named after the workflow, and a Helle project under that name is a
              // project that does not exist for a repository that has one.
              repoName:
                (yield* repositoryName(runShell, asked.cwd)) ??
                (yield* Path.Path).basename(asked.cwd),
              claimed: yield* recordedClaim(file),
              record: (claim) => fs.writeFileString(file, encodeClaim(claim)).pipe(Effect.orDie),
              out: asked.say,
              // The question is the workflow's, so it is durable and asked once; this only
              // turns the answer into the word the gate reads.
              ask: () => asked.adopting.pipe(Effect.map((yes) => (yes ? "yes" : null))),
            });
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.provideContext(services),
            // Helle refusing to answer is this Run being unable to take the claim; the
            // author's own failures pass through untouched.
            Effect.mapError((cause: HelleError | E) =>
              cause instanceof HelleError ? new WorkflowError({ reason: cause.message }) : cause,
            ),
          ),
        release: (runId) =>
          Effect.gen(function* () {
            const env = yield* currentEnv.pipe(Effect.orDie);
            const file = claimPath(dir, runId);
            const held = yield* recordedClaim(file);
            if (held === null) return;
            yield* credentials({ home: env.home, envFile: env.raw.HELLE_ENV_FILE ?? null }).pipe(
              Effect.flatMap((creds) => releaseClaim(creds, held.slug)),
              Effect.provide(FetchHttpClient.layer),
            );
            yield* fs.remove(file, { force: true });
          }).pipe(Effect.provideContext(services), Effect.ignore),
        post: (asked) =>
          under(
            fs.readFileString(asked.file).pipe(
              Effect.flatMap((body) =>
                postNote({ target: asked.target, cwd: asked.cwd, body }, runShell),
              ),
              Effect.orElseSucceed(() => ({
                ok: false,
                message: `there is no ${asked.file} to post`,
              })),
            ),
          ),
      });
    }),
  );

/**
 * What the fixture host takes and what it says back, one JSON line each way. It lives
 * here rather than in the command so a test drives the host through the same contract the
 * host answers on, instead of a copy of it that can drift.
 */
export const HostRequest = Schema.Union([
  Schema.Struct({ op: Schema.Literal("ping") }),
  Schema.Struct({ op: Schema.Literal("load"), entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("registrations") }),
  // The author's own input, undecoded here: the workflow's schema is what settles it,
  // and it does so before a run exists rather than after one has started.
  Schema.Struct({
    op: Schema.Literal("start"),
    id: Schema.String,
    runId: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({ op: Schema.Literal("poll"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({
    op: Schema.Literal("answer"),
    id: Schema.String,
    runId: Schema.String,
    /** Null means the one question this run is waiting on. */
    decision: Schema.NullOr(Schema.String),
    value: Schema.String,
    /** The claim this answer arrives under, so the same one twice is one answer. */
    request: Schema.optional(Schema.String),
  }),
  Schema.Struct({ op: Schema.Literal("waiting"), runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("hold"), runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("release"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("stop"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("resume"), id: Schema.String, runId: Schema.String }),
  Schema.Struct({ op: Schema.Literal("provision"), dir: Schema.String }),
  Schema.Struct({ op: Schema.Literal("check"), dir: Schema.String, entry: Schema.String }),
  Schema.Struct({ op: Schema.Literal("metadata"), id: Schema.String }),
]);

export const HostReply = Schema.Struct({
  ok: Schema.Boolean,
  op: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  registration: Schema.optionalKey(Schema.String),
  registrations: Schema.optionalKey(Schema.Array(Schema.String)),
  status: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
  diagnostics: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What a module declares about itself, as a card and a launch would read it. */
  metadata: Schema.optionalKey(Schema.Json),
});

/**
 * The next generation of an entry: opaque, distinct, and never a name already used. A
 * workflow's native registration name is the tag its executions are stored under, so a run
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
): Effect.Effect<void, NativeEntryError, WorkflowEngine.WorkflowEngine> => {
  const decision = registration.decisions[options.name];
  if (!decision) {
    return new NativeEntryError({
      file: registration.workflow._tag,
      message: `no decision called "${options.name}"`,
    });
  }
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
  Schema.Struct({ status: Schema.Literal("complete"), value: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String, entry: Schema.String }),
]);

export const pollStatus = (
  result: Option.Option<Workflow.Result<unknown, unknown>>,
  entry: string,
): typeof RunStatus.Type => {
  if (Option.isNone(result)) return { status: "pending" };
  const value = result.value;
  if (value._tag === "Suspended") return { status: "suspended" };
  if (Exit.isSuccess(value.exit)) return { status: "complete", value: String(value.exit.value) };
  return { status: "failed", reason: reasonOf(value.exit.cause), entry };
};

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
}

/** Where a settled value came from: already typed, or as text a human wrote. */
export const GIVEN = "given";
export const TYPED = "typed";

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
    provenance[name] = TYPED;
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
});

/** What became of one delivery to a run's agent. */
export const Steered = Schema.Struct({
  agent: Schema.String,
  /** What could be got out of herdr about it, never "it was accepted for sending". */
  delivered: Schema.Boolean,
  detail: Schema.String,
});

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

export const RunView = Schema.Struct({
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
  options: Schema.Record(Schema.String, Schema.String),
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
});
export type RunView = typeof RunView.Type;

/** What the status of a run reads as, for comparing one poll with the last. */
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(RunStatus));

/**
 * How often a host asks the engine about work it has not finished. One fiber does it for
 * every client, so watching costs the same whether nobody or the whole board is looking.
 */
const SWEEP_INTERVAL = "500 millis";

/** How long a woken run is given to settle before a caller is told it was woken. */
const WAKE_INTERVAL = "250 millis";
const WAKE_TRIES = 8;

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
  /** The file and the revision this was built from: what makes a later start the same code. */
  readonly source: string;
  readonly metadata: Schema.Json;
  /** What a finished Run of this module offers next, with the author's own eligibility. */
  readonly offers: ReadonlyArray<Declared>;
  readonly registration: Registration;
}

/** What the registry's own work takes, which is what a host holds already. */
export type HostServices =
  | WorkflowEngine.WorkflowEngine
  | NativeHost
  | NativeAgents
  | FileSystem.FileSystem
  | Path.Path;

/**
 * Which modules a host holds and what it does with them, in front of one state directory.
 * Both hosts run on this, so the rule that a run stays on the generation it started on is
 * decided once rather than twice.
 *
 * Registrations are built in the scope the registry is built in — the host's — so they
 * outlive whichever client asked for one and are finalized when the host goes.
 */
export interface RegistryApi {
  readonly load: (entry: string) => Effect.Effect<Generation, NativeEntryError, HostServices>;
  /**
   * The generation new work goes to: the one already built from this file at this
   * revision, or a new one. An edit is therefore a new generation and an unchanged file is
   * not, without either being asked for.
   */
  readonly use: (options: {
    readonly entry: string;
    readonly revision: string;
  }) => Effect.Effect<Generation, NativeEntryError, HostServices>;
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
  readonly start: (options: {
    readonly generation: Generation;
    readonly request: string;
    readonly project: string;
    readonly runId?: string;
    /** What the caller said, in the two halves a front door keeps apart. */
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly text?: Readonly<Record<string, string>>;
    /** The host's own launch options, which never reach the author's payload. */
    readonly options?: Readonly<Record<string, string>>;
    /** What this work belongs to: a Task, and the run it came out of. */
    readonly task?: string | null;
    readonly parent?: string | null;
  }) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
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
  }) => Effect.Effect<typeof Answered.Type, HostRefused, HostServices>;
  /** Sets or clears one durable control over one run, and says whether it reached it. */
  readonly control: (options: {
    readonly runId: string;
    readonly control: string;
    readonly set: boolean;
  }) => Effect.Effect<typeof Controlled.Type, HostRefused, HostServices>;
  /** Says something to the agent this run has, through the one sender. */
  readonly steer: (options: {
    readonly runId: string;
    readonly text: string;
    /** The caller's claim on the delivery, so the same message twice is one message. */
    readonly request: string;
    readonly operation?: string;
    readonly mode?: Agents.DeliveryMode;
  }) => Effect.Effect<typeof Steered.Type, HostRefused, HostServices>;
  /** Every question this run has been asked, answered or not, oldest first. */
  readonly waiting: (runId: string) => Effect.Effect<ReadonlyArray<OpenDecision>>;
  /** One run as a front door shows it, or null where nothing was admitted under that id. */
  readonly view: (runId: string) => Effect.Effect<RunView | null>;
  /** Every run this host has rows for, newest last, narrowed to one Task where named. */
  readonly views: (task: string | null) => Effect.Effect<ReadonlyArray<RunView>>;
  /** The same run, again, whenever anything about it changes. */
  readonly watch: (runId: string) => Stream.Stream<RunView | null>;
  /**
   * The Runs the old engine recorded, imported once and readable ever after. They are
   * history and nothing else: none of them can be answered, controlled or resumed, and
   * the only thing to do with one is start a new Run of the same workflow.
   */
  readonly history: (task: string | null) => Effect.Effect<ReadonlyArray<typeof History.Type>>;
  /**
   * Reads whatever the old engine left that is not a row yet, and says what happened to
   * each directory. A host does this once when it starts; this is the same pass on
   * demand, for an installer that wants to show the operator what it found.
   */
  readonly importing: Effect.Effect<
    ReadonlyArray<typeof Kept.Type>,
    never,
    HostServices | ChildProcessSpawner.ChildProcessSpawner | Store
  >;
  /**
   * Rebuilds what this host could not register from the modules as they are now and hands
   * over anything still outstanding. A repaired file is picked up without a restart.
   */
  readonly recover: Effect.Effect<typeof Registrations.Type, never, HostServices>;
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
  }) => Effect.Effect<Admitted, HostRefused | RequestConflict, HostServices>;
  /** The generation a run is on and the execution it was admitted as. */
  readonly routed: (
    runId: string,
  ) => Effect.Effect<{ readonly generation: Generation; readonly execution: string }, HostRefused>;
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
 * yet written. Only `collie native` sets one, and only a test asks it to.
 */
export type CrashPoint = "admitted" | "executed";

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
export class Registry extends Context.Service<Registry, RegistryApi>()("collie/native/Registry") {}

export interface RegistryOptions {
  readonly crashAt?: CrashPoint;
  readonly locate?: Locate;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly configDir?: string;
}

export const registryLayer = (
  dir: string,
  options?: RegistryOptions,
): Layer.Layer<
  Registry,
  never,
  HostServices | Store | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Registry)(makeRegistry(dir, options));

/**
 * One host's foundation: the engine, the rows beside it, and the run's own view of its
 * controls and questions. Composed here so there is one SQLite client and one Store
 * behind all three, rather than a second connection reading what the first wrote.
 */
export const foundationLayer = (options: {
  readonly dir: string;
  readonly registrationTimeout?: Duration.Input;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly configDir?: string;
}): Layer.Layer<
  NativeHost | Store | WorkflowEngine.WorkflowEngine | SqlClient.SqlClient | Reactivity.Reactivity,
  ConfigError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  nativeHostLayer({ dir: options.dir, configDir: options.configDir }).pipe(
    Layer.provideMerge(storeLayer.pipe(Layer.provideMerge(hostLayer(options)))),
  );

const makeRegistry: (
  dir: string,
  options?: RegistryOptions,
) => Effect.Effect<
  RegistryApi,
  never,
  HostServices | Store | Crypto.Crypto | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Native.makeRegistry")(function* (dir: string, options?: RegistryOptions) {
  const crashAt = options?.crashAt;
  const locate = options?.locate;
  const configDir = options?.configDir ?? dir;
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const fs = yield* FileSystem.FileSystem;
  const store = yield* Store;
  const crypto = yield* Crypto.Crypto;
  const hostScope = yield* Effect.scope;
  /** Every generation this host is holding, by its native registration name. */
  const live = new Map<string, Generation>();
  /** Why a recorded generation is not holdable, so a caller hears the file, not a timeout. */
  const unavailable = new Map<string, string>();
  /** Which generation of an id new work goes to. */
  const newestOf = new Map<string, string>();
  let known = yield* store.generations;
  // Staged copies last only as long as this host: every generation below is staged from
  // the module as it is now, never restored.
  yield* clearGenerations(dir);
  // What the old engine left in directories, read into rows once. Here because a host
  // is the one owner of this state directory: an import that ran anywhere else would be
  // a second writer, and one that ran on every command would be a read adapter by
  // another name. Idempotent, so every start after the first keeps nothing.
  yield* importHistory(dir).pipe(
    Effect.flatMap((kept) =>
      Effect.forEach(
        kept.filter((item) => item.kind !== "already"),
        (item) => Effect.logInfo(`history: ${describeKept(item)}`),
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(`history: nothing was imported: ${Cause.pretty(cause)}`),
    ),
  );

  const register = Effect.fn("Native.register")(function* (route: {
    readonly workflow: string;
    readonly name: string;
    readonly entry: string;
  }) {
    const entry = yield* stageGeneration({ dir, name: route.name, entry: route.entry }).pipe(
      Effect.flatMap(loadEntry),
    );
    const registration = entry.make(route.name);
    // The composition root, and the only place a host binds anything into a module's
    // own Layer: explicitly provided to this generation, never a table something looks
    // itself up in. Everything else the module needs it provides for itself.
    yield* Layer.buildWithScope(
      registration.layer.pipe(Layer.provide(Layer.succeed(NativeChildren)(children))),
      hostScope,
    );
    const generation: Generation = {
      id: route.workflow,
      name: route.name,
      title: entry.title,
      entry: route.entry,
      fields: entry.input,
      hints: entry.metadata?.hints ?? {},
      fixedOutcome: entry.metadata?.outcome?.fixed ?? null,
      source: yield* sourceOf(route.entry),
      metadata: describeMetadata(entry.metadata),
      offers: declaredByModule(entry.metadata),
      registration,
    };
    live.set(route.name, generation);
    unavailable.delete(route.name);
    newestOf.set(route.workflow, route.name);
    return generation;
  });

  /**
   * The host's own services, under whatever the caller already has. A child is executed
   * on the parent's fiber, and merging this way is what leaves the parent's workflow
   * instance and scope in place — which is the whole linkage between the two.
   */
  const hostServices = yield* Effect.context<HostServices>();
  const lending = <A, E>(effect: Effect.Effect<A, E, HostServices>): Effect.Effect<A, E> =>
    Effect.updateContext(effect, (caller: Context.Context<never>) =>
      Context.merge(hostServices, caller),
    );

  /** A child's run id: its parent's, and what the parent called this invocation. */
  const childRunId = (ask: ChildAsk) => `${ask.runId}.${ask.invocation}`;

  const refused = (reason: string) => new WorkflowError({ reason });

  /**
   * Another workflow, as part of this one. Selected in the parent's own project and
   * decoded against the child's own schema before a row exists, so input the child will
   * not take is the parent's failure rather than a half-made Run.
   */
  const children: ChildrenApi = {
    start: (ask: ChildAsk) => lending(admitChild(ask)),
    result: (child: ChildRun) => lending(runChild(child)),
  };

  const admitChild = Effect.fn("Native.children.start")(function* (ask: ChildAsk) {
    const parent = yield* store.run(ask.runId);
    if (parent === null) {
      return yield* refused(`no run "${ask.runId}" was started here`);
    }
    const generation = yield* resolve({ project: parent.project, id: ask.workflow }).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const runId = childRunId(ask);
    // The host's own options, held to the same rule a front door's are: a name that is
    // not the host's would be a field the child's author never declared.
    const asked = ask.options ?? {};
    yield* refuseOptions(generation, asked).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const settled = yield* settleInput(generation.fields, { json: ask.input, text: {} }).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const payload = yield* Schema.decodeUnknownEffect(
      generation.registration.workflow.payloadSchema,
    )({ runId, input: settled.input }).pipe(
      Effect.mapError((cause) => refused(`${REFUSED_INPUT}: ${cause.message}`)),
    );
    const claimed = yield* store
      .admit({
        // The invocation is the claim, so replaying the parent admits nothing new and
        // changing what an invocation is given is refused rather than run twice.
        request: runId,
        run: runId,
        workflow: generation.id,
        project: parent.project,
        input: settled.input,
        provenance: settled.provenance,
        options: launchOptions(generation, asked),
        generation: generation.name,
        execution: yield* generation.registration.workflow.executionId(payload),
        task: parent.task,
        parent: ask.runId,
      })
      .pipe(Effect.mapError((conflict) => refused(conflict.reason)));
    remember(claimed.row);
    // A child is a Run, so what it may verify is frozen with it rather than read when
    // it asks: the same list, and the same moment, as the start of any other.
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: parent.project,
      configDir,
    }).pipe(Effect.ignore);
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

  const runChild = Effect.fn("Native.children.result")(function* (child: ChildRun) {
    const found = yield* routed(child.runId).pipe(
      Effect.mapError((failure) => refused(failure.reason)),
    );
    const row = yield* store.run(child.runId);
    if (row === null) return yield* refused(`no run "${child.runId}" was started here`);
    const payload = yield* payloadOf(found.generation, row).pipe(
      Effect.mapError(() => refused(`${found.generation.entry} no longer takes ${row.input}`)),
    );
    // Executed on the parent's own fiber, which is what links the two: the engine
    // reads the parent's instance from here, so the child's completion wakes the
    // parent and interrupting the parent reaches the child.
    return yield* found.generation.registration.workflow.execute(payload);
  });

  // What was registered before this host existed, rebuilt from the modules as they are
  // now. A file that has gone leaves its generation unavailable and every other one
  // registered, which is what keeps one broken module from stopping the rest.
  for (const route of known) {
    yield* register(route).pipe(
      Effect.catchTag("NativeEntryError", (failure) =>
        Effect.sync(() => unavailable.set(route.name, `${failure.file}: ${failure.message}`)),
      ),
    );
  }

  /** A host dying where the proof needs one to; nothing else ever sets this. */
  const crash = (point: CrashPoint) =>
    crashAt === point
      ? currentPid.pipe(
          Effect.flatMap((pid) => signalProcess(pid, "SIGKILL")),
          Effect.asVoid,
        )
      : Effect.void;

  const payloadOf = (generation: Generation, row: RunRow) =>
    decodeInput(row.input).pipe(
      Effect.flatMap((input) =>
        Schema.decodeUnknownEffect(generation.registration.workflow.payloadSchema)({
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
  const handOver = Effect.fn("Native.handOver")(function* (row: RunRow) {
    const generation = live.get(row.generation);
    if (generation === undefined) return;
    const payload = yield* payloadOf(generation, row).pipe(Effect.result);
    if (payload._tag === "Failure") return;
    yield* crash("admitted");
    yield* engine
      .execute(generation.registration.workflow, {
        executionId: row.execution,
        payload: payload.success,
        discard: true,
      })
      .pipe(Effect.orDie);
    yield* crash("executed");
    yield* store.accepted(row.run);
  });

  // What a host admitted and did not live to hand over. Both crash windows end here.
  for (const row of yield* store.pending) yield* handOver(row);

  /** The file a generation was built from, which a row keeps naming after it has gone. */
  const entryOf = (name: string) => known.find((route) => route.name === name)?.entry ?? "";

  const viewOf = Effect.fn("Native.viewOf")(function* (row: RunRow) {
    const input = yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({})));
    const admitted = {
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
    const outcome = admitted.options.outcome ?? UNSPECIFIED;
    const generation = live.get(row.generation);
    const about = {
      ...admitted,
      outcome,
      created: row.admitted,
      waiting: yield* asked(row.run),
      controls: yield* controlsOf(row.run),
      parked: yield* fs
        .readFileString(controlPath(dir, PARKED, row.run))
        .pipe(Effect.orElseSucceed(() => null)),
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
    const result = yield* engine.poll(generation.registration.workflow, row.execution);
    return { ...about, status: pollStatus(result, generation.entry), diagnostic: null };
  });

  const setControl = Effect.fn("Native.setControl")(function* (
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
  const controlsOf = Effect.fn("Native.controlsOf")(function* (runId: string) {
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
  const wake = Effect.fn("Native.wake")(function* (found: {
    readonly generation: Generation;
    readonly execution: string;
  }) {
    const workflow = found.generation.registration.workflow;
    yield* engine.resume(workflow, found.execution);
    yield* engine.poll(workflow, found.execution).pipe(
      Effect.map((result) => pollStatus(result, found.generation.entry).status),
      Effect.flatMap((status) =>
        status === "pending" ? Effect.fail(new Error("still running")) : Effect.void,
      ),
      Effect.retry({ times: WAKE_TRIES, schedule: Schedule.spaced(WAKE_INTERVAL) }),
      Effect.ignore,
    );
  });

  /** Every question this run has been asked, with the answers its options allow. */
  const asked = Effect.fn("Native.asked")(function* (runId: string) {
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
      const status = (yield* viewOf(entry.row)).status;
      const said = encodeStatus(status);
      if (said === entry.said) continue;
      entry.said = said;
      changed = true;
      // A run the engine has finished with cannot change again, so nothing asks after.
      if (status.status === "complete" || status.status === "failed") watched.delete(runId);
    }
    if (changed) yield* store.announce;
  });
  yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));

  /** What this host is holding, as a caller may see it. */
  const held = Effect.sync(() => ({
    live: [...live.keys()].sort(),
    unavailable: [...unavailable.entries()].map(([name, why]) => `${name}: ${why}`).sort(),
  }));

  const newest = Effect.fn("Native.newest")(function* (id: string) {
    const generation = live.get(newestOf.get(id) ?? "");
    if (!generation) {
      return yield* new HostRefused({ reason: `no workflow "${id}" is loaded here` });
    }
    return generation;
  });

  const routed = Effect.fn("Native.routed")(function* (runId: string) {
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

  // One registration at a time. Two clients starting different modules of one id at the
  // same moment would otherwise mint one name for both and stage over each other.
  const registering = yield* Semaphore.make(1);

  const mint = Effect.fn("Native.Registry.mint")(function* (file: string) {
    // Read as it is now to learn the id this file claims, then register the next
    // generation of that id.
    const described = yield* loadEntry(file, yield* revisionOf(directoryOf(file)));
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

  const resolve = Effect.fn("Native.Registry.resolve")(function* (options: {
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
  const offeredBy = Effect.fn("Native.Registry.offeredBy")(function* (runId: string) {
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
    // The facts a host has about a native Run. What it was launched with and how it
    // ended are the row's; the tickets it wrote and the findings it left are read from
    // its own directory, because producing them is the only way a Run can have them.
    const facts: ActionFacts = {
      outcome: isOutcome(asked) ? asked : "unspecified",
      succeeded: state.status === "complete",
      branch: options.branch ?? null,
      mrUrl: null,
      planIssues: yield* planIssuesIn(where),
      disposed: false,
      openFindings: yield* openFindingsIn(where),
      diffTarget: pointedAt(
        generation,
        yield* decodeInput(row.input).pipe(Effect.orElseSucceed(() => ({}))),
      ),
    };
    return { row, generation, facts, where };
  });

  const startWork = Effect.fn("Native.Registry.start")(function* (options: {
    readonly generation: Generation;
    readonly request: string;
    readonly project: string;
    readonly runId?: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly text?: Readonly<Record<string, string>>;
    readonly options?: Readonly<Record<string, string>>;
    readonly task?: string | null;
    readonly parent?: string | null;
  }) {
    const generation = options.generation;
    const runId =
      options.runId ?? `run-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`;
    const asked = options.options ?? {};
    yield* refuseOptions(generation, asked);
    const launch = launchOptions(generation, asked);
    // Settled before anything exists to clean up: an input the workflow's own schema
    // rejects names its field here, and no row, claim or execution is created.
    const settled = yield* settleInput(generation.fields, {
      json: options.input,
      text: options.text ?? {},
    });
    const payload = yield* Schema.decodeUnknownEffect(
      generation.registration.workflow.payloadSchema,
    )({ runId, input: settled.input }).pipe(
      Effect.mapError((cause) => new HostRefused({ reason: `${REFUSED_INPUT}: ${cause.message}` })),
    );
    const claimed = yield* store.admit({
      request: options.request,
      run: runId,
      workflow: generation.id,
      project: options.project,
      input: settled.input,
      provenance: settled.provenance,
      options: launch,
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: options.task ?? null,
      parent: options.parent ?? null,
    });
    remember(claimed.row);
    // Frozen with the Run, so editing the project's list changes the next one.
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: options.project,
      configDir,
    }).pipe(Effect.ignore);
    // A retry of work the engine already has is nothing more to do; one that crashed
    // before it heard is handed over now, under the identity it was admitted with.
    if (claimed.row.accepted === null) yield* handOver(claimed.row);
    return {
      runId: claimed.row.run,
      registration: claimed.row.generation,
      execution: claimed.row.execution,
      fresh: claimed.fresh,
    };
  });

  return {
    load: (file: string) => registering.withPermits(1)(mint(file)),

    use: useEntry,
    resolve,

    registrations: held,

    waiting: asked,
    view,
    views: (task: string | null) =>
      store.runs.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(task === null ? rows : rows.filter((row) => row.task === task), viewOf),
        ),
      ),
    importing: importHistory(dir).pipe(Effect.orDie),
    history: (task: string | null) =>
      store.history.pipe(
        Effect.map((rows) => (task === null ? rows : rows.filter((row) => row.task === task))),
      ),
    watch: (runId: string) =>
      store
        .watching(view(runId))
        .pipe(
          Stream.onStart(Effect.sync(() => (watchers += 1))),
          Stream.ensuring(Effect.sync(() => (watchers -= 1))),
        ),

    recover: Effect.gen(function* () {
      yield* registering.withPermits(1)(
        Effect.forEach(known, (route) =>
          live.has(route.name)
            ? Effect.void
            : register(route).pipe(
                Effect.catchTag("NativeEntryError", (failure) =>
                  Effect.sync(() =>
                    unavailable.set(route.name, `${failure.file}: ${failure.message}`),
                  ),
                ),
              ),
        ),
      );
      for (const row of yield* store.pending) yield* handOver(row);
      return yield* held;
    }),

    newest,
    routed,

    offers: (runId: string) =>
      offeredBy(runId).pipe(
        Effect.map(({ generation, facts }) =>
          offersFrom(generation.offers, facts, {
            self: generation.id,
            keepUnavailable: true,
          }),
        ),
      ),

    invoke: Effect.fn("Native.Registry.invoke")(function* (options: {
      readonly runId: string;
      readonly offer: string;
      readonly input: Readonly<Record<string, Schema.Json>>;
      readonly request: string;
    }) {
      const { row, generation, facts, where } = yield* offeredBy(options.runId);
      // Asked again here, of the module as it is now: the card this was read from may
      // have been drawn before the file was edited, and a card is not authority.
      const offer = offersFrom(generation.offers, facts, { self: generation.id }).find(
        (one) => one.id === options.offer,
      );
      if (offer === undefined) {
        return yield* new HostRefused({
          reason: `run "${options.runId}" does not offer "${options.offer}" now`,
        });
      }
      const starting = yield* resolve({ project: row.project, id: offer.workflow });
      // What the offer said Collie fills in, filled from the Run it is about. The
      // caller's own values win: an offer names where a value comes from, and a caller
      // that has a better one for the same field is not overruled by a default.
      const filled = { ...inputsFor(offer, { runDir: where, facts }), ...options.input };
      // The offer's own workflow settles what it was given, so arguments it will not
      // take are refused here and nothing is started.
      return yield* startWork({
        generation: starting,
        request: options.request,
        project: row.project,
        input: filled,
        task: row.task,
        parent: row.run,
      });
    }),

    start: startWork,

    status: Effect.fn("Native.Registry.status")(function* (runId: string) {
      const found = yield* routed(runId);
      const result = yield* engine.poll(found.generation.registration.workflow, found.execution);
      return pollStatus(result, found.generation.entry);
    }),

    answer: Effect.fn("Native.Registry.answer")(function* (options: {
      readonly runId: string;
      readonly decision: string | null;
      readonly value: string;
      readonly request: string;
    }) {
      const found = yield* routed(options.runId);
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
      if (question.options.length > 0 && !question.options.includes(options.value)) {
        return yield* new HostRefused({
          reason: `"${options.value}" is not one of ${question.options.join(", ")}`,
        });
      }
      // Checked before the answer is recorded: an answer the module has no deferred for
      // would otherwise close the question against a run nothing could ever resume.
      if (!found.generation.registration.decisions[name]) {
        return yield* new HostRefused({
          reason: `${found.generation.entry} declares no decision called "${name}"`,
        });
      }
      // Recorded first, and only the caller the write hands the row to completes the
      // deferred: two answers racing are separated by the database, not by timing.
      const settled = yield* store.settle({
        run: options.runId,
        decision: name,
        value: options.value,
        request: options.request,
      });
      if (settled._tag === "refused") {
        return yield* new HostRefused({ reason: settled.reason });
      }
      if (settled._tag === "repeat") {
        return { runId: options.runId, decision: name, value: options.value, fresh: false };
      }
      yield* answerDecision(found.generation.registration, {
        name,
        executionId: found.execution,
        value: options.value,
      }).pipe(Effect.mapError((failure) => new HostRefused({ reason: failure.message })));

      return { runId: options.runId, decision: name, value: options.value, fresh: true };
    }),

    control: Effect.fn("Native.Registry.control")(function* (options: {
      readonly runId: string;
      readonly control: string;
      readonly set: boolean;
    }) {
      // Written before anything is woken, so a run that wakes up never finds the
      // request that stopped it still there.
      yield* setControl(options.runId, options.control, options.set);
      const found = yield* routed(options.runId).pipe(Effect.result);
      const recorded = { runId: options.runId, control: options.control, set: options.set };
      if (found._tag === "Failure") {
        return { ...recorded, applied: false, detail: found.failure.reason };
      }
      // A hold is read at the next boundary and needs no waking. Everything else does:
      // a run parked on its question has nothing that would make it look again.
      if (!(options.control === HOLD && options.set)) yield* wake(found.success);
      return { ...recorded, applied: true, detail: "" };
    }),

    steer: Effect.fn("Native.Registry.steer")(function* (options: {
      readonly runId: string;
      readonly text: string;
      readonly request: string;
      readonly operation?: string;
      readonly mode?: Agents.DeliveryMode;
    }) {
      // Routed first: a run this host is not holding has no agent it can vouch for.
      yield* routed(options.runId);
      const agents = yield* NativeAgents;
      return yield* agents.steer(options);
    }),
  } satisfies RegistryApi;
});

const decodeOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

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
 * from a value: `paths` is what makes `collie/native` resolve to the declarations beside
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
    "paths": { "collie/native": ["./collie-native.d.ts"] }
  }
}
`,
  "collie-native.d.ts": SDK_DECLARATIONS,
} as const;

/**
 * Writes the authoring setup beside a workflow directory and installs its toolchain with
 * the embedded Bun, so a machine with neither Bun nor Node on it can still typecheck a
 * module. An existing package.json or tsconfig.json is left alone: it is the author's,
 * and this is not the only thing they may be using that directory for.
 */
export const provisionToolchain: (
  dir: string,
) => Effect.Effect<
  void,
  ToolchainError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.fn("Native.provisionToolchain")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  for (const [name, content] of Object.entries(TOOLCHAIN_FILES)) {
    const path = `${dir}/${name}`;
    if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) continue;
    yield* fs.writeFileString(path, content).pipe(Effect.orDie);
  }
  yield* runBun(dir, ["install"]).pipe(
    Effect.mapError(
      (message) =>
        new ToolchainError({
          code: "toolchain_unavailable",
          message: `cannot install the workflow toolchain in ${dir}: ${message}`,
        }),
    ),
  );
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
> = Effect.fn("Native.typecheckEntry")(function* (options: {
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
  const project = `${options.dir}/.collie-check.json`;
  yield* fs
    .writeFileString(
      project,
      encodeCheckProject({ extends: "./tsconfig.json", files: [options.file] }),
    )
    .pipe(Effect.orDie);
  const output = yield* runBun(options.dir, [
    "run",
    compiler,
    "--pretty",
    "false",
    "-p",
    project,
  ]).pipe(Effect.catch((printed) => Effect.succeed(printed)));
  const diagnostics = output.split("\n").filter((line) => /\(\d+,\d+\): error /.test(line));
  // tsc exits non-zero for the diagnostics it printed; anything else it refused to do is
  // the toolchain's problem, not the module's, and must not read as a clean module.
  if (diagnostics.length === 0 && output.includes("error TS")) {
    return yield* new ToolchainError({
      code: "toolchain_unavailable",
      message: `the typechecker refused to run: ${output.trim()}`,
    });
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
): Effect.Effect<string, string, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(process.execPath, args, {
        cwd,
        env: { BUN_BE_BUN: "1", PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const output = yield* collect(child.stdout).pipe(
      Effect.zipWith(collect(child.stderr), (out, err) => out + err),
    );
    const code = yield* child.exitCode;
    return code === 0 ? output : yield* Effect.fail(output);
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
