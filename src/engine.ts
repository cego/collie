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

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import {
  Cause,
  Clock,
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
  Random,
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
  type AgentPreferences,
  type HostCodec,
  type HostPayload,
  type HostWorkflow,
  type Registration,
  type WorkflowDefinition,
  type WorkflowEntry,
} from "./sdk";
import { FALLBACK_DEFAULTS, configValue, loadDefaults, readConfig } from "./config";
import { foldPreferences, preferencesIn, resolveChoice } from "./harness";
import { currentEnv } from "./env";
import {
  HelleClaimSchema,
  HelleError,
  credentials,
  releaseClaim,
  waitForHelle,
  type HelleClaim,
} from "./helle";
import { currentPid, signalProcess } from "./lock";
import type { CheckoutKind, InputStrategy } from "./definitions";
import { noteVerification } from "./metrics";
import {
  gitlabForProject,
  gitlabReadiness,
  mrFacts,
  parseMrTarget,
  parseMrUrl,
  postNote,
  projectHere,
  shell as runShell,
} from "./mr";
import { Notifier, SOUND, notificationTitle, wanted, type Sound } from "./notify";
import {
  Oversight,
  cardCheckpoints,
  checkDrift,
  grantedToRun,
  said,
  settleAtFinish,
  standForElection,
  writeCard,
  type Correcting,
  type Watched,
} from "./oversight";
import { evaluationDeps } from "./evaluator";
import { budgetPath } from "./steering";
import type { JudgementDeps } from "./drift";
import type { Card } from "./cards";
import { reason } from "./naming";
import {
  fromWorkSource,
  propagate,
  readIntent,
  seedIntent,
  writeIntent,
  type IntentSeed,
} from "./intent";
import { latest, readDispositions, type Disposition } from "./disposition";
import { openFindingsIn } from "./output";
import { isSingleRepo, planIssuesIn, planReposOf } from "./plan";
import { SELF, inputsFor, offersFrom, type Declared, type Offer } from "./offers";
import { isOutcome } from "./outcome";
import { RequestConflict, Store, storeLayer, type Admission, type RunRow } from "./store";
import { TASK_INPUT, checkoutFor, repositoryName } from "./worktree";
import { Herdr, herdrFailureReason } from "./herdr";
import type { PluginEnv } from "./env";
import { WorktreeRecordSchema } from "./run";
import { newTask, taskOfWorkspace, writeTask } from "./task";
import { classifyWorkSource } from "./inputs";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { approvedFrom, VerifySpecSchema, type VerifySpec } from "./verify-spec";
import {
  fingerprint,
  insideRun,
  readVerifications,
  runApproved,
  type Verification,
} from "./verify";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";

/** A module that cannot be loaded, named by its own file. Schema-backed, so the local
 *  host can fail a client with the same value rather than a copy of it. */
export class EntryError extends Schema.TaggedError<EntryError>()("EntryError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/** What a refusal says first where the input is why, which a front door reads back. */
export const REFUSED_INPUT = "invalid_input";

/** Anything else a host will not do, said in one sentence a caller can show. */
export class HostRefused extends Schema.TaggedError<HostRefused>()("HostRefused", {
  reason: Schema.String,
}) {}

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
  effect: "4.0.0-rc.117",
  typescript: "^7.0.2",
} as const;

/**
 * The declarations an author typechecks `collie` against, kept in step with
 * `src/sdk.ts` by `engine.test.ts` — which typechecks a module using the whole
 * surface, so a declaration that has drifted fails a test rather than an author's build.
 */
export const SDK_DECLARATIONS = `declare module "collie" {
  import type { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
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
    /** The Task this Run belongs to, whose workspace its agents open in; null for none. */
    readonly task: string | null;
    /** A workspace of the Run's own, where it asked for one; null lives in its Task's. */
    readonly workspace: string | null;
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
  export interface HostApi {
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
    /** Records the merge request this Run opened, as a fact its card reads. */
    readonly mergeRequest: (runId: string, url: string) => Effect.Effect<void>;
  }
  export const Host: Context.Service<HostApi, HostApi>;
  export type Host = HostApi;

  /** How every workflow reports a failure. */
  export class WorkflowError extends Schema.TaggedError<WorkflowError>()(
    "WorkflowError",
    { reason: Schema.String },
  ) {}

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
  }

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
    | Path.Path;

  /** What a definition declares about itself beside what it does. None of it is a step. */
  export interface Declarations {
    readonly hints?: Readonly<Record<string, string>>;
    readonly outcome?: OutcomeContract;
    /** A worktree the host cuts before the Run exists; absent works where it was started. */
    readonly checkout?: "branch" | "roaming";
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
    readonly agents?: AgentPreferences;
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

  /**
   * What this Run may have Collie run to prove its kind of result. With nothing approved
   * where that kind needs something, the Run parks with the repair; a resume asks again.
   */
  export function requireApproved(
    kind: string,
  ): Effect.Effect<ReadonlyArray<VerifySpec>, never, Run | Host | WorkflowInstance>;

  /** What a parent asks for when part of its own work is another workflow. */
  export interface ChildAsk {
    /** Stable within the parent: the same one twice is the same child. */
    readonly invocation: string;
    /** A public id, or "self" for the parent's own. */
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
     * pane of whoever is live in that role, and otherwise to stop and ask the human.
     */
    readonly askRoute: (role: string, cwd: string) => Effect.Effect<string>;
    readonly launch: (ask: AgentAsk) => Effect.Effect<Launched, AgentUncertain | AgentParked>;
    /** This work's agent started again with its prompt, where it is gone and wrote nothing. */
    readonly revive: (
      ask: AgentAsk,
      unless?: string | null,
    ) => Effect.Effect<void, AgentUncertain | AgentParked>;
    /** A message to another Run's live agent in this role here; null where there is none. */
    readonly handOff: (options: {
      readonly runId: string;
      readonly role: string;
      readonly cwd: string;
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
    readonly harness?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly permissions?: "auto" | "harness";
  }

  /** A message handed to another Run's live agent in this role: the agent, or null where none. */
  export function handOffWork(options: {
    readonly operation: string;
    readonly role: string;
    /** Where the agent to hand to works; the Run's own checkout where it is left out. */
    readonly cwd?: string;
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
    /** The shared claim it still holds, by the project it claimed; null where it holds none. */
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
) => Effect.Effect<WorkflowEntry, EntryError, FileSystem.FileSystem> = Effect.fn(
  "Engine.loadEntry",
)(function* (file: string) {
  installSdk();
  // Bun's module registry has no invalidation, so an entry or a helper read twice at one
  // path is the first read both times. Each read is of a copy of what is there now.
  const staged = yield* stagedEntry(file);
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
  const { hints, outcome, checkout, followUps, actions } = definition;
  const declared = Object.fromEntries(
    Object.entries({ hints, outcome, checkout, followUps, actions }).filter(
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

/** The envelope a definition is executed with, read where the host hands it over. */
const readEnvelope = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));

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
  const body = workflow.toLayer((envelope) => {
    // SAFETY: the envelope decoded against the definition's own input struct.
    const input = envelope.input as never;
    const run = Run.of({ id: readEnvelope(envelope).runId, workflow: definition.id });
    return definition.run({ input }).pipe(
      Effect.provideService(Run, run),
      Effect.provideService(WorkflowAgents, definition.agents),
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
const stagedEntry = Effect.fn("Engine.stagedEntry")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* entriesRoot(file);
  const dir = directoryOf(file);
  const name = `${Bun.hash(dir).toString(16)}-${yield* revisionOf(dir)}`;
  const root = `${entries}/generations/${name}`;
  const staged = { root, file: `${root}${file}` };
  if (yield* fs.exists(staged.file).pipe(Effect.orElseSucceed(() => false))) return staged;
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
 * What a generation of an entry would be staged from, as one value. A generation is a copy
 * of the whole directory and of what it imports from outside it, so an edited helper or
 * Markdown prompt is as much a change as an edited entry — and nothing touched is the same
 * code to run.
 */
export const revisionOf: (dir: string) => Effect.Effect<string, never, FileSystem.FileSystem> =
  Effect.fn("Engine.revisionOf")(function* (dir: string) {
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
  const names = yield* fs
    .readDirectory(dir, { recursive: true })
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  const pending = names
    .filter((name) => !name.startsWith("node_modules/"))
    .map((name) => `${dir}/${name}`);
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
    if (name === "node_modules") continue;
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
}): Layer.Layer<
  WorkflowEngine.WorkflowEngine | SqlClient.SqlClient | Reactivity.Reactivity,
  ConfigError
> {
  // One connection, two halves: the engine's own tables and the rows Collie keeps beside
  // them are in the same file, written by the same process.
  const sql = SqliteClient.layer({ filename: `${options.dir}/host.db` }).pipe(
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
      entityRegistrationTimeout: Duration.infinity,
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

/** Where a Run keeps the merge request it opened. */
const mergeRequestPath = (dir: string, runId: string) => `${runDir(dir, runId)}/merge-request`;

/** The merge request a Run opened, or null where it recorded none. */
const mergeRequestOf = (fs: FileSystem.FileSystem, dir: string, runId: string) =>
  fs.readFileString(mergeRequestPath(dir, runId)).pipe(
    Effect.map((url) => url.trim() || null),
    Effect.orElseSucceed(() => null),
  );

const approvedPath = (dir: string, runId: string) => `${evidenceDir(dir, runId)}/approved.json`;

const ApprovedJson = Schema.fromJsonString(Schema.Array(VerifySpecSchema));
const decodeApproved = Schema.decodeUnknownEffect(ApprovedJson);
const encodeApproved = Schema.encodeSync(ApprovedJson);

/**
 * What this Run may have Collie run for it, as it was when the Run started. Frozen at
 * admission, so editing the file changes the next Run and never a live one.
 */
export const freezeApproved = Effect.fn("Engine.freezeApproved")(function* (options: {
  readonly dir: string;
  readonly runId: string;
  readonly project: string;
  readonly userDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = approvedPath(options.dir, options.runId);
  if (yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))) return;
  const approved = yield* approvedFrom({
    cwd: options.project,
    userDir: options.userDir,
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => []));
  yield* fs.makeDirectory(evidenceDir(options.dir, options.runId), { recursive: true });
  yield* fs.writeFileString(path, encodeApproved(approved));
});

const approvedOf = Effect.fn("Engine.approvedOf")(function* (dir: string, runId: string) {
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
  const fs = yield* FileSystem.FileSystem;
  const patience = options.patience ?? { everyMs: 250, forMs: 60_000 };
  const handed: string[] = [];
  for (const runId of options.runs) {
    if (runId === options.to) continue;
    const file = claimPath(options.dir, runId);
    if ((yield* recordedClaim(file))?.slug !== options.slug) continue;
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
    yield* fs.remove(file, { force: true }).pipe(Effect.orDie);
    yield* fs
      .writeFileString(
        `${options.dir}/events.${runId}.log`,
        `claim on ${options.slug} taken over by ${options.to}; its agents were closed\n`,
        { flag: "a" },
      )
      .pipe(Effect.orDie);
    handed.push(runId);
  }
  return handed;
});

export const hostLayer = (options: {
  readonly dir: string;
  /** Where a user's own `verify.json` is, for a project that wrote none. */
  readonly userDir?: string;
  /** Where a toast goes; left out, nothing is raised. */
  readonly toast?: Toast;
  /** The Herd this host works for; left out, nothing is judged or charged to one. */
  readonly herd?: Herd;
}): Layer.Layer<Host | Notifier | Oversight, never, Store | BunServices> =>
  Layer.effectContext(
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
      const host = Host.of({
        dir,
        place: (runId) =>
          under(
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
              })),
              Effect.orElseSucceed(() => ({
                cwd: dir,
                dir: runDir(dir, runId),
                options: {},
                task: null,
                workspace: null,
              })),
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
          return why === null
            ? fs.remove(path, { force: true }).pipe(Effect.orDie)
            : fs
                .writeFileString(path, why)
                .pipe(
                  Effect.orDie,
                  Effect.andThen(notify(runId, "needs-you", why, { key: `parked:${why}` })),
                );
        },
        asking: (runId, question) =>
          store
            .asking({
              run: runId,
              decision: question.name,
              prompt: question.prompt,
              options: question.options,
            })
            .pipe(
              Effect.andThen(
                notify(runId, "needs-you", `${question.name}: ${question.prompt}`, {
                  key: `ask:${question.name}`,
                }),
              ),
            ),
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
            Effect.gen(function* () {
              const approved = yield* approvedOf(dir, asked.runId);
              const spec = approved.find((entry) => entry.name === asked.name);
              if (spec === undefined) {
                return yield* new WorkflowError({
                  reason: `"${asked.name}" is not among this Run's approved verifications`,
                });
              }
              // The workflow's checkout has to be the Run's own; the grant's directory is resolved from it.
              const row = yield* store.run(asked.runId);
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
              const own = { id: asked.runId, cwd: placed?.cwd ?? dir, worktree };
              if (!(yield* insideRun(asked.cwd, own))) {
                return yield* new WorkflowError({
                  reason: `"${asked.cwd}" is not inside run ${asked.runId}`,
                });
              }
              const journal = evidenceDir(dir, asked.runId);
              return yield* runApproved(
                journal,
                { ...own, cwd: asked.cwd },
                approved,
                spec,
                asked.expect ?? "pass",
              ).pipe(
                Effect.tap((record) => noteVerification(journal, record)),
                Effect.mapError((refused) => new WorkflowError({ reason: refused.why })),
              );
            }),
          ),
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
                    yield* readConfig(options.userDir ?? dir),
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
                      Effect.andThen(fs.writeFileString(file, encodeClaim(claim))),
                      Effect.orDie,
                    );
                }),
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
        mergeRequest: (runId, url) =>
          fs.makeDirectory(runDir(dir, runId), { recursive: true }).pipe(
            Effect.andThen(fs.writeFileString(mergeRequestPath(dir, runId), `${url}\n`)),
            Effect.andThen(store.announce),
            Effect.orDie,
            Effect.andThen(
              notify(runId, "mr-opened", url, {
                key: url,
                subject: Option.fromNullishOr(parseMrUrl(url)).pipe(
                  Option.map((mr) => `!${mr.iid}`),
                  Option.getOrUndefined,
                ),
              }),
            ),
          ),
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
      /** A Run as a card sees it: where it works, and where its records are. */
      const watched = (runId: string): Effect.Effect<Watched> =>
        Effect.gen(function* () {
          const row = yield* store.run(runId);
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
            socketPath: options.herd?.socketPath ?? null,
          };
        });
      /** A card that is something a human could go and try is worth telling them about. */
      const told = (runId: string, cards: ReadonlyArray<Card>) =>
        Effect.forEach(cards, (card) =>
          card.significance === "try-it"
            ? notify(runId, "slice-ready", card.readiness, { key: card.id })
            : Effect.void,
        );
      const bun = yield* Effect.context<BunServices>();
      /** What judging a Run's drift takes, or null where there is no Herd to charge it to. */
      const judging = (at: Watched) =>
        Effect.gen(function* () {
          if (options.herd === undefined) return null;
          const built = yield* evaluationDeps(options.herd);
          if (built.herdKey === null) return null;
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
          const newest =
            Option.isNone(agents) || judged === "finish" ? null : yield* agents.value.newest(runId);
          const to =
            Option.isNone(agents) || newest === null
              ? null
              : {
                  agent: newest,
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
              const outcome = yield* host.verify({ runId, name, cwd: at.cwd }).pipe(
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
            const proposed = yield* settleAtFinish(at).pipe(Effect.provideContext(bun));
            if (proposed !== null)
              yield* notify(runId, "proposal-pending", `a follow-up for what is still blocking`, {
                key: proposed,
              });
            const card = yield* under(writeCard(at, { kind: "final", step: "finish", claims: [] }));
            yield* told(runId, [card]);
            // Once, here: the finish is the only moment at which nobody is left to make an
            // owed cross-run check, which is what makes it something a human has to know.
            if (card.cross_run === "pending")
              yield* notify(runId, "drift-unresolved", "cross_run_pending", { key: "cross_run" });
          }).pipe(Effect.ignore),
      });
      return Context.make(Host, host).pipe(
        Context.add(Notifier, Notifier.of({ notify })),
        Context.add(Oversight, oversight),
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
    return { status: "complete", value: isJson(result) ? result : String(result) };
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
  if (!given.startsWith("/")) {
    return yield* refusedInput(
      `workspace: "${given}" is neither "new" nor the absolute path of a checkout`,
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const found = yield* fs.stat(given).pipe(Effect.option);
  if (Option.isNone(found) || found.value.type !== "Directory") {
    return yield* refusedInput(`workspace: ${given} is not a directory`);
  }
  return { kind: "existing", path: given } satisfies CheckoutRequest;
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
  from: Schema.String,
  taskLabel: Schema.NullOr(Schema.String),
  workspace: Schema.optionalKey(Schema.NullOr(Schema.String)),
  checkout: Schema.optionalKey(Schema.NullOr(Cut)),
});
type Placing = typeof Placing.Type;
const PlacingJson = Schema.fromJsonString(Placing);
const decodePlacing = Schema.decodeUnknownOption(PlacingJson);
const encodePlacing = Schema.encodeSync(PlacingJson);

/** A row claimed and not placed yet: nothing hands it to the engine until it is. */
const unplaced = (row: RunRow) => row.checkout === null && row.placing !== null;

/** Where a Run works: as the host placed it, or for a row from before that, as it started. */
const placedOf = (row: RunRow, options: Readonly<Record<string, string>>): Placed =>
  Option.getOrElse(decodePlaced(row.checkout ?? ""), () => ({
    cwd: options.workspace ?? row.project,
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
  /** The merge request the Run opened, as its workflow recorded it, or null. */
  mr: Schema.NullOr(Schema.String),
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
  /** The file and the revision this was built from: what makes a later start the same code. */
  readonly source: string;
  readonly metadata: Schema.Json;
  /** What a finished Run of this module offers next, with the author's own eligibility. */
  readonly offers: ReadonlyArray<Declared>;
  /** What the workflow prefers for its own agents. */
  readonly agents: AgentPreferences | undefined;
  readonly registration: Registration;
}

/** What the registry's own work takes, which is what a host holds already. */
export type HostServices =
  | WorkflowEngine.WorkflowEngine
  | Host
  | Agents
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
    /** A new Task to open for it, under this label, on the checkout it is given. */
    readonly taskLabel?: string | undefined;
    readonly parent?: string | null;
    /** What the front door knows of the Run's Intent. */
    readonly intent?: IntentSeed;
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
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: AgentsSdk.DeliveryMode;
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
 * yet written. Only a test sets one, through the host's `COLLIE_HOST_CRASH_AT`.
 */
export type CrashPoint = "admitted" | "executed" | "answered";

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
}): Layer.Layer<
  | Host
  | Notifier
  | Oversight
  | Store
  | WorkflowEngine.WorkflowEngine
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
  const register = Effect.fn("Engine.register")(function* (route: {
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
      registration.layer.pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(Children)(children), Layer.succeed(Executions)(executions)),
        ),
      ),
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
        login: placing.env.gitlabLogin,
        recordedBy: (at) =>
          store.runs.pipe(
            Effect.map(
              (rows) => rows.find((row) => placedOf(row, {}).worktree?.path === at)?.run ?? null,
            ),
          ),
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
      return made.workspaceId;
    });
    const workspace = opened?.id ?? ask.workspace ?? (yield* openWorkspace);
    // A workspace an earlier attempt recorded may already have its Task.
    const known =
      ask.workspace === undefined
        ? null
        : yield* taskOfWorkspace(placing.env.stateDir, workspace).pipe(Effect.orDie);
    const task =
      known ??
      (yield* newTask({ workspace, label, cwd: placed.cwd }).pipe(
        Effect.flatMap((made) => writeTask(placing.env.stateDir, made)),
        Effect.orDie,
      ));
    // Focused, not just created: a human who started work is taken to it.
    yield* Effect.ignore(placing.herdr.workspaceFocus(workspace));
    return { placed, task: task.id };
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
        request: yield* checkoutRequest(generation, options),
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
    stop: (runId) => stopTree(runId).pipe(Effect.provideContext(hostServices)),
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
    const request = yield* checkoutRequest(generation, asked).pipe(
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
    // Where its parent works, unless it named a checkout of its own.
    const from = request.kind === "existing" ? request.path : placedOf(parent, parentOptions).cwd;
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
      placing: encodePlacing({ from, taskLabel: null }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: parent.task,
      parent: ask.runId,
    }).pipe(Effect.mapError((failure) => refused(failure.reason)));
    // A child is a Run, so what it may verify is frozen with it rather than read when
    // it asks: the same list, and the same moment, as the start of any other. One that
    // works in a checkout of its own is held to what that checkout approves.
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: request.kind === "existing" ? request.path : parent.project,
      userDir,
    }).pipe(Effect.ignore);
    yield* seedIntentOf({ dir, row: claimed.row, generation, seed: undefined, parent }).pipe(
      Effect.provideContext(bun),
      Effect.ignore,
    );
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
    const payload = yield* payloadOf(found.generation, row).pipe(
      Effect.mapError(() => refused(`${found.generation.entry} no longer takes ${row.input}`)),
    );
    // Executed on the parent's own fiber, which is what links the two: the engine
    // reads the parent's instance from here, so the child's completion wakes the
    // parent and interrupting the parent reaches the child.
    const workflow = found.generation.registration.workflow;
    const written = Schema.encodeUnknownOption(Schema.toCodecJson(workflow.errorSchema));
    return yield* workflow.execute(payload).pipe(
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
  const handOver = Effect.fn("Engine.handOver")(function* (row: RunRow) {
    const generation = live.get(row.generation);
    if (generation === undefined || unplaced(row)) return;
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

  /** Admitted work a host did not live to place or hand over, finished under its claim. */
  const recoverAdmission = (row: RunRow) =>
    claimingOf(row.request).withPermits(1)(
      placeClaimed(row, false).pipe(
        Effect.flatMap(handOver),
        Effect.catchTag("HostRefused", (failure) =>
          Effect.logWarning(`${row.run} could not be placed: ${failure.reason}`),
        ),
      ),
    );

  /** Every recorded answer handed again to a run still waiting; the engine keeps one completion. */
  const reconcileAnswers = Effect.gen(function* () {
    for (const row of yield* store.runs) {
      const generation = live.get(row.generation);
      if (generation === undefined) continue;
      const answered = (yield* store.asked(row.run)).filter((one) => one.answer !== null);
      if (answered.length === 0) continue;
      const state = pollStatus(
        yield* engine.poll(generation.registration.workflow, row.execution),
        generation.entry,
      );
      if (state.status !== "suspended") continue;
      for (const one of answered) {
        yield* answerDecision(generation.registration, {
          name: one.decision,
          executionId: row.execution,
          value: one.answer ?? "",
        });
      }
    }
  });

  // What a host admitted and did not live to hand over. Every crash window ends here.
  for (const row of yield* store.pending) yield* recoverAdmission(row);
  yield* reconcileAnswers;

  /** The file a generation was built from, which a row keeps naming after it has gone. */
  const entryOf = (name: string) => known.find((route) => route.name === name)?.entry ?? "";

  const claimOf = (runId: string) =>
    recordedClaim(claimPath(dir, runId)).pipe(Effect.provideService(FileSystem.FileSystem, fs));

  const viewOf = Effect.fn("Engine.viewOf")(function* (row: RunRow) {
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
      mr: yield* mergeRequestOf(fs, dir, row.run),
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
    const status = pollStatus(
      result,
      generation.entry,
      generation.registration.workflow.successSchema,
      generation.registration.workflow.errorSchema,
    );
    // A failed Run keeps a claim it may have left shared work half-done under.
    const kept = status.status === "failed" ? yield* claimOf(row.run) : null;
    return {
      ...about,
      status,
      diagnostic:
        kept === null
          ? null
          : `claim on ${kept.slug} retained; recovery required: a new Run of ${row.workflow} takes it over and closes this Run's agents`,
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
  const wake = Effect.fn("Engine.wake")(function* (found: {
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

  /** Sets a control, and a stop over every child the Run started, then wakes what must look again. */
  const applyControl = Effect.fn("Engine.applyControl")(function* (
    runId: string,
    control: string,
    set: boolean,
  ) {
    // A stop reaches the children a Run started: they are its work too.
    const runs = control === STOP ? [runId, ...descendantsOf(yield* store.runs, runId)] : [runId];
    // Written before anything is woken, so a run that wakes up never finds the request
    // that stopped it still there.
    for (const one of runs) yield* setControl(one, control, set);
    // A file, not a row: nothing tells a watcher about it unless this does.
    yield* store.announce;
    // A hold is read at the next boundary and needs no waking. Everything else does: a
    // run parked on its question has nothing that would make it look again.
    if (!(control === HOLD && set)) {
      for (const one of runs) {
        const found = yield* routed(one).pipe(Effect.option);
        if (Option.isSome(found)) yield* wake(found.value);
      }
    }
    return runs;
  });

  /** A stop, and the agents of every Run it reached closed: the Runs, and what did not close. */
  const stopTree = Effect.fn("Engine.stopTree")(function* (runId: string) {
    const runs = yield* applyControl(runId, STOP, true);
    // Closing their panes is what stops the agents; the Run only stops looking.
    const agents = yield* Agents;
    const left: string[] = [];
    for (const one of runs) left.push(...(yield* agents.halt(one)).left);
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
      claim: (yield* claimOf(runId))?.slug ?? null,
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
    return { row, generation, facts, where, refused, input };
  });

  const startWork = Effect.fn("Engine.Registry.start")(function* (options: {
    readonly generation: Generation;
    readonly request: string;
    readonly project: string;
    readonly runId?: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly text?: Readonly<Record<string, string>>;
    readonly options?: Readonly<Record<string, string>>;
    readonly task?: string | null;
    readonly taskLabel?: string | undefined;
    readonly parent?: string | null;
    readonly intent?: IntentSeed;
  }) {
    const generation = options.generation;
    const runId =
      options.runId ?? `run-${(yield* crypto.randomUUIDv4.pipe(Effect.orDie)).slice(0, 8)}`;
    const asked = options.options ?? {};
    yield* refuseOptions(generation, asked);
    yield* refuseAgent(generation, asked);
    const request = yield* checkoutRequest(generation, asked);
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
    const claimed = yield* claimAndPlace({
      request: options.request,
      run: runId,
      workflow: generation.id,
      project: options.project,
      input: settled.input,
      provenance: settled.provenance,
      options: launch,
      placing: encodePlacing({
        from: request.kind === "existing" ? request.path : options.project,
        taskLabel: options.taskLabel ?? null,
      }),
      generation: generation.name,
      execution: yield* generation.registration.workflow.executionId(payload),
      task: options.task ?? null,
      parent: options.parent ?? null,
    });
    // Frozen with the Run, so editing the project's list changes the next one.
    yield* freezeApproved({
      dir,
      runId: claimed.row.run,
      project: options.project,
      userDir,
    }).pipe(Effect.ignore);
    yield* seedIntentOf({
      dir,
      row: claimed.row,
      generation,
      seed: options.intent,
      parent: options.parent ? yield* store.run(options.parent) : null,
    }).pipe(Effect.provideContext(bun), Effect.ignore);
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
                Effect.catchTag("EntryError", (failure) =>
                  Effect.sync(() =>
                    unavailable.set(route.name, `${failure.file}: ${failure.message}`),
                  ),
                ),
              ),
        ),
      );
      for (const row of yield* store.pending) yield* recoverAdmission(row);
      yield* reconcileAnswers;
      return yield* held;
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

    answer: Effect.fn("Engine.Registry.answer")(function* (options: {
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
      // Recorded first, and only the caller the write hands the row to completes the
      // deferred: two answers racing are separated by the database, not by timing.
      const settled = yield* store.settle({
        run: options.runId,
        decision: name,
        value,
        request: options.request,
      });
      if (settled._tag === "refused") {
        return yield* new HostRefused({ reason: settled.reason });
      }
      if (settled._tag === "accepted") yield* crash("answered");
      // Completed again on a repeat: the recording host may have died before the run was told.
      yield* answerDecision(found.generation.registration, {
        name,
        executionId: found.execution,
        value,
      });

      return { runId: options.runId, decision: name, value, fresh: settled._tag === "accepted" };
    }),

    control: Effect.fn("Engine.Registry.control")(function* (options: {
      readonly runId: string;
      readonly control: string;
      readonly set: boolean;
    }) {
      const found = yield* routed(options.runId).pipe(Effect.result);
      const left =
        options.control === STOP && options.set
          ? (yield* stopTree(options.runId)).left
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
      if ((yield* store.run(options.runId)) === null) {
        return yield* new HostRefused({ reason: `no run "${options.runId}" was started here` });
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
      readonly operation?: string;
      readonly agent?: string;
      readonly mode?: AgentsSdk.DeliveryMode;
    }) {
      // Routed first: a run this host is not holding has no agent it can vouch for.
      yield* routed(options.runId);
      const agents = yield* Agents;
      return yield* agents.steer(options);
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

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = Schema.is(JsonObject);
const readJsonObject = Schema.decodeUnknownOption(Schema.fromJsonString(JsonObject));
const writeJsonObject = Schema.encodeSync(Schema.fromJsonString(JsonObject, { space: 2 }));
const objectIn = (value: Schema.Json | undefined) => (isJsonObject(value) ? value : {});

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
  yield* fs.writeFileString(`${dir}/collie.d.ts`, SDK_DECLARATIONS).pipe(Effect.orDie);
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
  const project = `${options.dir}/.collie-check.json`;
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
  ]).pipe(Effect.mapError(unavailable));
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
  ChildProcessSpawner.ChildProcessSpawner
> =>
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
