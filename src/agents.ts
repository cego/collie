import * as Cause from "effect/Cause";

// WARNING: launch is external and no Activity is exactly-once, so replay reconciles by the derived agent name rather than launching again (ADR-0020).
import { Foreground } from "./foreground";
import { ParkCause } from "./park-cause";
import { rememberNotQuiet, rememberStaleHandOver } from "./park-recheck";
import { HandOver, atDispatch, buildHandOver, planRevision, renderHandOver } from "./hand-over";
import type { AtDispatch, CheckoutNow, HandOverGiven, HandOverState } from "./hand-over";
import { readIntent } from "./intent";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import * as Struct from "effect/Struct";
import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { Path } from "effect";
import {
  Clock,
  Config,
  Context,
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Formatter,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  flow,
  Result,
} from "effect";
import type { PlatformServices } from "./platform";
import * as Activity from "effect/workflow/Activity";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { attachmentsDir, listAttachments } from "./attachments";
import type { Attachment } from "./attachments";
import {
  Launched,
  launchDir,
  orderLaunch,
  launchesOfAgents,
  readLaunches,
  recordLaunch,
  sameSession,
  StartedWith,
  withRelaunchLock,
  stemOf,
  wasOrdered,
} from "./launches";
import type { AgentSession } from "./launches";
import { CurrentStep } from "./steps";
import type { At } from "./steps";
import { takeStepNotes } from "./step-steering";
import { stringifyJson } from "./json";
export { Launched } from "./launches";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { NotQuiet } from "./compaction";
import {
  COMPACTION_WAIT_MS,
  pollCompaction,
  Unsubmitted,
  atBoundary,
  awaitReady,
  controlDir,
  installControls,
  lostServer,
  readControl,
  notStopped,
  serversOfRun,
  STOP_WAIT_MS,
  stopUnlaunched,
  withControlLock,
} from "./compaction";
import type { CompactionDeps, CompactionPorts, ControlRecord } from "./compaction";
import {
  COMPACTION_PORTS,
  OPENCODE_USAGE,
  atLeast,
  installedVersion,
  questionsSince,
  postUnrepaired,
  UNREPAIRED,
  QUESTIONS,
  takeHarnessQuestions,
  ranOutSince,
  stoppedSince,
  submittedDelivery,
  piQuestionTool,
} from "./compactors";
import type { AskedCall, AgentQuestion } from "./compactors";
import { RECOMMENDED_MARKER, questionRepair, shortfallOf, solutionsOf } from "./question-standard";
import { UNPROVABLE, endAgent, rootOf } from "./agent-end";
import type { EndDeps } from "./agent-end";
import { boundThread, withCodex } from "./codex";
import { kindForRole } from "./cards";
import { narrativeOf } from "./narrative-model";
import { Oversight } from "./oversight";
import {
  autoCompactWindowAsWritten,
  FALLBACK_DEFAULTS,
  gitlabHostOf,
  loadDefaults,
  readConfig,
} from "./config";
import type { Defaults } from "./config";
import { autoModeBlock, autoModeFacts } from "./automode";
import type { AutoModeBlock, RunAuthority } from "./automode";
import { shell } from "./mr";
import type { ForgeHttp } from "./forge/http";
import { parseDocument } from "./yaml";
import type { YamlMap } from "./yaml";
import { RanOn } from "./board-model";
import { humanOf } from "./proposals";
import type { Asker } from "./proposals";
import { STOP, controlSet } from "./controls";
import * as dispatch from "./dispatcher";
import type * as Types from "effect/Types";
import { bodySections, layers, personaHoles, skillDirs, skillFile } from "./definitions";
import { currentEnv, selfCommand } from "./env";
import type { PluginEnv } from "./env";
import {
  HARNESSES,
  foldPreferences,
  autoCompactWindowFor,
  installedHelp,
  isPermissionMode,
  opencodeReporter,
  opencodeUsage,
  permissionsAsWritten,
  personaPrefix,
  ceilingIn,
  DEFAULT_MODEL,
  pinned,
  preferencesIn,
  preferencesFromOptions,
  resolveWithRoom,
  said,
  startArgs,
  sessionArgs,
} from "./harness";
import type {
  AgentChoice,
  HarnessAdapter,
  Room,
  StartSession,
  PermissionMode,
  Preferences,
} from "./harness";
import { Herdr, herdrFailureReason, isSettled, RUN_LABEL, HerdrError } from "./herdr";
import type { AgentInfo, AgentStatus } from "./herdr";
import { promptAsync } from "./opencode";
import { isSuperseded, isUnanswered } from "./store";
import { gate } from "./steering-caps";
import { actorOf } from "./audit";
import { keepQueued, readQueue } from "./delivery-queue";
import type { Queued } from "./delivery-queue";
import { treeOf, verifyingOf } from "./verify";
import type { Verifying } from "./verify";
import { agentName, launchedAs, legacyAgentName, reason, unsafePathComponent } from "./naming";
import { machineName } from "./peers";
import type { MachineCatalogue } from "./harness-choice";
import { askRouteTo } from "./handoff";
import { epochMs, nowIso } from "./time";
import { noteContext, noteReminder } from "./metrics";
import type { RecoveryOutcome } from "./metrics";
import { recordUsage } from "./usage-ledger";
import { REMINDER_OPENING, REPAIR_OPENING } from "./usage-ledger-model";
import manifest from "../package.json";
import {
  appliesTo,
  current as currentUsageWindow,
  isFull,
  roomFor,
  subscriptionOf,
  usedFor,
  UsageWindow,
} from "./usage-model";
import type { UsageReading } from "./usage-model";
import { ownCodexReading, USAGE_INTERVAL_MS } from "./usage";
import {
  everyRegistered,
  lineageAgent,
  registerAgent,
  scopeFor,
  verifyIncarnation,
} from "./registry";
import type { AgentEntry, Incarnation } from "./registry";
import { ROLES, steerTarget } from "./steer-target";
import {
  jsonSchemaFor,
  AgentScopes,
  Host,
  Run,
  WorkflowAgents,
  Template,
  WorkflowError,
  panelOf,
  stepFailed,
} from "./sdk";
import type { AskedQuestion, DecisionSpec, HostApi, Projection, Seat } from "./sdk";
import {
  envFileProblems,
  envLines,
  envValues,
  mergeClaudeSettings,
  parseProfile,
  roleProfile,
} from "./profile";
import type { ClaudeOverlay, RoleProfile } from "./profile";
import { isString } from "./schema";
import type { JsonObject } from "./schema";
import { awaitOutput, outputCollected } from "./output-submit";
import { ClaudeSubagents, readSubagents, subagentSettings, subagentVersion } from "./subagents";
import { Collecting, collectingLayer } from "./collecting";
import type { CollectingApi } from "./collecting";
import { holdsBudgetOf, waitForMemory } from "./memory-wait";
import {
  causalKey,
  deliveriesAbout,
  deliveriesOf,
  isSettledDelivery,
  isUnobserved,
  newestById,
  readLedger,
  SENT_STATES,
  toldLine,
} from "./steering";
import { rememberUnsettled } from "./park-recheck";
import type { Records } from "./records";
import { RELAUNCH, RunRecords } from "./run-records";
import { malformedIn, mentionedSkills, renderTemplate, skillMention, skillsIn } from "./template";
import {
  quietSkills,
  SKILL_OVERRIDES_VERSION,
  MAIN_CHECKOUT_SKILLS_VERSION,
} from "./skill-overrides";

export type OutputContract = Schema.Codec<unknown, unknown, never, never>;

export interface AgentAsk {
  readonly runId: string;
  readonly operation: string;
  readonly role: string;
  readonly persona?: string | null;
  readonly agent: string | null;
  readonly workflow: string;
  readonly task: string | null;
  readonly workspace?: string | null;
  readonly cwd: string;
  readonly prompt: string;
  readonly output: string;
  readonly skill: string | null;
  readonly clears?: ReadonlyArray<string>;
  readonly authority?: RunAuthority;
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly claudeSubagents?: ClaudeSubagents;
  readonly permissions: string | null;
  readonly from?: AgentChoice;
  readonly why?: string;
  readonly next?: AgentChoice;
  readonly sequence?: number;
  readonly step?: At;
  readonly outputSubmit?: "file" | "tool";
}

export const AgentChoiceSchema = Schema.Struct({
  ...RanOn.fields,
  claudeSubagents: Schema.optionalKey(ClaudeSubagents),
  from: Schema.optionalKey(RanOn),
  why: Schema.optionalKey(Schema.String),
  next: Schema.optionalKey(RanOn),
});
export type ChosenAgent = typeof AgentChoiceSchema.Type;

export const RanOut = Schema.TaggedStruct("RanOut", {
  why: Schema.String,
  transcript: Schema.NullOr(Schema.String),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  observedAt: Schema.optionalKey(Schema.Finite),
  exhaustion: Schema.optionalKey(
    Schema.Struct({
      at: Schema.Finite,
      account: Schema.NullOr(Schema.String),
      windows: Schema.Array(
        Schema.Struct({
          kind: UsageWindow.fields.kind,
          model: UsageWindow.fields.model,
          resetsAt: UsageWindow.fields.resetsAt,
        }),
      ),
    }),
  ),
});
export type RanOut = typeof RanOut.Type;
const isRanOut = Schema.is(RanOut);
const RanOutJson = Schema.fromJsonString(RanOut);
const encodeRanOut = flow(Schema.encodeResult(RanOutJson), Result.getOrThrow);
type SpentChoice = Pick<RanOut, "why" | "resetsAt" | "observedAt" | "exhaustion"> & {
  readonly on: AgentChoice;
};

const TurnEnded = Schema.TaggedStruct("TurnEnded", { endedAt: Schema.Finite });
const isTurnEnded = Schema.is(TurnEnded);
const CollectedBeforeFallback = Schema.TaggedStruct("CollectedBeforeFallback", {
  text: Schema.String,
});

export const Collected = Schema.Union([Schema.String, Schema.Null, RanOut, TurnEnded]);

// WARNING: uncertainty is reported, never rounded down to nothing happened; a launch unsure it started parks instead.
export class AgentUncertain extends Schema.TaggedError<
  AgentUncertain,
  { readonly brand: unique symbol }
>()("AgentUncertain", {
  operation: Schema.String,
  reason: Schema.String,
}) {}

export class AgentParked extends Schema.TaggedError<
  AgentParked,
  { readonly brand: unique symbol }
>()("AgentParked", {
  operation: Schema.String,
  reason: Schema.String,
  cause: Schema.optionalKey(ParkCause),
}) {}

type Rooted = Incarnation & { readonly root?: Launched["root"] };

const rooted: (
  incarnation: Incarnation | undefined,
  root: Launched["root"],
) => Rooted | undefined = (incarnation, root) =>
  incarnation === undefined
    ? undefined
    : root === undefined
      ? incarnation
      : { ...incarnation, root };

export interface Questions {
  readonly ask: (question: DecisionSpec, asker: string) => Effect.Effect<void>;
  readonly asked: Effect.Effect<ReadonlyArray<AskedQuestion>>;
  readonly close: (decision: string, value: string) => Effect.Effect<void>;
}

export const agentQuestionName = (operation: string, n: number) => `ask-${operation}-${n}`;

const bySender = (answerers: ReadonlyArray<Asker | undefined>) => {
  const groups = new Map<string, { by: Asker | undefined; at: Array<number> }>();
  for (const [at, by] of answerers.entries()) {
    const key = Arr.join(
      Arr.map([by?.origin, by?.from?.run, by?.from?.agent, by?.said], (part) =>
        part === null || part === undefined ? "" : globalThis.String(part),
      ),
      "\0",
    );
    const group = groups.get(key) ?? { by, at: [] };
    group.at.push(at);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const closedAnswer = (operation: string) => `closed: ${operation} finished before it was answered`;
const goneAnswer = (agent: string) => `closed: ${agent} is gone`;

const promptOf = (question: AgentQuestion) =>
  question.header ? `${question.header}: ${question.question}` : question.question;

const answerTitle = (asked: AskedQuestion | undefined) =>
  Option.getOrUndefined(Arr.findFirst(asked?.options ?? [], (one) => one.id === asked?.answer))
    ?.title ?? asked?.answer;

export interface AgentsApi {
  readonly outputFor: (runId: string, operation: string) => string;
  readonly skills: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, string>>;
  readonly outputSubmit: Effect.Effect<"file" | "tool">;
  readonly attachments: (runId: string) => Effect.Effect<ReadonlyArray<Attachment>>;
  readonly handOver: (
    about: Omit<
      HandOverState,
      "revision" | "goal" | "constraints" | "plan" | "checkout" | "reports"
    > & { readonly cwd: string },
  ) => Effect.Effect<HandOver>;
  readonly atCheckout: (cwd: string, plan: string | null) => Effect.Effect<AtDispatch>;
  readonly handOverStale: (
    runId: string,
    seen: Omit<AtDispatch, "dirty"> & { readonly cwd: string; readonly dir: string | null },
  ) => Effect.Effect<void>;
  readonly askRoute: (role: string, lineage: ReadonlyArray<string>) => Effect.Effect<string>;
  readonly pollMs: number;
  readonly collectMs: number;
  readonly unhealthy: (launched: Launched) => Effect.Effect<string>;
  readonly choose: (
    layers: ReadonlyArray<Preferences | undefined>,
    work: { readonly runId: string; readonly operation: string },
    spent?: ReadonlyArray<SpentChoice>,
  ) => Effect.Effect<ChosenAgent, WorkflowError>;
  readonly choiceOf: (
    runId: string,
    agent: string,
  ) => Effect.Effect<
    (ChosenAgent & { readonly sequence: number; readonly outputSubmit: "file" | "tool" }) | null
  >;
  readonly ranOut: (launched: Launched) => Effect.Effect<RanOut>;
  readonly stopped: (launched: Launched, since?: number) => Effect.Effect<string | null>;
  // WARNING: retire parks the Run unless the pane is gone.
  readonly retire: (
    launched: Launched,
    line: string,
    ended?: string,
  ) => Effect.Effect<void, AgentParked>;
  readonly lastLaunch: (runId: string, agent: string) => Effect.Effect<Launched | null>;
  readonly say: (runId: string, line: string) => Effect.Effect<void>;
  readonly stepMessage: (ask: AgentAsk) => { readonly typed: string; readonly prompt: string };
  readonly launch: (
    ask: AgentAsk,
    note?: (why: string | null) => Effect.Effect<void>,
  ) => Effect.Effect<Launched, AgentUncertain | AgentParked>;
  readonly revive: (
    ask: AgentAsk,
    unless?: string | null,
    onlyDeadServer?: boolean,
    usable?: (text: string) => boolean,
  ) => Effect.Effect<boolean, AgentUncertain | AgentParked>;
  readonly handOff: (options: {
    readonly runId: string;
    readonly role: string;
    readonly lineage: ReadonlyArray<string>;
    readonly text: string;
  }) => Effect.Effect<Steered | null, AgentParked>;
  readonly halt: (runId: string, why?: string) => Effect.Effect<Halted>;
  readonly account: (runId: string, heal: boolean) => Effect.Effect<void>;
  readonly collectedDuring: <A, E, R>(
    launched: Launched,
    waiting: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly collect: (
    launched: Launched,
    unless?: string | null,
    questions?: Questions,
    budgetMs?: number,
    usable?: (text: string) => boolean,
  ) => Effect.Effect<string | null, AgentUncertain | AgentParked>;
  readonly peekOutput: (launched: Launched) => Effect.Effect<string | null>;
  readonly usageWaiting: (launched: Launched, incident: RanOut | null) => Effect.Effect<void>;
  readonly usageIncident: (launched: Launched) => Effect.Effect<RanOut | null>;
  readonly endedWithoutOutput: (
    launched: Launched,
    may: Effect.Effect<boolean>,
    questions?: Questions,
  ) => Effect.Effect<void>;
  readonly remind: (
    launched: Launched,
    ordinal: number,
  ) => Effect.Effect<string | null, AgentUncertain | AgentParked>;
  readonly reminded: (
    launched: Launched,
    ordinal: number,
    outcome: RecoveryOutcome,
    waitedMs: number,
  ) => Effect.Effect<void>;
  readonly repair: (
    launched: Launched,
    problem: string,
    unusable: string,
    round?: number,
  ) => Effect.Effect<boolean, AgentUncertain | AgentParked>;
  readonly resumedOutput: (launched: Launched, round: number) => Effect.Effect<string | null>;
  // WARNING: the request is the claim on the delivery: the same one twice is one message, which the ledger refuses a second copy of.
  readonly steer: (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly to?: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: DeliveryMode;
    readonly actor?: Asker;
    readonly workflowNotice?: string;
  }) => Effect.Effect<Steered>;
  readonly atWork: (runId: string) => Effect.Effect<Launched | null>;
  readonly correct: (
    runId: string,
    correction: {
      readonly text: string;
      readonly constraint: string;
      readonly requestId: string;
      readonly attempt: number;
      readonly intentVersion: number;
      readonly mode: DeliveryMode;
    },
  ) => Effect.Effect<boolean>;
  readonly tendQuestions: (
    questionsFor: (runId: string) => Questions,
    askedOf: (
      runs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<AskedQuestion>>>,
    submitted?: (queued: Queued, sent: Steered) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  readonly statusOf: (agent: string) => Effect.Effect<AgentStatus | "gone">;
  readonly resumeLost: (runId: string, run: RunNow) => Effect.Effect<void>;
  readonly onLosses: (resumed: Effect.Effect<void>) => Effect.Effect<void>;
}

export interface RunNow {
  readonly running: Effect.Effect<boolean>;
  readonly authority: Effect.Effect<RunAuthority>;
  readonly questions: Questions;
}

export type DeliveryMode = "boundary" | "now" | "interrupt";

// WARNING: delivered is what herdr shows, never 'accepted for sending': a queued message is not the agent having been given it.
export interface Steered {
  readonly agent: string;
  readonly delivered: boolean;
  readonly delivery?: string;
  readonly detail: string;
  readonly queued?: boolean;
  readonly gone?: boolean;
  readonly observed?: boolean;
  readonly how?: string;
  readonly pane?: string;
  readonly kept?: string;
}

export interface Halted {
  readonly stopped: ReadonlyArray<string>;
  readonly left: ReadonlyArray<string>;
}

export class Agents extends Context.Service<Agents, AgentsApi>()("collie/Agents") {}

export type AgentWork<
  Output extends OutputContract,
  Input extends Readonly<Record<string, Schema.Json>> = never,
> = Doing<Output> & Told<Input>;

export type Told<Input extends Readonly<Record<string, Schema.Json>>> =
  | { readonly instructions: Template<Input>; readonly input: Input }
  | {
      readonly instructions: string;
      readonly input?: Readonly<Record<string, Schema.Json>>;
    };

interface Doing<Output extends OutputContract> {
  readonly operation: string;
  readonly cwd?: string;
  readonly output?: Output;
  readonly role?: string;
  readonly agent?: string;
  readonly workflow?: string;
  readonly skill?: string;
  // WARNING: a push to a self-merging merge request is a merge, so the work parks rather than starts.
  readonly pushes?: boolean;
  readonly clears?: ReadonlyArray<string>;
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly claudeSubagents?: ClaudeSubagents;
  readonly permissions?: PermissionMode;
  readonly seat?: Seat;
  readonly handOver?: HandOverGiven;
  // WARNING: set only where `agent` has not yet run in this Run; the agent it names is ended and found Quiet first.
  readonly takesOver?: { readonly agent: string; readonly why: string };
}

// WARNING: suspending inside the Activity leaves it unrecorded, so a resume asks the forge again; once it has said no, a replay does not.
const untilPushable = (operation: string, cwd: string) =>
  Activity.make({
    name: `${operation}.pushable`,
    execute: Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const read = yield* Effect.result(host.autoMerging(cwd));
      if (read._tag === "Failure") {
        const why = `not pushed: whether it merges itself is unknown: ${read.failure.reason}`;
        yield* host.record(runId, why);
        yield* host.parked(
          runId,
          `${why}. Resume ${runId} once the forge can be read.`,
          "forge-unavailable",
        );
        return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
      }
      const url = read.success;
      if (url === null) {
        return yield* host.parked(runId, null);
      }
      const why = `not pushed: auto-merge is on for ${url}`;
      yield* host.record(runId, why);
      yield* host.parked(runId, `${why}. Turn auto-merge off, then resume ${runId}.`);
      return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
    }),
  });

// WARNING: launch and collection are separate Activities so a replayed collection never starts a second agent; repair is a third, so a restart cannot hand out another.
export const agentWork: <
  Output extends OutputContract = typeof Schema.String,
  Input extends Readonly<Record<string, Schema.Json>> = never,
>(
  given: AgentWork<Output, Input>,
) => Effect.Effect<
  Output["Type"],
  WorkflowError,
  Run | Agents | Host | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> = <
  Output extends OutputContract = typeof Schema.String,
  Input extends Readonly<Record<string, Schema.Json>> = never,
>(
  given: AgentWork<Output, Input>,
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const host = yield* Host;
    const oversight = yield* Effect.serviceOption(Oversight);
    const run = yield* Run;
    const runId = run.id;
    const place = yield* host.place(runId);
    const plain = given.output === undefined;
    // WARNING: Output defaults to Schema.String exactly where no output was given.
    const contract = (given.output ?? Schema.String) as Output;
    const told = given.seat?.instructions ?? given.instructions;
    const work = {
      ...given,
      instructions: told instanceof Template ? told.text : told,
      runId,
      cwd: given.cwd ?? place.cwd,
      workflow: given.workflow ?? run.workflow,
      output: contract,
    };
    // WARNING: the last boundary before money is spent; read as a plain Effect, since an Activity would replay the hold the first attempt saw.
    if (yield* host.held(work.runId)) {
      return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
    }
    if (given.pushes === true) {
      yield* untilPushable(work.operation, work.cwd);
    }
    const unsafe = unsafePathComponent(work.operation);
    if (unsafe !== null) {
      return yield* new WorkflowError({
        reason: `operation "${work.operation}" ${unsafe}`,
      });
    }
    const unclear = clearanceProblem(given.clears ?? []);
    if (unclear !== null) {
      return yield* new WorkflowError({ reason: `${work.operation}: ${unclear}` });
    }
    const output = agents.outputFor(work.runId, work.operation);
    const role = work.role ?? work.operation;
    const skills = yield* agents.skills(skillsIn(work.instructions));
    const held = work.agent === undefined ? null : yield* agents.choiceOf(runId, work.agent);
    const outputSubmit = held?.outputSubmit ?? (yield* agents.outputSubmit);
    const parts: PromptParts = {
      role,
      instructions: work.instructions,
      input: work.input,
      skills,
      cwd: work.cwd,
      output,
      contract: plain ? null : jsonSchemaFor(work.output),
      attachments: yield* agents.attachments(runId),
      outputSubmit,
    };
    const prompt = renderPrompt(parts);
    if (prompt.unfilled.length > 0) {
      return yield* new WorkflowError({
        reason: `${work.operation}: its instructions name ${Arr.join(prompt.unfilled, ", ")}, which nothing this work was given fills`,
      });
    }
    // WARNING: an agent already running on this name is the conversation this continues, so what is asked must agree with it.
    const scopes = yield* AgentScopes;
    const requested = foldPreferences([...scopes, preferencesIn(given)]);
    if (held !== null && !agrees(held, requested)) {
      return yield* new WorkflowError({
        reason: `${work.operation}: ${work.agent} is already running as ${held.harness}/${held.model}, and this work asks for ${requested.harness ?? held.harness}/${requested.model ?? held.model} or a different Claude subagent policy. A conversation cannot become another agent: give this work an agent of its own, or ask for the one it is.`,
      });
    }
    // WARNING: recorded, because a judgement is paid for and a replay must not pay again.
    if (Option.isSome(oversight)) {
      yield* Activity.make({
        name: `${work.operation}.boundary`,
        execute: oversight.value.drift(work.runId, `boundary before ${work.operation}`, "boundary"),
      });
    }
    // WARNING: decided and recorded before anything starts, so recovery, revival and restart all start the agent this work was given.
    const preferred = yield* WorkflowAgents;
    const seated = given.seat ?? (yield* panelOf(role))[0];
    const layers = [
      preferred,
      ceilingIn(seated),
      yield* preferencesFromOptions(place.options).pipe(
        Effect.mapError(
          (cause) => new WorkflowError({ reason: `claudeSubagents: ${String(cause)}` }),
        ),
      ),
      ...scopes,
      ceilingIn(given),
    ];
    const choice = yield* Activity.make({
      name: `${work.operation}.agent`,
      success: AgentChoiceSchema,
      error: WorkflowError,
      execute: held === null ? agents.choose(layers, work) : Effect.succeed(held),
    });
    const ask: Types.Mutable<AgentAsk> = {
      runId: work.runId,
      operation: work.operation,
      role,
      persona: given.seat?.persona ?? null,
      agent: work.agent ?? null,
      workflow: work.workflow ?? work.operation,
      task: place.task,
      workspace: place.workspace,
      cwd: work.cwd,
      output,
      prompt: prompt.text,
      skill: work.skill ?? null,
      harness: choice.harness,
      model: choice.model,
      effort: choice.effort,
      permissions: work.permissions ?? null,
      authority: place.authority,
      outputSubmit,
    };
    if (choice.claudeSubagents !== undefined) {
      ask.claudeSubagents = choice.claudeSubagents;
    }
    fellBack(ask, choice.from, choice.why);
    if (choice.next !== undefined) {
      ask.next = choice.next;
    }
    if (held !== null && held.sequence > 1) {
      ask.sequence = held.sequence;
    }
    const at = yield* CurrentStep;
    if (at !== null) {
      ask.step = at;
    }
    if (given.clears !== undefined) {
      ask.clears = given.clears;
    }
    if ((given.clears ?? []).length > 0) {
      const step = agents.stepMessage(ask);
      const typed = Array.from(step.typed).length;
      if (typed > dispatch.PASTE_BUDGET.chars) {
        return yield* new WorkflowError({
          reason: `${work.operation}: its step message would be ${typed} characters typed, over the ${dispatch.PASTE_BUDGET.chars} Claude Code still shows as typed; its prompt is ${step.prompt}. Shorten its Clearance, or use a shorter state directory.`,
        });
      }
    }

    const watching = <A, E, R>(collecting: Effect.Effect<A, E, R>) => {
      if (Option.isNone(oversight)) {
        return collecting;
      }
      const look = oversight.value.checkpoints(work.runId, work.operation);
      // WARNING: first to finish, failure included, wins, so a collection never waits on a watch that never ends.
      return Effect.raceFirst(
        collecting,
        look.pipe(
          Effect.repeat(Schedule.spaced(Duration.millis(agents.pollMs))),
          Effect.andThen(Effect.never),
        ),
      ).pipe(Effect.tap(() => look));
    };
    const carded = <A>(value: A) =>
      Option.isNone(oversight)
        ? Effect.succeed(value)
        : Activity.make({
            name: `${work.operation}.card`,
            execute: oversight.value.drift(work.runId, `${work.operation} collected`, "none").pipe(
              Effect.andThen(
                oversight.value.card(work.runId, {
                  ...narrativeOf(value),
                  kind: kindForRole(role),
                  step: work.operation,
                  claims: [`wrote ${output}`],
                }),
              ),
            ),
          }).pipe(Effect.as(value));

    const harnessSaid = (on: Launched, why: string) =>
      `its harness ${said(choiceOfLaunch(on))} said "${why}". Collie keeps collecting it; tell it to carry on once its harness is fixed.`;
    const pastBudget = (on: Launched, waiting?: string) =>
      Effect.map(agents.stopped(on), (why) => {
        const idle =
          waiting ??
          `${on.agent} has written nothing to ${output} after ${Math.round(agents.collectMs / 60_000)} minutes idle`;
        if (why !== null) {
          return `${idle}; ${harnessSaid(on, why)}`;
        }
        return waiting === undefined
          ? `${idle}. Collie keeps collecting it; if it has stopped, ask it to write it.`
          : `${idle}. Collie keeps collecting it.`;
      });
    const parksOnStop = (on: Launched, since?: number) =>
      Effect.gen(function* () {
        let why = yield* agents.stopped(on, since);
        while (why === null) {
          yield* Effect.sleep(Duration.millis(agents.pollMs));
          why = yield* agents.stopped(on, since);
        }
        yield* host.parked(
          runId,
          `${on.agent} stopped before writing ${output}: ${harnessSaid(on, why)}`,
          "output-absent",
        );
        return yield* Effect.never;
      });
    const questions: Questions = {
      ask: (question, asker) => host.asking(runId, question, asker),
      asked: host.asked(runId),
      close: (decision, value) => host.close(runId, decision, value),
    };
    const haltLate = agents
      .halt(runId)
      .pipe(
        Effect.flatMap(({ left }) =>
          left.length === 0 ? Effect.void : host.parked(runId, Arr.join(left, "; ")),
        ),
      );
    const usable = (text: string) => decodeOutput(work.output, text, plain).ok;
    const problemIn = (text: string) => {
      const read = decodeOutput(work.output, text, plain);
      return read.ok ? null : read.problem;
    };
    // WARNING: uninterruptible, so a stop racing a restart waits for it and finds its agent to stop.
    const reviving = (from: AgentAsk, unless?: string | null, onlyDeadServer = false) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* host.stopRequested(runId)) {
            return false;
          }
          const revived = yield* agents.revive(
            from,
            unless,
            onlyDeadServer,
            unless == null ? undefined : usable,
          );
          if (revived && (yield* host.stopRequested(runId))) {
            yield* haltLate;
          }
          return revived;
        }),
      );
    // WARNING: a stale working status must not hide a dead server for the whole idle budget.
    const recovering = (on: Launched, from: AgentAsk, unless?: string | null) =>
      Effect.raceFirst(
        reviving(from, unless, true).pipe(
          Effect.repeat(Schedule.spaced(Duration.millis(agents.pollMs))),
          Effect.andThen(Effect.never),
        ),
        agents.unhealthy(on).pipe(
          Effect.flatMap((why) => host.parked(runId, why, "output-absent")),
          Effect.andThen(Effect.never),
        ),
      );
    const untilWritten = (on: Launched, from: AgentAsk, canRevive = true) =>
      Effect.gen(function* () {
        for (;;) {
          if (canRevive) {
            yield* reviving(from);
          }
          const text = yield* watching(agents.collect(on, null, questions));
          if (text !== null) {
            return text;
          }
        }
      });
    const remindable = Effect.gen(function* () {
      if ((yield* host.held(runId)) || (yield* host.stopRequested(runId))) {
        return false;
      }
      return !Arr.some(yield* host.asked(runId), (one) => one.answer === null);
    });
    const collecting = (on: Launched, from: AgentAsk, waiting?: string) => {
      const awaited = awaitOutput(runId, on.agent, on.output, problemIn);
      const output = agents.collectedDuring(
        on,
        Effect.raceFirst(
          watching(agents.collect(on, null, questions)).pipe(
            Effect.filterOrElse(
              (text) => text !== null,
              () =>
                pastBudget(on, waiting).pipe(
                  Effect.flatMap((why) => host.parked(runId, why, "idle-budget")),
                  Effect.andThen(untilWritten(on, from, waiting === undefined)),
                ),
            ),
          ),
          parksOnStop(on),
        ),
      );
      const ended = agents.endedWithoutOutput(on, remindable, questions).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((endedAt) => TurnEnded.make({ endedAt })),
      );
      return Effect.andThen(
        awaited,
        stoppable(
          parkedWhenStuck(
            waiting === undefined
              ? Effect.gen(function* () {
                  // WARNING: reconciles a crash before the incident was journaled, before idle reminders race it.
                  const incident = yield* agents.usageIncident(on);
                  if (incident !== null) {
                    return incident;
                  }
                  yield* reviving(from);
                  return yield* Effect.raceFirst(
                    Effect.raceFirst(Effect.raceFirst(output, ended), agents.ranOut(on)),
                    recovering(on, from),
                  );
                })
              : output,
            host,
            work.runId,
          ),
          host,
          work.runId,
          agents.pollMs,
        ),
      );
    };
    let reminder: { on: Launched; ordinal: number; endedAt: number } | null = null;
    // WARNING: separate Activities keep a replay from spending a reminder twice.
    const reminding = (at: string, on: Launched, from: AgentAsk, first: typeof Collected.Type) =>
      Effect.gen(function* () {
        reminder = null;
        let collected = first;
        const endedAt = isTurnEnded(first) ? first.endedAt : 0;
        const sent: Array<string> = [];
        while (isTurnEnded(collected)) {
          const n = sent.length + 1;
          const asked =
            n > OUTPUT_REMINDERS
              ? null
              : yield* Activity.make({
                  name: `${at}.remind-${n}`,
                  success: Schema.NullOr(Schema.String),
                  error: AgentUncertain,
                  execute: stoppable(
                    parkedWhenStuck(agents.remind(on, n), host, work.runId),
                    host,
                    work.runId,
                    agents.pollMs,
                  ),
                });
          if (asked === null) {
            const why =
              sent.length === 0
                ? `${on.agent} ended its turn without writing ${output}, and could not be reminded to; its log says why. A chat message is not its Output. Collie keeps collecting it; ask it to write it.`
                : `${on.agent} ended its turn without writing ${output}, and again after each of ${sent.length} reminders, sent ${Arr.join(sent, " and ")}. A chat message is not its Output. Collie keeps collecting it; ask it to write it, or why it cannot.`;
            return yield* Activity.make({
              name: `${at}.output-absent`,
              success: Collected,
              error: AgentUncertain,
              execute: stoppable(
                parkedWhenStuck(
                  host
                    .parked(runId, why, "output-absent")
                    .pipe(Effect.andThen(untilWritten(on, from))),
                  host,
                  work.runId,
                ),
                host,
                work.runId,
                agents.pollMs,
              ),
            });
          }
          sent.push(asked);
          reminder = { on, ordinal: n, endedAt };
          collected = yield* Activity.make({
            name: `${at}.remind-${n}.collect`,
            success: Collected,
            error: AgentUncertain,
            execute: collecting(on, from),
          });
        }
        return collected;
      });
    const recovered = () => {
      const pending = reminder;
      return pending === null
        ? Effect.void
        : Activity.make({
            name: `${work.operation}.reminder-recovered`,
            execute: Effect.flatMap(Clock.currentTimeMillis, (now) =>
              agents.reminded(pending.on, pending.ordinal, "output-written", now - pending.endedAt),
            ),
          });
    };
    const launching = (next: AgentAsk) =>
      Effect.gen(function* () {
        const instance = yield* WorkflowEngine.WorkflowInstance;
        if (yield* host.stopRequested(runId)) {
          return yield* Workflow.suspend(instance);
        }
        const launched = yield* parkedWhenStuck(
          agents
            .launch(next, (why) => host.parked(work.runId, why))
            .pipe(
              // WARNING: a stop that landed while a start failed or parked still reaches the server it left.
              Effect.tapError(() =>
                Effect.gen(function* () {
                  if (yield* host.stopRequested(runId)) {
                    yield* haltLate;
                  }
                }),
              ),
            ),
          host,
          work.runId,
        );
        if (yield* host.stopRequested(runId)) {
          yield* haltLate;
          return yield* Workflow.suspend(instance);
        }
        return launched;
      });
    const handOverFrom = (outgoing: Launched, transcript: string | null) =>
      Effect.gen(function* () {
        const evidence = yield* host.evidence(runId, work.cwd);
        return yield* agents.handOver({
          run: runId,
          step: work.operation,
          agent: outgoing.agent,
          incarnation: outgoing.sequence ?? 1,
          cwd: work.cwd,
          given: given.handOver ?? {},
          base: evidence.mergeBase ?? null,
          verifications: evidence.verifications,
          checks: Arr.map(yield* host.approved(runId), (one) => one.name),
          asked: yield* host.asked(runId),
          transcript,
        });
      });
    const plan = given.handOver?.plan ?? null;
    // WARNING: the prompt is rebuilt once if the checkout moved; a second move parks.
    const dispatching = (
      handed: HandOver,
      rebuild: Effect.Effect<HandOver>,
      successor: string,
      why: string,
    ) =>
      Effect.gen(function* () {
        const dispatched = yield* atDispatch(handed, agents.atCheckout(work.cwd, plan), rebuild);
        if (dispatched === null) {
          const seen = yield* agents.atCheckout(work.cwd, plan);
          yield* agents.handOverStale(runId, {
            head: seen.head,
            plan: seen.plan,
            cwd: work.cwd,
            dir: plan,
          });
          yield* host.parked(
            runId,
            `${successor}'s hand-over was rebuilt once and the checkout moved again (head ${seen.head}, plan revision ${seen.plan ?? "none"}): no agent takes the work from a stale picture. This Run goes on once the checkout holds still`,
            "hand-over-stale",
          );
          return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
        }
        return renderPrompt({ ...parts, handover: renderHandOver(dispatched, why) }).text;
      });
    const takingOver = given.takesOver;
    const predecessor =
      takingOver === undefined || work.agent === undefined
        ? null
        : yield* Activity.make({
            name: `${work.operation}.take-over`,
            success: Schema.NullOr(Launched),
            execute: Effect.gen(function* () {
              if ((yield* agents.lastLaunch(runId, work.agent!)) !== null) {
                return null;
              }
              return yield* agents.lastLaunch(runId, takingOver.agent);
            }),
          });
    let current: Launched;
    if (predecessor === null || takingOver === undefined) {
      current = yield* Activity.make({
        name: `${work.operation}.launch`,
        success: Launched,
        error: AgentUncertain,
        execute: launching(ask),
      });
    } else {
      const handed = yield* Activity.make({
        name: `${work.operation}.take-over.hand-over`,
        success: HandOver,
        execute: handOverFrom(predecessor, null),
      });
      yield* Activity.make({
        name: `${work.operation}.take-over.close`,
        error: AgentUncertain,
        execute: parkedWhenStuck(
          agents.retire(
            predecessor,
            `${work.operation}: ${predecessor.agent} ${takingOver.why}; ${work.agent} takes its work over`,
            takingOver.why,
          ),
          host,
          work.runId,
        ),
      });
      current = yield* Activity.make({
        name: `${work.operation}.launch`,
        success: Launched,
        error: AgentUncertain,
        execute: Effect.gen(function* () {
          if (yield* host.stopRequested(runId)) {
            return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
          }
          ask.prompt = yield* dispatching(
            handed,
            handOverFrom(predecessor, null),
            work.agent ?? work.operation,
            `it ${takingOver.why}`,
          );
          return yield* launching(ask);
        }),
      });
    }
    let currentAsk: AgentAsk = ask;
    let collected = yield* reminding(
      work.operation,
      current,
      ask,
      yield* Activity.make({
        name: `${work.operation}.collect`,
        success: Collected,
        error: AgentUncertain,
        execute: collecting(current, ask),
      }),
    );
    // WARNING: each agent that ran out is closed and replaced by its own Activity, so a replay starts no third agent.
    const spent: Array<SpentChoice> = [];
    for (let n = 1; isRanOut(collected); n++) {
      const out: RanOut = collected;
      const on = choiceOfLaunch(current);
      spent.push({ ...out, on });
      yield* agents.usageWaiting(current, out);
      const next = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.agent`,
        success: AgentChoiceSchema,
        error: WorkflowError,
        execute: agents.choose(layers, work, spent),
      });
      if (nothingHasRoom(next)) {
        const room = Effect.gen(function* () {
          while (nothingHasRoom(yield* agents.choose(layers, work, spent))) {
            yield* Effect.sleep(READING_EVERY_MS);
          }
          return out;
        }).pipe(Effect.mapError((cause) => asUncertain(work.operation, cause)));
        collected = yield* Activity.make({
          name: `${work.operation}.fallback-${n}.collect`,
          success: Collected,
          error: AgentUncertain,
          execute: agents
            .say(runId, `${work.operation}: ${said(on)} ran out (${out.why}); ${next.why}`)
            .pipe(
              Effect.andThen(
                host.usageWait(runId, {
                  account: subscriptionOf(on) ?? on.harness,
                  resetsAt: out.resetsAt ?? null,
                }),
              ),
              Effect.andThen(
                Effect.raceFirst(
                  collecting(
                    current,
                    currentAsk,
                    `${current.agent} ran out (${out.why}) before writing ${output}; ${next.why}`,
                  ),
                  room,
                ),
              ),
              Effect.ensuring(host.usageWait(runId, null)),
            ),
        });
        if (isRanOut(collected)) {
          continue;
        }
        break;
      }
      const sequence = (current.sequence ?? 1) + 1;
      const successor = agentName(runId, work.agent ?? work.operation, null, sequence);
      const handOverNow = handOverFrom(current, out.transcript);
      const handed = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.hand-over`,
        success: HandOver,
        execute: handOverNow,
      });
      const ranOutWhy = `its subscription ran out (${out.why}) on ${said(on)}`;
      const nextAsk: Types.Mutable<AgentAsk> = {
        ...currentAsk,
        harness: next.harness,
        model: next.model,
        effort: next.effort,
        sequence,
        prompt: renderPrompt({ ...parts, handover: renderHandOver(handed, ranOutWhy) }).text,
        // WARNING: the chain's first agent, which a later ask for this agent may still name.
        from: currentAsk.from ?? on,
        why: out.why,
      };
      delete nextAsk.claudeSubagents;
      if (next.claudeSubagents !== undefined) {
        nextAsk.claudeSubagents = next.claudeSubagents;
      }
      yield* Activity.make({
        name: `${work.operation}.fallback-${n}.close`,
        error: AgentUncertain,
        execute: parkedWhenStuck(
          agents.retire(
            current,
            `${work.operation}: ${said(on)} ran out (${out.why}) — continuing on ${said(next)} as ${successor}`,
          ),
          host,
          work.runId,
        ),
      });
      yield* agents.usageWaiting(current, null);
      const replacement = yield* Activity.make({
        name: `${work.operation}.fallback-${n}.launch`,
        success: Schema.Union([Launched, CollectedBeforeFallback]),
        error: AgentUncertain,
        execute: Effect.gen(function* () {
          const instance = yield* WorkflowEngine.WorkflowInstance;
          if (yield* host.stopRequested(runId)) {
            return yield* Workflow.suspend(instance);
          }
          // WARNING: retirement proved Quiet, but a tool may have finished its Output while it stopped.
          const late = yield* agents.peekOutput(current);
          if (late !== null && decodeOutput(work.output, late, plain).ok) {
            if (yield* host.stopRequested(runId)) {
              return yield* Workflow.suspend(instance);
            }
            yield* host.parked(runId, null);
            return CollectedBeforeFallback.make({ text: late });
          }
          nextAsk.prompt = yield* dispatching(handed, handOverNow, successor, ranOutWhy);
          return yield* launching(nextAsk);
        }),
      });
      if (Schema.is(CollectedBeforeFallback)(replacement)) {
        collected = replacement.text;
        break;
      }
      current = replacement;
      currentAsk = nextAsk;
      collected = yield* reminding(
        `${work.operation}.fallback-${n}`,
        current,
        nextAsk,
        yield* Activity.make({
          name: `${work.operation}.fallback-${n}.collect`,
          success: Collected,
          error: AgentUncertain,
          execute: collecting(current, nextAsk),
        }),
      );
    }
    const first = isString(collected) ? collected : null;
    if (first === null) {
      return yield* new WorkflowError({
        reason: `${current.agent} wrote nothing to ${output}`,
      });
    }
    const read = decodeOutput(work.output, first, plain);
    if (read.ok) {
      yield* outputCollected(runId, current.agent, first);
      yield* agents.usageWaiting(current, null);
      yield* recovered();
      return yield* carded(read.value);
    }

    let latest = first;
    const recollecting = (unusable: string, since: number) =>
      Effect.gen(function* () {
        yield* awaitOutput(runId, current.agent, current.output, problemIn);
        for (;;) {
          const text = yield* watching(
            agents.collect(current, unusable, questions, undefined, usable),
          );
          if (text !== null || (yield* agents.stopped(current, since)) === null) {
            return text;
          }
          yield* reviving(currentAsk, unusable);
        }
      });
    // WARNING: each repair is its own Activity, so a restart finds a repair that happened, not an allowance that came back.
    const repairing = (round: number, unusable: string, problem: string) =>
      Effect.gen(function* () {
        const suffix = round === 1 ? "" : `-${round}`;
        const since = yield* Activity.make({
          name: `${work.operation}.repair${suffix}.since`,
          success: Schema.Finite,
          execute: Clock.currentTimeMillis,
        });
        const asked = yield* Activity.make({
          name: `${work.operation}.repair${suffix}`,
          success: Schema.Boolean,
          error: AgentUncertain,
          execute: stoppable(
            parkedWhenStuck(
              reviving(currentAsk, unusable).pipe(
                Effect.flatMap((revived) =>
                  revived ? Effect.succeed(true) : agents.repair(current, problem, unusable, round),
                ),
              ),
              host,
              work.runId,
            ),
            host,
            work.runId,
            agents.pollMs,
          ),
        });
        const again = !asked
          ? null
          : yield* Activity.make({
              name: `${work.operation}.recollect${suffix}`,
              success: Schema.NullOr(Schema.String),
              error: AgentUncertain,
              execute: stoppable(
                parkedWhenStuck(
                  reviving(currentAsk, unusable).pipe(
                    Effect.andThen(
                      Effect.raceFirst(
                        Effect.raceFirst(
                          recollecting(unusable, since),
                          parksOnStop(current, since),
                        ),
                        recovering(current, currentAsk, unusable),
                      ),
                    ),
                  ),
                  host,
                  work.runId,
                ),
                host,
                work.runId,
                agents.pollMs,
              ),
            });
        if (again === null) {
          return { ok: false as const, problem: `did not write ${output} again: ${problem}` };
        }
        latest = again;
        const repaired = decodeOutput(work.output, again, plain);
        return repaired.ok
          ? repaired
          : { ok: false as const, problem: `${output} is still unusable: ${repaired.problem}` };
      });
    let repaired = yield* repairing(1, first, read.problem);
    for (let round = 1; !repaired.ok; round++) {
      const why = `${current.agent} ${repaired.problem}. Correct it, then resume ${runId}.`;
      const now = yield* Activity.make({
        name: `${work.operation}.parked-${round}`,
        success: Schema.String,
        execute: Effect.gen(function* () {
          const resumed = yield* agents.resumedOutput(current, round);
          if (resumed !== null) {
            return resumed;
          }
          yield* stepFailed(why);
          yield* host.parked(runId, why, "step-failed");
          return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
        }),
      });
      latest = now;
      const reread = decodeOutput(work.output, now, plain);
      repaired = reread.ok ? reread : yield* repairing(round + 1, now, reread.problem);
    }
    yield* outputCollected(runId, current.agent, latest);
    yield* recovered();
    yield* agents.usageWaiting(current, null);
    return yield* carded(repaired.value);
  }).pipe(
    Effect.catchTag("AgentUncertain", (cause) =>
      Effect.fail(
        new WorkflowError({
          reason: `${cause.operation}: ${cause.reason}. Nothing here says the agent did no work.`,
        }),
      ),
    ),
  );

const fellBack = (
  onto: { from?: AgentChoice; why?: string },
  from: AgentChoice | null | undefined,
  why: string | null | undefined,
) => {
  if (from !== null && from !== undefined) {
    onto.from = from;
  }
  if (why !== null && why !== undefined) {
    onto.why = why;
  }
};

const agrees: (held: ChosenAgent, requested: Preferences) => boolean = (held, requested) => {
  const subagents =
    requested.claudeSubagents?.model === DEFAULT_MODEL
      ? { ...requested.claudeSubagents, model: HARNESSES.claude?.defaultModel ?? DEFAULT_MODEL }
      : requested.claudeSubagents;
  if (
    held.harness === "claude" &&
    subagents !== undefined &&
    !Arr.every(
      Arr.map(Struct.keys(subagents), (key) => [key, subagents[key]] as const),
      ([key, value]) =>
        Boolean(
          Arr.some(
            Arr.map(
              Struct.keys(held.claudeSubagents ?? {}),
              (key) => [key, (held.claudeSubagents ?? {})[key]] as const,
            ),
            ([name, actual]) => name === key && actual === value,
          ),
        ),
    )
  ) {
    return false;
  }
  const is = (on: AgentChoice) =>
    (requested.harness === undefined || requested.harness === on.harness) &&
    (requested.model === undefined || requested.model === on.model) &&
    (requested.effort === undefined || requested.effort === on.effort);
  return is(held) || (held.from !== undefined && is(held.from));
};

export const handOffWork: (given: {
  readonly operation: string;
  readonly role: string;
  readonly text: string;
  readonly lineage?: ReadonlyArray<string>;
}) => Effect.Effect<
  string | null,
  WorkflowError,
  Run | Agents | Host | WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
> = (given) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const host = yield* Host;
    const runId = (yield* Run).id;
    const options = {
      ...given,
      runId,
      lineage: given.lineage ?? (yield* host.place(runId)).lineage,
    };
    return yield* Activity.make({
      name: `${options.operation}.handoff`,
      success: Schema.NullOr(Schema.String),
      error: AgentUncertain,
      execute: parkedWhenStuck(
        agents
          .handOff(options)
          .pipe(Effect.map((sent) => (sent?.delivered === true ? sent.agent : null))),
        host,
        runId,
      ),
    });
  }).pipe(
    Effect.catchTag("AgentUncertain", (cause) =>
      Effect.fail(new WorkflowError({ reason: `${cause.operation}: ${cause.reason}` })),
    ),
  );

// WARNING: the Activity is left unfinished so a resume runs it again: the launch finds its agent and the same delivery goes out.
const parkedWhenStuck: <A>(
  sending: Effect.Effect<A, AgentUncertain | AgentParked>,
  host: HostApi,
  runId: string,
) => Effect.Effect<A, AgentUncertain, WorkflowEngine.WorkflowInstance> = <A>(
  sending: Effect.Effect<A, AgentUncertain | AgentParked>,
  host: HostApi,
  runId: string,
) =>
  sending.pipe(
    Effect.tap(() => host.parked(runId, null)),
    Effect.catchTag("AgentParked", (parked) =>
      Effect.gen(function* () {
        yield* host.parked(runId, parked.reason, parked.cause);
        return yield* Workflow.suspend(yield* WorkflowEngine.WorkflowInstance);
      }),
    ),
  );

// WARNING: the suspension is the wait's own, never the workflow's, or the collection is abandoned rather than parked.
const stoppable: <A, E>(
  collecting: Effect.Effect<A, E, WorkflowEngine.WorkflowInstance>,
  host: HostApi,
  runId: string,
  pollMs: number,
) => Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance> = <A, E>(
  collecting: Effect.Effect<A, E, WorkflowEngine.WorkflowInstance>,
  host: HostApi,
  runId: string,
  pollMs: number,
) =>
  Effect.gen(function* () {
    const wait = yield* WorkflowEngine.WorkflowInstance;
    const raced = yield* Effect.raceFirst(
      collecting.pipe(
        Effect.exit,
        Effect.map((exit) => ({ collected: true as const, exit })),
      ),
      untilStopped(host, runId, pollMs).pipe(Effect.as({ collected: false as const })),
    );
    // WARNING: a stop closes the agent, which can fail this before the stop is seen; the work waits for the resume either way.
    if (!raced.collected || (yield* host.stopRequested(runId))) {
      return yield* Workflow.suspend(wait);
    }
    return yield* raced.exit;
  });

const untilStopped = (host: HostApi, runId: string, pollMs: number) =>
  host
    .stopRequested(runId)
    .pipe(
      Effect.repeat({ until: Boolean, schedule: Schedule.spaced(Duration.millis(pollMs)) }),
      Effect.asVoid,
      Effect.orDie,
    );

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const asJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json));

// WARNING: every issue at once, since fixing them one round trip at a time spends the repair on arithmetic.
export function decodeOutput<Output extends OutputContract>(
  contract: Output,
  text: string,
  plain = false,
) {
  if (plain) {
    const decoded = Schema.decodeResult(contract)(Str.trim(text));
    const returned: Read<Output["Type"]> =
      decoded._tag === "Success"
        ? { ok: true, value: decoded.success }
        : { ok: false, problem: decoded.failure.message };
    return returned;
  }
  const parsed = asJson(text);
  if (parsed._tag === "Failure") {
    const returned: Read<Output["Type"]> = {
      ok: false,
      problem: `it is not JSON: ${parsed.failure.message}`,
    };
    return returned;
  }
  const decoded = Schema.decodeResult(contract, { errors: "all" })(parsed.success);
  const returned: Read<Output["Type"]> =
    decoded._tag === "Success"
      ? { ok: true, value: decoded.success }
      : { ok: false, problem: decoded.failure.message };
  return returned;
}

export interface PromptParts {
  readonly role: string;
  readonly instructions: string;
  readonly output: string;
  readonly contract: Projection | null;
  readonly input?: Readonly<Record<string, Schema.Json>>;
  readonly skills?: ReadonlyMap<string, string>;
  readonly cwd?: string;
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly handover?: string;
  readonly outputSubmit?: "file" | "tool";
}

export function promptFor(parts: PromptParts) {
  return renderPrompt(parts).text;
}

function renderPrompt(parts: PromptParts) {
  const given = {
    ...parts.input,
    role: parts.role,
    cwd: parts.cwd ?? "",
    output_path: parts.output,
  };
  const rendered = renderTemplate(parts.instructions, given, {
    skill: skillMention(parts.skills ?? new Map()),
  });
  const unfilled = [
    ...Arr.map(rendered.missing, (name) => `{{${name}}}`),
    ...malformedIn(parts.instructions),
  ];
  const text = Arr.join(
    Arr.filter(
      [
        Str.trim(rendered.text),
        attachmentsSection(parts.attachments ?? []),
        parts.handover ?? "",
        parts.outputSubmit === "tool"
          ? `When you are done, submit your result ${parts.contract === null ? "as plain text" : "as JSON"} with the collie_submit Collie tool, as its \`output\`. It answers "accepted", or with every problem it found and nothing kept: correct them and submit again.`
          : `When you are done, write your result ${parts.contract === null ? "as plain text" : "as JSON"} to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${parts.output}`,
        parts.contract === null ? "" : contractSection(parts.contract),
      ],
      (part) => part !== "",
    ),
    "\n\n",
  );
  return { text, unfilled };
}

function attachmentsSection(attachments: ReadonlyArray<Attachment>) {
  if (attachments.length === 0) {
    return "";
  }
  return Arr.join(
    [
      "Files given to this Run, which you can open like any other:",
      ...Arr.map(
        attachments,
        (one) => `- ${one.name} (${one.mediaType}, ${one.size} bytes): ${one.path}`,
      ),
    ],
    "\n",
  );
}

function contractSection(contract: Projection) {
  const limits =
    contract.limits.length === 0
      ? ""
      : `\n\nThe drawing says less than the contract does at: ${Arr.join(contract.limits, "; ")}. Those are still checked.`;
  if (contract.document === null) {
    return `That file is checked against a schema this build cannot draw${limits || "."}`;
  }
  return `That file must match this contract. Where a field carries a description, it is asking for your judgment — answer it, do not fill it in.\n\n\`\`\`json\n${stringifyJson(contract.document, 2)}\n\`\`\`${limits}`;
}

type DeliveringHerdr = Pick<Herdr, "agentPrompt" | "agentList" | "agentSendKeys" | "agentStatus">;

export interface AgentHost {
  readonly dir: string;
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly harness: string;
  readonly model: string;
  readonly effort?: string;
  readonly models?: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly catalogue?: Effect.Effect<MachineCatalogue>;
  readonly readings?: Effect.Effect<ReadonlyArray<UsageReading>>;
  readonly ownReading?: (agent: string) => Effect.Effect<UsageReading | null>;
  readonly fallbacks?: Effect.Effect<ReadonlyArray<string>>;
  readonly permissions: PermissionMode;
  readonly trust?: Defaults["trust"];
  readonly compactAtTokens: number;
  readonly pollMs?: number;
  readonly collectMs?: number;
  readonly version?: typeof installedVersion;
  readonly readyMs?: number;
  readonly compactionWaitMs?: number;
  readonly confirmGraceMs?: number;
  readonly observeMs?: number;
  readonly patience?: dispatch.Patience;
  readonly stopMs?: number;
  readonly ports?: CompactionPorts;
  readonly help?: typeof installedHelp;
  readonly self?: ReadonlyArray<string>;
  readonly checkout?: (cwd: string) => Effect.Effect<CheckoutNow>;
}

type AgentServices = FileSystem.FileSystem | Path.Path | PlatformServices | ForgeHttp | Records;

const DEFAULT_POLL_MS = 2000;
const READING_EVERY_MS = 60_000;

const choiceOfLaunch: (launched: Launched) => AgentChoice = (launched) => {
  const choice: Types.Mutable<AgentChoice> = {
    harness: launched.harness,
    model: launched.model ?? DEFAULT_MODEL,
    effort: launched.effort ?? null,
  };
  if (launched.claudeSubagents !== undefined) {
    choice.claudeSubagents = launched.claudeSubagents;
  }
  return choice;
};

const nothingHasRoom = (chosen: ChosenAgent) =>
  chosen.from === undefined && chosen.why !== undefined;

const sameUsage = (one: AgentChoice, other: AgentChoice) => {
  const drawn = subscriptionOf(one);
  return said(one) === said(other) || (drawn !== null && drawn === subscriptionOf(other));
};

// WARNING: old incidents cannot prove their account or window; new ones record observedAt so exhaustion cannot take this compatibility path.
const legacyRetryAvailable = (
  spent: SpentChoice,
  readings: ReadonlyArray<UsageReading>,
  now: number,
) => {
  if (spent.observedAt !== undefined || spent.resetsAt == null) {
    return false;
  }
  const previousReset = epochMs(spent.resetsAt);
  if (!Number.isFinite(previousReset)) {
    return false;
  }
  const matching = Arr.filter(
    readings,
    (reading) => reading.subscription === subscriptionOf(spent.on),
  );
  const reading = matching.length === 1 ? matching[0] : undefined;
  if (reading === undefined || reading.problem !== null || !reading.account) {
    return false;
  }
  const at = epochMs(reading.at);
  if (!Number.isFinite(at) || at > now || now - at > USAGE_INTERVAL_MS) {
    return false;
  }
  const windows = Arr.filter(reading.windows, (window) => appliesTo(window, spent.on.model));
  return (
    windows.length > 0 &&
    Arr.every(
      windows,
      (window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && !isFull(window),
    ) &&
    Arr.some(windows, (window) => {
      if (window.resetsAt === null) {
        return false;
      }
      const nextReset = epochMs(window.resetsAt);
      return Number.isFinite(nextReset) && nextReset > previousReset && nextReset > now;
    })
  );
};

const usageRecovered = (spent: SpentChoice, readings: ReadonlyArray<UsageReading>, now: number) => {
  const resetPassed = (at: string | null | undefined) =>
    at != null && Number.isFinite(epochMs(at)) && epochMs(at) <= now;
  const held = spent.exhaustion;
  if (held === undefined) {
    return resetPassed(spent.resetsAt) || legacyRetryAvailable(spent, readings, now);
  }
  if (held.windows.length === 0 || !Number.isFinite(held.at) || held.at > now) {
    return false;
  }
  return Arr.every(held.windows, (window) => {
    if (resetPassed(window.resetsAt)) {
      return true;
    }
    if (window.resetsAt === null || !Number.isFinite(epochMs(window.resetsAt))) {
      return false;
    }
    const previousReset = epochMs(window.resetsAt);
    return (
      held.account !== null &&
      Arr.some(
        readings,
        (reading) =>
          reading.subscription === subscriptionOf(spent.on) &&
          reading.account === held.account &&
          reading.problem === null &&
          epochMs(reading.at) > held.at &&
          epochMs(reading.at) <= now &&
          now - epochMs(reading.at) <= USAGE_INTERVAL_MS &&
          Arr.some(
            reading.windows,
            (next) =>
              next.kind === window.kind &&
              next.model === window.model &&
              !isFull(next) &&
              next.resetsAt !== null &&
              epochMs(next.resetsAt) > previousReset,
          ),
      )
    );
  });
};

const READY_TIMEOUT_MS = 120_000;

// WARNING: longer than herdr takes to see a taken prompt become a turn, even under load.
const CONFIRM_GRACE_MS = 15_000;
const confirmGrace = Config.Duration("COLLIE_CONFIRM_GRACE").pipe(
  Config.withDefault(Duration.millis(CONFIRM_GRACE_MS)),
  Effect.orDie,
);

const OBSERVE_MS = 20_000;

// WARNING: herdr still lists an agent whose process has gone, and refuses it with this message.
const inactive = (refusal: string) => /not an active named agent/.test(refusal);

const isGone = (agent: string, listed: ReadonlyArray<AgentInfo>, refusal: string) =>
  !Arr.some(listed, (one) => one.name === agent) || inactive(refusal);
const DEFAULT_COLLECT_MS = 2 * 60 * 60 * 1000;

export const agentsLayer: (
  host: AgentHost,
) => Layer.Layer<Agents | Collecting, never, AgentServices> = (host) =>
  Layer.effect(Agents)(
    Effect.gen(function* () {
      const services = yield* Effect.context<AgentServices>();
      return Agents.of(
        makeAgents(host, (effect) => Effect.provideContext(effect, services), yield* Collecting),
      );
    }),
  ).pipe(Layer.provideMerge(collectingLayer));

type Under = <A, E>(effect: Effect.Effect<A, E, AgentServices>) => Effect.Effect<A, E>;

const keyedGate = () => {
  const gates = new Map<string, { gate: Semaphore.Semaphore; users: number }>();
  return (key: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let entry = gates.get(key);
          if (entry === undefined) {
            entry = { gate: Semaphore.makeUnsafe(1), users: 0 };
            gates.set(key, entry);
          }
          entry.users++;
          return entry;
        }),
        (entry) => entry.gate.withPermits(1)(effect),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0) {
              gates.delete(key);
            }
          }),
      );
};

const makeAgents: (host: AgentHost, under: Under, collecting: CollectingApi) => AgentsApi = (
  host,
  under,
  collecting,
) => {
  const dirFor = (runId: string) => launchDir(host.dir, runId);
  const outputFor = (runId: string, operation: string) => `${dirFor(runId)}/${operation}.json`;
  // WARNING: an admitted recovery finishes before its quota incident is published; after that none may restart the spent agent.
  const withRecoveryGate = keyedGate();
  const withQuestionPass = keyedGate();
  const usageWaitPath = (launched: Pick<AgentAsk, "runId" | "operation" | "sequence">) =>
    `${dirFor(launched.runId)}/${stemOf(launched)}.usage-wait`;
  const usageWaiting = (launched: Launched, incident: RanOut | null) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = usageWaitPath(launched);
        if (incident === null) {
          return yield* fs.remove(path, { force: true });
        }
        const temporary = `${path}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}.new`;
        yield* fs
          .writeFileString(temporary, encodeRanOut(incident))
          .pipe(
            Effect.andThen(fs.rename(temporary, path)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
      }).pipe(withRecoveryGate(launched.runId), Effect.orDie),
    );
  const usageIncident = (launched: Launched) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const text = yield* fs
          .readFileString(usageWaitPath(launched))
          .pipe(
            Effect.catchTag("PlatformError", (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
            ),
          );
        return text === null ? null : yield* Schema.decodeEffect(RanOutJson)(text);
      }).pipe(Effect.orDie),
    );
  const sentPath = (about: Launched, kind: "step" | "repair") =>
    `${dirFor(about.runId)}/${stemOf(about)}.${kind}.md`;
  const promptFile = (ask: AgentAsk) => `${dirFor(ask.runId)}/${stemOf(ask)}.prompt.md`;
  const sessionFileOf = (about: { readonly runId: string; readonly operation: string }) =>
    `${dirFor(about.runId)}/${stemOf(about)}.session`;
  const withReporter = (ask: AgentAsk, settings: JsonObject, resumed: string | null) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sessionFile = sessionFileOf(ask);
      // WARNING: an earlier launch of this step may have left a session file that would be read as this launch's.
      yield* fs.remove(sessionFile, { force: true }).pipe(Effect.orDie);
      const reporter = `${dirFor(ask.runId)}/${stemOf(ask)}.status.js`;
      yield* write(
        reporter,
        opencodeReporter(
          resumed === null
            ? { sessionFile, tty: "/dev/tty" }
            : { sessionFile, tty: "/dev/tty", session: resumed },
        ),
      );
      const plugins = isJsonArray(settings.plugin) ? settings.plugin : [];
      return { ...settings, plugin: [...plugins, `file://${reporter}`] };
    });
  // WARNING: Collie's usage plugin goes after every other plugin.
  const withUsage = (ask: AgentAsk, agent: string, settings: JsonObject) =>
    Effect.gen(function* () {
      const plugin = `${dirFor(ask.runId)}/${stemOf(ask)}.usage.js`;
      const into = `${yield* controlDir(host.env.stateDir, agent)}/${OPENCODE_USAGE}`;
      yield* write(plugin, opencodeUsage(into));
      const plugins = isJsonArray(settings.plugin) ? settings.plugin : [];
      return { ...settings, plugin: [...plugins, `file://${plugin}`] };
    });
  const withSession = (
    launched: Launched,
    read: Effect.Effect<string | null, never, AgentServices>,
    none: string,
  ) =>
    Effect.gen(function* () {
      const budgetMs = host.readyMs ?? READY_TIMEOUT_MS;
      const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
      const id = yield* read.pipe(
        Effect.filterOrFail(
          (found): found is string => found !== null && found !== "",
          () => new Cause.NoSuchElementError(),
        ),
        Effect.retry({
          schedule: Schedule.spaced(host.pollMs ?? DEFAULT_POLL_MS).pipe(
            Schedule.while(({ now }) => now < deadline),
          ),
        }),
        Effect.orElseSucceed(() => null),
      );
      if (id === null) {
        yield* log(
          launched.runId,
          `${launched.agent}: ${none} within ${Math.round(budgetMs / 1000)}s, so none is recorded to resume`,
        );
        return launched;
      }
      const recorded: Launched = {
        ...launched,
        agentSession: { kind: launched.harness, value: id },
      };
      yield* recordLaunch(recorded);
      return recorded;
    });
  const openedSession = (launched: Launched) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.readFileString(sessionFileOf(launched))),
      Effect.orElseSucceed(() => null),
    );
  const boundThreadOf = (launched: Launched) =>
    Effect.gen(function* () {
      const record = yield* readControl(host.env.stateDir, launched.agent);
      if (record?.endpoint == null) {
        return null;
      }
      return yield* withCodex(record.endpoint, (client) => boundThread(client, record.cwd));
    }).pipe(Effect.orElseSucceed(() => null));
  const unsettled = (ask: AgentAsk, what: string, cause: ParkCause = "unknown") =>
    new AgentParked({
      operation: ask.operation,
      cause,
      reason: `${what}. Nothing here says the agent did no work. Its work is in ${promptFile(ask)}; \`collie run resume ${ask.runId}\` takes up the agent or starts it, then hands that to it.`,
    });
  const log = (runId: string, line: string) => append(`${dirFor(runId)}/agents.log`, line);

  const skills = (names: ReadonlyArray<string>) => installedSkills(host.env, names);
  const personaOf = (role: string) => personaText(host.env, role);

  const openQuestions = new Map<string, Set<string>>();
  const unsettledAnswers = new Map<string, { terminal: string; delivery: string }>();
  const deps: dispatch.DispatcherDeps = {
    stateDir: host.env.stateDir,
    herdr: host.herdr,
    log: (line) => append(`${host.dir}/agents/deliveries.log`, line),
    asking: (agent) =>
      Effect.sync(() => {
        const open = [...(openQuestions.get(agent) ?? [])];
        return open.length === 0 ? null : `its question ${Arr.join(open, ", ")} is waiting`;
      }),
  };

  const configured = HARNESSES[host.harness] ?? HARNESSES.claude!;
  const ports = host.ports ?? COMPACTION_PORTS;
  const adapterFor = (harness: string) => HARNESSES[harness] ?? configured;

  const registeredOnCore = (runId: string, agent: string, terminalId: string | undefined) =>
    Effect.map(
      everyRegistered,
      Arr.some(
        (one) =>
          one.agent === agent &&
          one.runId === runId &&
          one.incarnation?.backend === "core" &&
          one.incarnation.terminalId === terminalId,
      ),
    );

  const entryFor = (
    about: Launched | AgentAsk,
    agent: string,
    place: {
      readonly paneId: string;
      readonly workspaceId: string | null;
    } | null,
    through = deps,
  ) =>
    Effect.gen(function* () {
      const found = yield* dispatch.entryFromLive(through, {
        role: about.role,
        agent,
        paneId: place?.paneId ?? null,
        workspaceId: place?.workspaceId ?? null,
        runId: about.runId,
        workflow: about.workflow,
      });
      if (found.entry === null || place !== null) {
        return found;
      }
      // WARNING: herdr 1 named agents as core does; only a start on core registers this terminal.
      return (yield* registeredOnCore(about.runId, agent, found.entry.incarnation?.terminalId))
        ? found
        : { entry: null, reason: `${agent} was never started on core`, gone: true };
    });

  const fenceOf = (about: Pick<Launched, "runId" | "agent">) =>
    Effect.gen(function* () {
      const check = yield* under(verifyingOf(about.runId));
      if (check === null || check.pass === "ci") {
        return null;
      }
      const cwd = (yield* readControl(host.env.stateDir, about.agent).pipe(
        Effect.orElseSucceed(() => null),
      ))?.cwd;
      if (check.checkout === undefined || cwd === undefined) {
        return check;
      }
      const within = (inner: string, outer: string) =>
        inner === outer || pipe(inner, Str.startsWith(`${outer}/`));
      return within(cwd, check.checkout) || within(check.checkout, cwd) ? check : null;
    });

  const heldBehind = (check: Verifying) =>
    `Held behind the Check "${check.name}" Collie started at ${check.started} on this agent's checkout, until it ends; the host delivers it then.`;

  const untilUnfenced = (about: Launched, what: string) =>
    Effect.gen(function* () {
      let said = false;
      for (;;) {
        const check = yield* fenceOf(about);
        if (check === null) {
          return;
        }
        if (!said) {
          said = true;
          yield* log(
            about.runId,
            `${about.agent}: its ${what} is ${Str.uncapitalize(heldBehind(check))}`,
          );
        }
        yield* Effect.sleep(host.pollMs ?? DEFAULT_POLL_MS);
      }
    });

  // WARNING: a delivery the ledger holds under the same claim is refused, not resent; that makes a launch reconcilable and a retried steer one message.
  const deliver = Effect.fn("Agents.deliver")(function* (
    about: Launched,
    text: string,
    delivery: {
      readonly kind: "step" | "repair" | "steer" | "correction";
      readonly ref: string;
      readonly mode?: DeliveryMode;
      readonly intentVersion?: number;
      readonly attempt?: number;
      readonly requestId?: string;
      readonly actor?: Asker;
      readonly herdr?: DeliveringHerdr;
      readonly idleOnly?: boolean;
      readonly relayed?: true;
      readonly workflowNotice?: string;
    },
  ) {
    const lost = yield* lostServer(compactionDeps(host, about.runId), about.agent);
    if (lost !== null) {
      return { sent: false, why: lost, gone: true };
    }
    if (delivery.kind !== "steer") {
      yield* untilUnfenced(about, delivery.kind);
    }
    const through = delivery.herdr === undefined ? deps : { ...deps, herdr: delivery.herdr };
    const found = yield* entryFor(about, about.agent, null, through);
    if (found.entry === null) {
      return {
        sent: false,
        why: found.reason ?? "no such agent",
        gone: found.gone,
      };
    }
    const entry = found.entry;
    const requestId = delivery.requestId ?? `${about.runId}-${delivery.ref}-${delivery.kind}`;
    const attempt = delivery.attempt ?? 1;
    const fitted =
      delivery.kind === "steer"
        ? yield* dispatch.fitDelivery(
            attachmentsDir(`${host.dir}/runs/${about.runId}`),
            `${dispatch.DELIVERY_TOKEN}${requestId}-${attempt}`,
            text,
            delivery.actor,
            delivery.workflowNotice,
          )
        : { words: text, actor: delivery.actor, kept: null };
    const draft: dispatch.DeliveryDraft = {
      run: about.runId,
      harness: adapterFor(about.harness).id,
      actor: fitted.actor,
      cause: { kind: delivery.kind, ref: delivery.ref },
      mode: delivery.mode ?? "boundary",
      idleOnly: delivery.idleOnly,
      workflowNotice: delivery.workflowNotice,
      human: delivery.kind === "steer" && delivery.relayed !== true ? humanOf(fitted.actor) : null,
      // WARNING: work, repair and steer share a causal key per thing they are about, so a second copy is refusable; a correction's is its constraint's.
      intentVersion: delivery.intentVersion ?? 0,
      attempt,
      requestId,
    };
    const outcome = yield* (
      delivery.kind === "steer" || delivery.kind === "correction"
        ? dispatch.transaction(through, entry, (channel) => channel.submit(fitted.words, draft))
        : dispatch.submitPatiently(through, entry, fitted.words, draft, host.patience)
    ).pipe(Effect.catch((cause) => Effect.succeed(undeliverable(cause))));
    const pane = entry.paneId;
    if (outcome.ok) {
      if (outcome.submission === "pressed") {
        yield* log(
          about.runId,
          `${about.agent}: its ${delivery.kind} ${outcome.id} did not start a turn on core, so Enter was pressed once`,
        );
      }
      const id = outcome.id;
      if (
        outcome.submission === "observed" &&
        (delivery.kind === "step" || delivery.kind === "repair")
      ) {
        turnBegun.add(about.agent);
      }
      if (outcome.submission === "observed") {
        return {
          sent: true,
          why: "",
          id,
          observed: dispatch.TURN_STARTED,
          pane,
          kept: fitted.kept,
        };
      }
      if (delivery.kind !== "steer" && delivery.kind !== "correction") {
        return { sent: true, why: "", id };
      }
      return {
        sent: true,
        why: "",
        id,
        observed: yield* observe(about, entry, draft, delivery.herdr),
        pane,
        kept: fitted.kept,
      };
    }
    if (
      outcome.reason === "blocked" &&
      outcome.held !== undefined &&
      SENT_STATES.has(outcome.held)
    ) {
      return {
        sent: true,
        why: outcome.detail,
        id: outcome.id ?? undefined,
        observed: outcome.held === "acknowledged" ? "taken when it was first sent" : null,
        pane,
      };
    }
    const terminal = entry.incarnation?.terminalId;
    return {
      sent: false,
      why: `${outcome.reason}: ${outcome.detail}`,
      refused: outcome.reason === "exhausted",
      gone: inactive(outcome.detail),
      blockedBy:
        outcome.reason === "blocked" && outcome.id != null && terminal !== undefined
          ? { terminal, delivery: outcome.id, state: outcome.held ?? null }
          : undefined,
    };
  });

  const observe = (
    about: Launched,
    entry: AgentEntry,
    draft: dispatch.DeliveryDraft,
    herdr: DeliveringHerdr = host.herdr,
  ) =>
    Effect.gen(function* () {
      const dir = yield* controlDir(host.env.stateDir, about.agent);
      return yield* dispatch.confirmSubmitted(
        {
          stateDir: host.env.stateDir,
          herdr,
          log: (line) => log(about.runId, line),
          taken: (delivery) =>
            submittedDelivery(dir, delivery.id, delivery.incarnation).pipe(
              Effect.map((recorded) => (recorded ? dispatch.SUBMIT_RECORDED : null)),
              Effect.orElseSucceed(() => null),
            ),
          pollMs: host.pollMs ?? DEFAULT_POLL_MS,
          graceMs: host.confirmGraceMs ?? CONFIRM_GRACE_MS,
        },
        entry,
        [causalKey(draft.run, draft.cause, draft.intentVersion)],
      );
    }).pipe(
      Effect.timeoutOption(host.observeMs ?? OBSERVE_MS),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );

  // WARNING: outside the Dispatcher's transaction, so a steer still reaches the agent while it waits.
  const stoppedRun = (runId: string) => under(controlSet(runId, STOP));

  const turnEnded = (launched: Launched) =>
    Effect.gen(function* () {
      const stopped = stoppedRun(launched.runId);
      let since: number | null = null;
      for (;;) {
        const status = yield* host.herdr
          .agentStatus(launched.agent)
          .pipe(Effect.orElseSucceed(() => "unknown" as const));
        if (status !== "working" && status !== "blocked") {
          break;
        }
        if (yield* stopped) {
          return false;
        }
        if (since === null) {
          since = yield* Clock.currentTimeMillis;
          yield* log(
            launched.runId,
            `${launched.agent}: still working; ${launched.operation} waits for its turn to end`,
          );
        }
        yield* Effect.sleep(host.pollMs ?? DEFAULT_POLL_MS);
      }
      if (since !== null) {
        const waited = Math.round(((yield* Clock.currentTimeMillis) - since) / 1000);
        yield* log(launched.runId, `${launched.agent}: its turn ended after ${waited}s`);
      }
      return true;
    });

  // WARNING: only the request takes the Dispatcher's transaction, so a steer is never refused behind a poll.
  const boundary = (launched: Launched, note: (why: string | null) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const found = yield* entryFor(launched, launched.agent, null);
      if (found.entry === null) {
        return { dispatch: true as const };
      }
      const entry = found.entry;
      const compaction: CompactionDeps = {
        ...compactionDeps(host, launched.runId),
        room: (cwd) =>
          under(
            waitForMemory({
              env: host.env,
              stateDir: host.dir,
              runId: launched.runId,
              what: `${launched.agent}'s compaction`,
              checkout: cwd,
              memory: false,
              stopped: stoppedRun(launched.runId),
            }),
          ),
      };
      yield* recordUsage(ledgerDeps(host), { run: launched.runId, agent: launched.agent });
      const due = yield* atBoundary(
        compaction,
        { agent: launched.agent, run: launched.runId, step: launched.operation },
        (body) =>
          Effect.gen(function* () {
            let ran = false;
            const done = yield* dispatch
              .transaction(deps, entry, (channel) =>
                Effect.sync(() => (ran = true)).pipe(Effect.andThen(Effect.result(body(channel)))),
              )
              .pipe(
                Effect.mapError((cause) =>
                  ran
                    ? new Cause.UnknownError(cause, reason(cause))
                    : new Unsubmitted({ message: reason(cause) }),
                ),
              );
            return yield* Effect.fromResult(done);
          }),
      );
      if (due.dispatch || due.waiting !== true) {
        return due;
      }
      yield* note(due.reason);
      for (;;) {
        if (yield* stoppedRun(launched.runId)) {
          return null;
        }
        yield* Effect.sleep(compaction.pollMs);
        const now = yield* pollCompaction(compaction, launched.agent).pipe(
          Effect.orElseSucceed(() => null),
        );
        if (now !== null) {
          yield* note(null);
          return now;
        }
      }
    }).pipe(
      Effect.catch((failed) =>
        Effect.fail(failed).pipe(
          Effect.ignore({ log: "Unhandled" }),
          Effect.as({ dispatch: true as const }),
        ),
      ),
    );

  const checkedTrust = new Set<string>();

  // WARNING: a grant that cannot be written never stops the launch; the harness then asks in its own pane.
  const ensureTrusted = Effect.fn("Agents.ensureTrusted")(function* (
    runId: string,
    adapter: HarnessAdapter,
    cwd: string,
  ) {
    if (host.trust === "never") {
      return;
    }
    const trust = adapter.trust?.(host.env.home, host.env.stateDir);
    const key = `${runId}\0${adapter.id}\0${cwd}`;
    if (trust === undefined || checkedTrust.has(key)) {
      return;
    }
    checkedTrust.add(key);
    const asks = `${adapter.id} will ask in its own pane`;
    const message = yield* trust.state(cwd).pipe(
      Effect.flatMap((state) =>
        state === "untrusted"
          ? trust.grant(cwd).pipe(Effect.map((result) => result.message))
          : Effect.succeed(
              state === "unknown"
                ? `${adapter.id}'s record of trusted directories is missing or not readable; nothing written for ${cwd}, ${asks}`
                : null,
            ),
      ),
      Effect.catch((cause) =>
        Effect.succeed(`could not record trust for ${cwd} (${reason(cause)}); ${asks}`),
      ),
    );
    if (message !== null) {
      yield* log(runId, `trust ${adapter.id}: ${message}`);
    }
  });

  const quietFor = Effect.fn("Agents.quietFor")(function* (
    ask: AgentAsk,
    agent: string,
    persona: string,
    profile: RoleProfile,
  ) {
    const installed = yield* (host.version ?? installedVersion)("claude");
    if (installed === null || !atLeast(installed, SKILL_OVERRIDES_VERSION)) {
      yield* log(
        ask.runId,
        `${agent}: every skill described: skillOverrides needs Claude Code ${SKILL_OVERRIDES_VERSION}; installed: ${installed ?? "unknown"}`,
      );
      return {};
    }
    const claudeDir =
      profile.env?.CLAUDE_CONFIG_DIR ??
      host.env.raw.CLAUDE_CONFIG_DIR ??
      `${host.env.home}/.claude`;
    if (!isString(claudeDir)) {
      yield* log(
        ask.runId,
        `${agent}: every skill described: CLAUDE_CONFIG_DIR is held in an environment file`,
      );
      return {};
    }
    const kept = [
      ...mentionedSkills(`${persona}\n${ask.prompt}`),
      ...Struct.keys(profile.claude?.skillOverrides ?? {}),
    ];
    if (ask.skill !== null) {
      kept.push(ask.skill);
    }
    return yield* quietSkills(
      {
        claudeDir,
        cwd: ask.cwd,
        mainCheckoutSkills: atLeast(installed, MAIN_CHECKOUT_SKILLS_VERSION),
      },
      kept,
    );
  });

  const start = Effect.fn("Agents.start")(function* (
    ask: AgentAsk,
    agent: string,
    alive: {
      readonly agents: ReadonlyArray<AgentInfo>;
      readonly listedAt: string;
    },
    prompt: string | null,
    session: StartSession | null,
  ) {
    const adapter = adapterFor(ask.harness ?? host.harness);
    const wanted = ask.permissions ?? undefined;
    // WARNING: read at each start, since a host outlives the Settings change and every later agent must see it.
    const config = yield* readConfig(host.env.userDir).pipe(
      Effect.orElseSucceed(() => {
        const returned: YamlMap = {};
        return returned;
      }),
    );
    const written = permissionsAsWritten(config.permissions);
    const asked = isPermissionMode(wanted)
      ? wanted
      : isPermissionMode(written)
        ? written
        : host.permissions;
    const forbidden =
      asked === "bypass" && adapter.bypassForbidden !== undefined
        ? yield* adapter.bypassForbidden(host.env)
        : false;
    const permissions = forbidden ? "auto" : asked;
    const window = yield* autoCompactWindowFor(
      adapter,
      autoCompactWindowAsWritten(config.claude_auto_compact_window),
      host.help ?? installedHelp,
    );
    // WARNING: parked, never started on the default: a default would replace a window meant to be smaller.
    if ("refused" in window) {
      return yield* new AgentParked({
        operation: ask.operation,
        reason: `${window.refused} in ${host.env.userDir}/config.json: fix it, then resume this Run`,
      });
    }
    if (window.leftOff !== null) {
      yield* log(ask.runId, `${agent}: started without an auto-compact window: ${window.leftOff}`);
    }
    // WARNING: the remote TUI forwards hook trust to its App Server as a session override.
    const hookTrustArgs =
      adapter.id === "codex" &&
      /--dangerously-bypass-hook-trust(?![\w-])/.test(
        yield* (host.help ?? installedHelp)(adapter.kind),
      )
        ? ["--dangerously-bypass-hook-trust"]
        : [];
    const parsed = parseProfile(isString(config.agent_profile) ? config.agent_profile : "");
    if ("refused" in parsed) {
      return yield* new AgentParked({
        operation: ask.operation,
        reason: `${parsed.refused} in ${host.env.userDir}/config.json: fix it, then resume this Run`,
      });
    }
    const profile = roleProfile(parsed.profile, ask.role);
    if (
      adapter.id === "claude" &&
      ask.claudeSubagents !== undefined &&
      Struct.keys(ask.claudeSubagents).length > 0
    ) {
      const needed = subagentVersion(ask.claudeSubagents);
      const installed = yield* (host.version ?? installedVersion)("claude");
      if (installed === null || !atLeast(installed, needed)) {
        return yield* new AgentParked({
          operation: ask.operation,
          reason: `claudeSubagents requires Claude Code ${needed} or later; installed: ${installed ?? "unknown"}. Upgrade Claude Code, then resume this Run`,
        });
      }
    }
    const unreadable = yield* envFileProblems(profile.env ?? {}, host.env.home);
    if (unreadable.length > 0) {
      return yield* new AgentParked({
        operation: ask.operation,
        reason: `agent_profile for ${ask.role}: ${Arr.join(unreadable, "; ")}. Hold each value in a file of this Machine with mode 0600, then resume this Run`,
      });
    }
    yield* ensureTrusted(ask.runId, adapter, ask.cwd);
    const persona = `${dirFor(ask.runId)}/${stemOf(ask)}.persona.md`;
    const personaBody = yield* personaOf(ask.persona ?? ask.role);
    yield* write(persona, `${personaBody}\n`);
    const { mcpConfig, piExtension } = yield* Effect.promise(() => import("./chat"));
    const { SUBMIT, TOOLS } = yield* Effect.promise(() => import("./tools"));
    const { ROLE_TOOLS } = yield* Effect.promise(() => import("./toolkit"));
    const byRole = config.role_tools === "role";
    const roleTools = byRole ? ROLE_TOOLS.get(ask.role) : undefined;
    const command = host.self ?? selfCommand();
    const runEnv = {
      COLLIE_ROOT: host.env.pluginRoot,
      COLLIE_STATE_DIR: host.env.stateDir,
      COLLIE_USER_DIR: host.env.userDir,
      COLLIE_CWD: ask.cwd,
      COLLIE_RUN: ask.runId,
      COLLIE_AGENT: agent,
    };
    const roleEnv = roleTools === undefined ? runEnv : { ...runEnv, COLLIE_TOOLS_ROLE: ask.role };
    const submits = (ask.outputSubmit ?? config.output_submit) === "tool";
    const serverEnv = submits ? { ...roleEnv, COLLIE_OUTPUT_SUBMIT: "tool" } : roleEnv;
    const configFile = `${dirFor(ask.runId)}/${stemOf(ask)}.mcp.json`;
    const extension = `${dirFor(ask.runId)}/${stemOf(ask)}.tools.ts`;
    yield* write(configFile, mcpConfig(command, serverEnv));
    if (adapter.id === "pi") {
      yield* write(
        extension,
        piExtension(
          command,
          Arr.map(
            Arr.filter(
              submits ? [...TOOLS, SUBMIT] : TOOLS,
              (tool) =>
                tool === SUBMIT ||
                roleTools === undefined ||
                Arr.some(roleTools, (name) => name === tool.name),
            ),
            (tool) => ({
              name: tool.name,
              label: tool.title,
              description: tool.description,
              parameters: tool.input,
            }),
          ),
          serverEnv,
          "",
          "",
          piQuestionTool(command, yield* controlDir(host.env.stateDir, agent)),
        ),
      );
    }
    const operators =
      adapter.id === "opencode" && host.env.raw.OPENCODE_CONFIG_CONTENT !== undefined
        ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
            host.env.raw.OPENCODE_CONFIG_CONTENT,
          )
        : undefined;
    const reported =
      adapter.id === "opencode"
        ? yield* withReporter(ask, operators ?? {}, session?.resumed === true ? session.id : null)
        : operators;
    const settings =
      adapter.id === "opencode" ? yield* withUsage(ask, agent, reported ?? {}) : reported;
    const mcp = adapter.mcp({
      command,
      env: serverEnv,
      config: configFile,
      extension,
      settings,
      effort: ask.effort,
    });
    return yield* withControlLock(
      host.env.stateDir,
      agent,
      Effect.gen(function* () {
        const env = envLines(profile.env ?? {}, host.env.home);
        const controls = yield* installControls(
          compactionDeps(host, ask.runId),
          {
            agent,
            harness: adapter.id,
            cwd: ask.cwd,
            runLog: `${dirFor(ask.runId)}/agents.log`,
          },
          env,
          mcp.args,
          session?.resumed === true ? { session: session.id, keep: [QUESTIONS] } : undefined,
        ).pipe(
          Effect.catchIf(isNotQuiet, (refused) =>
            Effect.fail(
              new AgentParked({
                operation: ask.operation,
                reason: `${refused.message}. Nothing was started in its place; once it has stopped, \`collie run resume ${ask.runId}\``,
              }),
            ),
          ),
        );
        const settingsArgs =
          adapter.id === "claude"
            ? yield* claudeSettings(
                controls,
                withoutCollieInstructions(profile.claude ?? {}, ask.cwd, host.env.collieDir),
                autoModeBlock(
                  yield* autoModeFacts(
                    {
                      agent,
                      run: ask.runId,
                      workflow: ask.workflow,
                      machine: machineName(),
                      stateDir: host.env.stateDir,
                      cwd: ask.cwd,
                    },
                    ask.authority ?? NO_AUTHORITY,
                    shell,
                    yield* gitlabHostOf(host.env).pipe(Effect.orElseSucceed(() => undefined)),
                  ),
                ),
                `${dirFor(ask.runId)}/${stemOf(ask)}`,
                yield* quietFor(ask, agent, personaBody, profile),
                ask.claudeSubagents,
              )
            : controls;
        const args = [
          ...startArgs(
            adapter,
            ask.model ?? host.model,
            persona,
            ask.effort ?? undefined,
            // WARNING: a resumed Codex thread keeps its permissions, and its remote TUI refuses them again.
            session?.resumed === true && adapter.id === "codex" ? "harness" : permissions,
            window.passed ?? undefined,
          ),
          ...(adapter.dirArgs?.(`${host.dir}/runs/${ask.runId}`) ?? []),
          ...hookTrustArgs,
          ...settingsArgs,
          ...mcp.args,
        ];
        const tools = !byRole
          ? ""
          : roleTools === undefined
            ? `, Collie tools: every tool, as the ${ask.role} has no list`
            : `, Collie tools: the ${ask.role}'s ${roleTools.length}`;
        const started = `permissions ${permissions}${forbidden ? `: ${adapter.id}'s managed settings forbid bypass` : ""}${window.passed === null ? "" : `, auto-compact window ${window.passed}`}${tools}`;
        const named = { [RUN_LABEL]: ask.runId, operation: ask.operation };
        const labels = ask.task === null ? named : { ...named, task: ask.task };
        const opened = session === null ? null : sessionArgs(adapter.id, session);
        const terminal = yield* host.herdr
          .agentLaunch({
            name: agent,
            argv: [
              adapter.kind,
              ...(opened?.lead ?? []),
              ...args,
              ...(prompt === null ? [] : ["--prompt", prompt]),
              ...(opened === null || settingsArgs.includes("--session") ? [] : opened.tail),
            ],
            cwd: ask.cwd,
            env: {
              ...serverEnv,
              ...mcp.env,
              ...(yield* envValues(profile.env ?? {}, host.env.home)),
            },
            labels,
          })
          .pipe(
            Effect.mapError((cause) =>
              unsettled(ask, `${agent} did not start on core: ${herdrFailureReason(cause)}`),
            ),
          );
        yield* log(ask.runId, `${agent}: ${adapter.id} in core terminal ${terminal}, ${started}`);
        yield* setStarted(ask.runId, agent, encodeStarted(ask));
        const found = yield* entryFor(ask, agent, { paneId: terminal, workspaceId: null });
        if (found.entry === null) {
          return undefined;
        }
        yield* registerAgent(scopeFor(ask.cwd), found.entry, alive);
        return rooted(found.entry.incarnation, yield* rootOf(host.herdr, terminal));
      }),
    );
  });

  const stepsGoingOut = new Map<string, Deferred.Deferred<void>>();

  // WARNING: a recorded name is an external identity, even when the current spelling differs.
  const nameFor = (ask: AgentAsk) =>
    under(
      Effect.gen(function* () {
        const role = ask.agent ?? ask.operation;
        const sequence = ask.sequence ?? 1;
        const held = Arr.findLast(
          yield* readLaunches(ask.runId),
          (one) =>
            (one.sequence ?? 1) === sequence &&
            (one.operation === ask.operation || launchedAs(one, role)),
        );
        if (Option.isSome(held)) {
          return held.value.agent;
        }
        const canonical = agentName(ask.runId, role, null, sequence);
        const legacy = legacyAgentName(ask.runId, role, null, sequence);
        if (legacy === canonical) {
          return canonical;
        }
        // WARNING: core may have started it before its launch record was written; the saved ask proves which generation owns the name.
        const text = yield* startedWith(ask.runId, legacy);
        if (text !== null) {
          const started = yield* decodeStarted(text);
          if (
            started.runId === ask.runId &&
            (started.sequence ?? 1) === sequence &&
            (started.agent ?? started.operation) === role
          ) {
            return legacy;
          }
        }
        return canonical;
      }).pipe(Effect.mapError((cause) => asUncertain(ask.operation, cause))),
    );

  const launch: (
    ask: AgentAsk,
    fresh?: boolean,
    note?: (why: string | null) => Effect.Effect<void>,
  ) => Effect.Effect<Launched, AgentUncertain | AgentParked> = (
    ask: AgentAsk,
    fresh = false,
    note: (why: string | null) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const agent = yield* nameFor(ask);
      const out = yield* Deferred.make<void>();
      stepsGoingOut.set(agent, out);
      return yield* launching(ask, fresh, note, agent).pipe(
        Effect.ensuring(stepGoneOut(agent, out)),
      );
    });
  const stepGoneOut = (agent: string, out = stepsGoingOut.get(agent)) =>
    Effect.suspend(() => {
      if (out === undefined) {
        return Effect.void;
      }
      if (stepsGoingOut.get(agent) === out) {
        stepsGoingOut.delete(agent);
      }
      return Deferred.succeed(out, undefined);
    });

  const launching: (
    ask: AgentAsk,
    fresh: boolean,
    note: (why: string | null) => Effect.Effect<void>,
    agent: string,
  ) => Effect.Effect<Launched, AgentUncertain | AgentParked> = (ask, fresh, note, agent) =>
    under(
      Effect.gen(function* () {
        const listedAt = yield* nowIso;
        const listing = yield* host.herdr.agentList().pipe(Effect.result);
        if (listing._tag === "Failure") {
          // WARNING: nothing is started on a question nobody answered: a second agent on the same work is worse than work that stops and says why.
          return yield* unsettled(
            ask,
            `core cannot say which agents it has (${herdrFailureReason(listing.failure)})`,
            "herdr-unavailable",
          );
        }
        const live = Option.getOrUndefined(
          Arr.findFirst(listing.success, (one) => one.name === agent),
        );
        const alternate = Arr.findFirst(
          [
            agentName(ask.runId, ask.agent ?? ask.operation, null, ask.sequence ?? 1),
            legacyAgentName(ask.runId, ask.agent ?? ask.operation, null, ask.sequence ?? 1),
          ],
          (name) => name !== agent && Arr.some(listing.success, (one) => one.name === name),
        );
        if (Option.isSome(alternate)) {
          return yield* unsettled(
            ask,
            `${alternate.value} is already listed under another spelling; its generation must be established before ${agent} can start`,
          );
        }
        if (live !== undefined && (yield* retireLost(ask, agent, listing.success))) {
          return yield* launch(ask, false, note);
        }
        const alive = live !== undefined && !fresh;
        const back = live === undefined ? comingBack.get(agent) : undefined;
        if (back !== undefined) {
          yield* Deferred.await(back);
          return yield* launch(ask, false, note);
        }
        if (alive) {
          yield* stepGoneOut(agent);
        }
        // WARNING: core keeps a name while it lists it, so a new agent cannot take it until then.
        if (fresh && live !== undefined) {
          yield* host.herdr.terminalKill(live.paneId).pipe(
            Effect.mapError(
              (cause) =>
                new AgentUncertain({
                  operation: ask.operation,
                  reason: `${agent} is gone, but its terminal ${live.paneId} did not close, so it was not started again: ${herdrFailureReason(cause)}`,
                }),
            ),
          );
        }
        const memory = alive
          ? "free"
          : yield* waitForMemory({
              env: host.env,
              stateDir: host.dir,
              runId: ask.runId,
              what: `${agent}'s launch`,
              checkout: ask.cwd,
              stopped: stoppedRun(ask.runId),
            });
        if (memory === "waited") {
          return yield* launch(ask, fresh, note);
        }
        const replayed = yield* wasOrdered(ask);
        const landedOn = (incarnation: Rooted | undefined, chosen: AgentSession | null = null) =>
          Effect.gen(function* () {
            const landed: Types.Mutable<Launched> = {
              agent,
              output: ask.output,
              reused: alive,
              runId: ask.runId,
              operation: ask.operation,
              role: ask.role,
              workflow: ask.workflow,
              harness: ask.harness ?? host.harness,
              model: ask.model ?? host.model,
              effort: ask.effort,
            };
            if (ask.claudeSubagents !== undefined) {
              landed.claudeSubagents = ask.claudeSubagents;
            }
            if ((ask.sequence ?? 1) > 1) {
              landed.sequence = ask.sequence;
            }
            if (ask.step !== undefined) {
              landed.step = ask.step;
            }
            if (ask.outputSubmit !== undefined) {
              landed.outputSubmit = ask.outputSubmit;
            }
            landed.at = yield* Clock.currentTimeMillis;
            fellBack(landed, ask.from, ask.why);
            if (ask.next !== undefined) {
              landed.next = ask.next;
            }
            if (incarnation !== undefined) {
              landed.terminalId = incarnation.terminalId;
              if (incarnation.agentSession !== null) {
                landed.agentSession = incarnation.agentSession;
              }
              if (incarnation.root !== undefined) {
                landed.root = incarnation.root;
              }
            }
            if (chosen !== null) {
              landed.agentSession = chosen;
            }
            return landed;
          });
        if (memory === "stopped") {
          return yield* landedOn(undefined);
        }
        const recorded = (incarnation: Rooted | undefined, chosen: AgentSession | null = null) =>
          Effect.gen(function* () {
            const landed = yield* landedOn(incarnation, chosen);
            yield* recordLaunch(landed);
            return landed;
          });
        const adapter = adapterFor(ask.harness ?? host.harness);
        const prefix = personaPrefix(adapter, yield* personaOf(ask.persona ?? ask.role));
        const file = promptFile(ask);
        const notes =
          ask.step === undefined
            ? ""
            : yield* takeStepNotes(`${host.dir}/runs/${ask.runId}`, ask.step.step, file);
        const address = `You are ${agent} of ${ask.runId} on ${machineName()}. Message another Run's agent with collie_do deliver to its Run and agent, or collie run steer <run> --operation <agent> "<words>"; push your branch before starting work on another Machine. ${READING_DELIVERIES} ${SHELL_HABITS} ${REGISTERING}${adapter.id === "codex" || adapter.id === "pi" ? ` ${ASKING}` : ""}`;
        yield* write(
          file,
          `${notes === "" ? "" : `${notes}\n\n`}${address}\n\n${prefix === "" ? ask.prompt : `${prefix}\n\n${ask.prompt}`}`,
        );
        const pointer = stepText(adapter, ask, file);
        // WARNING: OpenCode reports no readiness, so its first prompt goes in at launch.
        const atLaunch = !alive && adapter.id === "opencode";
        const had = alive
          ? null
          : yield* sessionHad(ask.runId, agent, adapter.kind, ask.sequence ?? 1);
        const session: StartSession | null =
          had !== null
            ? { id: had, resumed: true }
            : !alive && (adapter.id === "pi" || adapter.id === "claude")
              ? { id: yield* (yield* SecureRandom.SecureRandom).uuidV4(), resumed: false }
              : null;
        const chosen = session === null ? null : { kind: adapter.kind, value: session.id };
        const launched = alive
          ? yield* Effect.gen(function* () {
              const found = yield* entryFor(ask, agent, { paneId: live.paneId, workspaceId: null });
              if (
                found.entry !== null &&
                !(yield* registeredOnCore(ask.runId, agent, live.terminalId))
              ) {
                yield* registerAgent(scopeFor(ask.cwd), found.entry, {
                  agents: listing.success,
                  listedAt,
                });
              }
              return yield* recorded(
                rooted(
                  { terminalId: live.terminalId, agentSession: null },
                  yield* rootOf(host.herdr, live.paneId),
                ),
              );
            })
          : yield* Effect.uninterruptible(
              start(
                ask,
                agent,
                { agents: listing.success, listedAt },
                atLaunch ? pointer : null,
                session,
              ).pipe(Effect.flatMap((incarnation) => recorded(incarnation, chosen))),
            );
        if (atLaunch) {
          if (!replayed) {
            yield* orderLaunch(ask);
          }
          turnBegun.add(launched.agent);
          yield* write(sentPath(launched, "step"), pointer);
          yield* log(
            ask.runId,
            `${agent}: launched for ${ask.operation}, given its prompt at launch`,
          );
          return yield* withSession(
            launched,
            openedSession(launched),
            "OpenCode opened no session",
          );
        }
        if (!alive || !replayed) {
          const late = yield* awaitReady(
            compactionDeps(host, ask.runId),
            agent,
            host.readyMs ?? READY_TIMEOUT_MS,
          );
          if (late !== null) {
            const pane = (yield* entryFor(ask, agent, null)).entry?.paneId ?? "unknown";
            return yield* new AgentParked({
              operation: ask.operation,
              reason: `${agent} in pane ${pane} was started, but ${late}, so nothing was typed into it. Look at the pane; once it shows its prompt, \`collie run resume ${ask.runId}\`.`,
            });
          }
        }
        if (alive && !replayed) {
          if (!(yield* turnEnded(launched))) {
            return launched;
          }
          const due = yield* boundary(launched, note);
          if (due === null) {
            return launched;
          }
          if (!due.dispatch) {
            return yield* new AgentParked({
              operation: ask.operation,
              reason: due.reason,
            });
          }
        }
        if (!replayed) {
          yield* orderLaunch(ask);
        }
        // WARNING: one send is one message, not a transcript; a skill marked disable-model-invocation refuses an agent invoking it itself, but this human channel runs it.
        yield* write(sentPath(launched, "step"), pointer);
        let asked = yield* deliver(launched, pointer, {
          kind: "step",
          ref: stemOf(ask),
        });
        // WARNING: the sender reads a failed listing as no agent, so only an answered listing settles gone.
        if (alive && asked.gone === true) {
          const again = yield* host.herdr.agentList().pipe(Effect.result);
          if (
            again._tag === "Success" &&
            (isGone(agent, again.success, asked.why) ||
              (yield* retireLost(ask, agent, again.success)))
          ) {
            yield* log(
              ask.runId,
              `${agent}: ${asked.why} before it was given ${ask.operation}; starting it again`,
            );
            return yield* launch(ask, true);
          }
          if (again._tag === "Success") {
            asked = yield* deliver(launched, pointer, {
              kind: "step",
              ref: stemOf(ask),
            });
          }
        }
        if (asked.refused) {
          return yield* refusedWith(ask, `${agent} was not given its work (${asked.why})`, file);
        }
        if (!asked.sent) {
          return yield* unsettled(ask, `${agent} was not given its work (${asked.why})`);
        }
        yield* log(
          ask.runId,
          `${agent}: ${alive ? "reattached to" : "launched for"} ${ask.operation}`,
        );
        if (
          !alive &&
          adapter.id === "codex" &&
          session === null &&
          (yield* readControl(host.env.stateDir, agent))?.endpoint != null
        ) {
          return yield* withSession(
            launched,
            boundThreadOf(launched),
            "Codex's App Server named no thread",
          );
        }
        return launched;
      }).pipe(
        Effect.mapError((cause) => (isParked(cause) ? cause : asUncertain(ask.operation, cause))),
      ),
    );

  const confirmed = (launched: Launched, unless: string | null) =>
    Effect.gen(function* () {
      const found = yield* entryFor(launched, launched.agent, null);
      if (found.entry === null) {
        return;
      }
      const dir = yield* controlDir(host.env.stateDir, launched.agent);
      const kind = unless === null ? "step" : "repair";
      const key = causalKey(launched.runId, { kind, ref: stemOf(launched) }, 0);
      const incarnation = found.entry.incarnation?.terminalId;
      const last =
        incarnation === undefined ? undefined : (yield* deliveriesAbout(incarnation, key)).at(-1);
      const resend =
        Option.getOrUndefined(
          Option.flatMap(Option.fromNullishOr(last), (present__) =>
            Option.map(Option.fromNullishOr(present__.note), (present___) =>
              pipe(present___, Str.startsWith("reconciled as not-sent")),
            ),
          ),
        ) === true ||
        (last?.state === "failed" && last.attempt > 1);
      if (last !== undefined && resend) {
        const fs = yield* FileSystem.FileSystem;
        const unkept: Effect.Effect<string, null> =
          kind === "step"
            ? Effect.succeed(stepPointer(`${dirFor(launched.runId)}/${stemOf(launched)}.prompt.md`))
            : Effect.fail(null);
        const again = yield* fs.readFileString(sentPath(launched, kind)).pipe(
          Effect.catch(() => unkept),
          Effect.flatMap((text) =>
            deliver(launched, text, {
              kind,
              ref: stemOf(launched),
              attempt: last.attempt + 1,
            }),
          ),
          Effect.orElseSucceed(() => ({
            sent: false,
            why: "what was sent is not on file",
          })),
        );
        if (!again.sent) {
          return yield* new AgentParked({
            operation: launched.operation,
            reason: `${launched.agent} in pane ${found.entry.paneId} could not be sent ${kind === "step" ? "its step's prompt" : "its repair"} again (${again.why}). \`collie run resume ${launched.runId}\` tries again.`,
          });
        }
      }
      yield* dispatch.confirmSubmitted(
        {
          stateDir: host.env.stateDir,
          herdr: host.herdr,
          log: (line) => log(launched.runId, line),
          taken: (delivery) =>
            submittedDelivery(dir, delivery.id, delivery.incarnation).pipe(
              Effect.map((recorded) => (recorded ? dispatch.SUBMIT_RECORDED : null)),
              Effect.orElseSucceed(() => null),
            ),
          pollMs: host.pollMs ?? DEFAULT_POLL_MS,
          graceMs: host.confirmGraceMs ?? CONFIRM_GRACE_MS,
        },
        found.entry,
        [key],
      );
    }).pipe(
      Effect.catchIf(
        (cause) => !(cause instanceof dispatch.Unconfirmed) && !isParked(cause),
        (cause) =>
          log(
            launched.runId,
            `${launched.agent}: could not check its prompt was taken (${reason(cause)})`,
          ),
      ),
      Effect.catchTag("Unconfirmed", (unconfirmed) =>
        Effect.fail(
          new AgentParked({
            operation: launched.operation,
            reason: `${unconfirmed.agent} in pane ${unconfirmed.pane} was sent delivery ${unconfirmed.delivery}, and nothing shows it took it: ${unconfirmed.why}. Look at the pane, then settle it with \`collie run deliveries ${launched.runId} --reconcile ${unconfirmed.delivery} --as sent|not-sent\`: \`sent\` once the agent has it (press Enter if the prompt is still in its box), \`not-sent\` to have the resume send it once more. Then \`collie run resume ${launched.runId}\`.`,
          }),
        ),
      ),
    );

  const answeredCalls = new Set<string>();
  const fencedCalls = new Set<string>();

  const questionsOf = (
    launched: Launched,
    questions: Questions,
    until = Infinity,
    herdr: Effect.Effect<Herdr, never, AgentServices> = Effect.succeed(host.herdr),
    known?: Map<string, AskedQuestion>,
  ) =>
    Effect.gen(function* () {
      const dir = yield* controlDir(host.env.stateDir, launched.agent);
      const stem = stemOf(launched);
      const closings = [closedAnswer(launched.operation), goneAnswer(launched.agent)];
      return (closing: string | null) =>
        Effect.gen(function* () {
          yield* takeHarnessQuestions(host.env.stateDir, ports, launched.agent);
          const since = Arr.filter(
            yield* questionsSince(dir, launched.at ?? 0),
            (call) => call.at < until,
          );
          const ids = new Set(Arr.map(since, (call) => call.id));
          const unrepaired: Array<AskedCall> = [];
          for (const call of since) {
            const key = `${launched.agent}\n${call.id}`;
            if (
              call.repair !== "by-delivery" ||
              closing !== null ||
              answeredCalls.has(key) ||
              ids.has(`${call.id}${UNREPAIRED}`)
            ) {
              continue;
            }
            const sent = yield* deliver(launched, questionRepair(call.questions), {
              kind: "repair",
              ref: `question-${call.id}`,
              herdr: yield* herdr,
            });
            answeredCalls.add(key);
            if (sent.sent) {
              continue;
            }
            yield* log(
              launched.runId,
              `${launched.agent}: was not sent its question's repair (${sent.why}), so the question is posted as asked`,
            );
            unrepaired.push(yield* postUnrepaired(dir, call));
          }
          let n = 0;
          const calls = Arr.map(
            [...Arr.filter(since, (call) => call.repair === undefined), ...unrepaired],
            (call) => ({
              call,
              names: Arr.map(call.questions, () => agentQuestionName(stem, ++n)),
            }),
          );
          const asked =
            known ?? new Map(Arr.map(yield* questions.asked, (one) => [one.name, one] as const));
          let open = false;
          const opened = openQuestions.get(launched.agent) ?? new Set<string>();
          openQuestions.set(launched.agent, opened);
          for (const { call, names } of calls) {
            for (const [at, question] of call.questions.entries()) {
              const name = names[at] ?? "";
              if (asked.has(name)) {
                continue;
              }
              const shortfall = shortfallOf(question);
              yield* questions.ask(
                shortfall === null
                  ? { name, prompt: promptOf(question), options: solutionsOf(question) }
                  : { name, prompt: promptOf(question), options: solutionsOf(question), shortfall },
                launched.operation,
              );
              asked.set(name, { name, answer: null });
            }
            const given = Arr.map(names, (name) => asked.get(name) ?? { name, answer: null });
            const key = `${launched.agent}\n${call.id}`;
            // WARNING: held until its answers are sent, so Collie's next prompt cannot reach the agent first.
            const holds = (holding: boolean) => {
              for (const name of names) {
                if (holding) {
                  opened.add(`${name} on ${launched.runId}`);
                } else {
                  opened.delete(`${name} on ${launched.runId}`);
                }
              }
            };
            if (closing !== null) {
              for (const one of given) {
                if (isUnanswered(one)) {
                  yield* questions.close(one.name, closing);
                  asked.set(one.name, { ...one, answer: closing });
                }
              }
              holds(false);
              continue;
            }
            if (Arr.some(given, isUnanswered)) {
              open = true;
              holds(true);
              continue;
            }
            if (
              Arr.some(given, isSuperseded) ||
              Arr.some(given, (one) => Arr.some(closings, (closing) => closing === one.answer)) ||
              answeredCalls.has(key)
            ) {
              holds(false);
              continue;
            }
            const fence = yield* fenceOf(launched);
            if (fence !== null) {
              if (!fencedCalls.has(key)) {
                yield* log(
                  launched.runId,
                  `${launched.agent}: the answers to its question are ${Str.uncapitalize(heldBehind(fence))}`,
                );
              }
              fencedCalls.add(key);
              holds(true);
              continue;
            }
            fencedCalls.delete(key);
            let sentAll = true;
            let unsure = false;
            const label = (at: number) =>
              call.questions[at]?.header || call.questions[at]?.question || names[at];
            const answered = (at: number) => answerTitle(given[at]);
            for (const group of bySender(Arr.map(given, (one) => one.by))) {
              const sent = yield* deliver(
                launched,
                group.at.length === 1
                  ? `Your question ${label(group.at[0]!)} is answered: ${answered(group.at[0]!)}`
                  : `Your questions are answered: ${Arr.join(
                      Arr.map(group.at, (at) => `${label(at)}: ${answered(at)}`),
                      "; ",
                    )}`,
                {
                  kind: "steer",
                  ref: names[group.at[0]!] ?? stem,
                  actor: group.by,
                  herdr: yield* herdr,
                  relayed: true,
                },
              );
              if (!sent.sent) {
                sentAll = false;
              }
              if (sent.blockedBy?.state === "unknown") {
                unsure = true;
                unsettledAnswers.set(launched.agent, sent.blockedBy);
              }
              if (sent.refused) {
                answeredCalls.add(key);
                yield* log(
                  launched.runId,
                  `${launched.agent}: was not sent the answers to ${Arr.join(
                    Arr.map(
                      Arr.map(group.at, (at) => names[at]),
                      (part) =>
                        part === null || part === undefined ? "" : globalThis.String(part),
                    ),
                    ", ",
                  )} (${sent.why})`,
                );
              }
            }
            if (sentAll) {
              answeredCalls.add(key);
              unsettledAnswers.delete(launched.agent);
            }
            // WARNING: an answer nobody could confirm landed is the Delivery's problem; holding the question would hide it.
            holds(!answeredCalls.has(key) && !unsure);
          }
          return open;
        }).pipe(
          withQuestionPass(launched.agent),
          Effect.orElseSucceed(() => false),
        );
    });

  const tendQuestions = (
    questionsFor: (runId: string) => Questions,
    askedOf: (
      runs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<AskedQuestion>>>,
    submitted: (queued: Queued, sent: Steered) => Effect.Effect<void> = () => Effect.void,
  ) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pendingRuns = yield* fs
          .readDirectory(launchDir(host.dir, ""))
          .pipe(Effect.orElseSucceed(() => []));
        const { boundary } = yield* Foreground;
        for (const run of pendingRuns) {
          yield* boundary;
          for (const queued of yield* readQueue(dirFor(run)).pipe(
            Effect.catch((cause) =>
              log(run, `Delivery queue could not be read: ${reason(cause)}`).pipe(Effect.as([])),
            ),
          )) {
            if (queued.result !== null) {
              continue;
            }
            yield* submitted(queued, yield* steer({ ...queued, mode: "now" }));
          }
        }
        const named = yield* fs
          .readDirectory(yield* controlDir(host.env.stateDir, ""))
          .pipe(Effect.orElseSucceed(() => []));
        yield* Effect.forEach(named, (agent) =>
          takeHarnessQuestions(host.env.stateDir, ports, agent).pipe(
            withQuestionPass(agent),
            Effect.ignore,
          ),
        );
        const asking = yield* Effect.filter(named, (agent) =>
          Effect.map(
            Effect.flatMap(controlDir(host.env.stateDir, agent), (dir) => questionsSince(dir, 0)),
            (calls) => calls.length > 0,
          ),
        );
        if (asking.length === 0) {
          return;
        }
        const launches = yield* launchesOfAgents(asking);
        const askedNow = new Map(
          Arr.map(
            [...(yield* askedOf(Arr.dedupe(Arr.map(launches, (one) => one.runId))))],
            ([runId, asked]) => [runId, new Map(Arr.map(asked, (one) => [one.name, one] as const))],
          ),
        );
        const alive = yield* Effect.cached(host.herdr.agentList().pipe(Effect.option));
        for (const agent of asking) {
          const launchesOf = Arr.filter(launches, (one) => one.agent === agent);
          const own = Arr.sortWith(
            launchesOf,
            (value) => value,
            (one, other) => Num.sign((one.at ?? 0) - (other.at ?? 0)),
          );
          let collected = false;
          for (const [at, launched] of own.entries()) {
            const next = own[at + 1];
            collected ||= yield* collecting.has(launched.runId, agent, stemOf(launched));
            if (collected) {
              continue;
            }
            const known = askedNow.get(launched.runId) ?? new Map<string, AskedQuestion>();
            askedNow.set(launched.runId, known);
            const tend = yield* questionsOf(
              launched,
              questionsFor(launched.runId),
              next?.at ?? Infinity,
              Effect.succeed(host.herdr),
              known,
            );
            if (!(yield* tend(null))) {
              continue;
            }
            if (
              Option.exists(yield* alive, (found) => !Arr.some(found, (one) => one.name === agent))
            ) {
              yield* tend(goneAnswer(agent));
            }
          }
        }
      }),
    ).pipe(Effect.orElseSucceed(() => undefined));

  const unhealthy = (launched: Launched) =>
    under(
      Effect.gen(function* () {
        let failedAt: number | null = null;
        let managed: ControlRecord | null = null;
        const budgetMs = host.readyMs ?? READY_TIMEOUT_MS;
        return yield* Effect.gen(function* () {
          const record = yield* readControl(host.env.stateDir, launched.agent).pipe(
            Effect.orElseSucceed(() => null),
          );
          const ready = record === null ? undefined : ports[record.harness]?.ready;
          const since = yield* Clock.currentTimeMillis;
          if (record?.endpoint != null && ready !== undefined) {
            if (managed?.endpoint !== record.endpoint) {
              failedAt = null;
            }
            managed = record;
            const up = yield* ready(record).pipe(
              Effect.orElseSucceed(() => false),
              Effect.timeoutOption(2000),
            );
            if (Option.isSome(up) && up.value) {
              failedAt = null;
              return null;
            }
          } else if (managed === null) {
            return null;
          }
          failedAt ??= since;
          if ((yield* Clock.currentTimeMillis) - failedAt < budgetMs) {
            return null;
          }
          return `${launched.agent}: ${managed.harness} server health at ${managed.endpoint} remained unavailable or unproved for ${Math.round(budgetMs / 1000)}s. Collie keeps collecting usable Output; replacement requires proven death and a Quiet predecessor.`;
        }).pipe(
          Effect.repeat({
            until: (why) => why !== null,
            schedule: Schedule.spaced(host.pollMs ?? DEFAULT_POLL_MS),
          }),
          Effect.filterOrElse(
            (why): why is string => why !== null,
            () => Effect.never,
          ),
        );
      }),
    );

  const collect = (
    launched: Launched,
    unless?: string | null,
    questions?: Questions,
    budgetMs?: number,
    usable?: (text: string) => boolean,
  ) =>
    under(
      collecting.during(
        launched.runId,
        launched.agent,
        Effect.gen(function* () {
          const asking = questions === undefined ? null : yield* questionsOf(launched, questions);
          const turnOver = Effect.suspend(() => host.herdr.agentStatus(launched.agent)).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((status) => status !== "working" && status !== "blocked"),
          );
          const text = yield* Effect.raceFirst(
            waitForOutput(launched.output, unless ?? null, {
              pollMs: host.pollMs ?? DEFAULT_POLL_MS,
              budgetMs: budgetMs ?? host.collectMs ?? DEFAULT_COLLECT_MS,
              counts: Effect.gen(function* () {
                if (asking !== null && (yield* asking(null))) {
                  return false;
                }
                if (yield* holdsBudgetOf(launched.runId, launched.agent)) {
                  return false;
                }
                return yield* turnOver;
              }),
              usable: usable ?? (() => true),
              settled: turnOver,
            }),
            confirmed(launched, unless ?? null).pipe(Effect.andThen(Effect.never)),
          );
          if (text !== null && asking !== null) {
            yield* asking(closedAnswer(launched.operation));
          }
          return text;
        }),
        stemOf(launched),
      ),
    );

  const repair = (launched: Launched, problem: string, unusable: string, round = 1) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const now = yield* fs.readFileString(launched.output).pipe(Effect.orElseSucceed(() => ""));
        if (Str.trim(now) !== "" && now !== unusable) {
          return true;
        }
        const text = repairText(launched.output, problem);
        const file = sentPath(launched, "repair");
        yield* write(file, text);
        const sent = yield* deliver(launched, text, {
          kind: "repair",
          ref: round === 1 ? stemOf(launched) : `${stemOf(launched)}.${round}`,
        });
        yield* log(
          launched.runId,
          sent.sent
            ? `${launched.agent}: asked to write ${launched.operation}.json again`
            : `${launched.agent}: could not be asked to write it again (${sent.why})`,
        );
        if (sent.refused) {
          return yield* refusedWith(
            launched,
            `${launched.agent} was not asked to write ${launched.operation}.json again (${sent.why})`,
            file,
          );
        }
        return sent.sent;
      }).pipe(
        Effect.catchIf(
          (cause) => !isParked(cause),
          (cause) =>
            log(
              launched.runId,
              `${launched.agent}: could not be asked to write it again (${reason(cause)})`,
            ).pipe(Effect.as(false)),
        ),
      ),
    );

  const endedWithoutOutput = (
    launched: Launched,
    may: Effect.Effect<boolean>,
    questions?: Questions,
  ) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const absent = fs.readFileString(launched.output).pipe(
          Effect.map((text) => Str.trim(text) === ""),
          Effect.orElseSucceed(() => true),
        );
        // WARNING: read here too: a turn that ended on a question may not be on its Run yet.
        const asking = questions === undefined ? null : yield* questionsOf(launched, questions);
        const unasked =
          asking === null ? Effect.succeed(true) : Effect.map(asking(null), (open) => !open);
        const statusNow = Effect.suspend(() => host.herdr.agentStatus(launched.agent)).pipe(
          Effect.orElseSucceed(() => null),
        );
        const settled = Effect.map(statusNow, (status) => status !== null && isSettled(status));
        let working = turnBegun.delete(launched.agent);
        for (;;) {
          const status = yield* statusNow;
          working ||= status === "working";
          if (
            working &&
            status !== null &&
            isSettled(status) &&
            (yield* absent) &&
            (yield* unasked) &&
            (yield* may) &&
            !(yield* holdsBudgetOf(launched.runId, launched.agent)) &&
            (openQuestions.get(launched.agent)?.size ?? 0) === 0 &&
            // WARNING: `unasked` can wait out a delivery of answers, which starts a turn.
            (yield* settled)
          ) {
            return;
          }
          yield* Effect.sleep(Duration.millis(host.pollMs ?? DEFAULT_POLL_MS));
        }
      }),
    );

  const settledNow = (launched: Launched, held: { terminal: string; delivery: string }) =>
    Effect.gen(function* () {
      const now = newestById(yield* readLedger(held.terminal)).get(held.delivery);
      if (now === undefined || isSettledDelivery(now)) {
        return true;
      }
      if (!(yield* dispatch.settleFromSubmit(host.env.stateDir, now))) {
        return false;
      }
      yield* log(
        launched.runId,
        `${launched.agent}: ${held.delivery} had landed; settled it as sent`,
      );
      return true;
    });

  const unsettledDelivery = (
    launched: Launched,
    held: { terminal: string; delivery: string },
    what: string,
  ) =>
    Effect.gen(function* () {
      yield* rememberUnsettled(`${host.dir}/runs/${launched.runId}`, held);
      return yield* new AgentParked({
        operation: launched.operation,
        reason: `${launched.agent} could not ${what}: delivery ${held.delivery} has not settled. Collie rechecks it; \`collie run deliveries ${launched.runId} --reconcile ${held.delivery} --as sent|not-sent\` settles it now.`,
        cause: "delivery-unsettled",
      });
    });

  const remind = (launched: Launched, ordinal: number) =>
    under(
      Effect.gen(function* () {
        const unsure = unsettledAnswers.get(launched.agent);
        if (unsure !== undefined) {
          if (!(yield* settledNow(launched, unsure))) {
            return yield* unsettledDelivery(
              launched,
              unsure,
              "be sent the answers to its question",
            );
          }
          unsettledAnswers.delete(launched.agent);
        }
        const sent = yield* deliver(launched, reminderText(launched.output), {
          kind: "repair",
          ref: `${stemOf(launched)}.remind-${ordinal}`,
        });
        const held = sent.sent ? undefined : sent.blockedBy;
        if (held !== undefined) {
          const settled =
            (yield* settledNow(launched, held)) ||
            (yield* Effect.sleep(Duration.millis(host.pollMs ?? DEFAULT_POLL_MS)).pipe(
              Effect.andThen(settledNow(launched, held)),
            ));
          if (!settled) {
            return yield* unsettledDelivery(
              launched,
              held,
              `be reminded to write ${launched.operation}.json`,
            );
          }
        }
        const wasSent = sent.sent || held !== undefined;
        yield* log(
          launched.runId,
          wasSent
            ? `${launched.agent}: ended its turn without ${launched.operation}.json, so was reminded to write it (${ordinal} of ${OUTPUT_REMINDERS})`
            : `${launched.agent}: ended its turn without ${launched.operation}.json, and could not be reminded to write it (${sent.why})`,
        );
        if (wasSent) {
          yield* reminded(launched, ordinal, "still-absent", 0);
        }
        return wasSent ? yield* nowIso : null;
      }).pipe(
        Effect.catchIf(
          (cause) => !isParked(cause),
          (cause) =>
            log(
              launched.runId,
              `${launched.agent}: could not be reminded to write ${launched.operation}.json (${reason(cause)})`,
            ).pipe(Effect.as(null)),
        ),
      ),
    );

  const reminded = (
    launched: Launched,
    ordinal: number,
    outcome: RecoveryOutcome,
    waitedMs: number,
  ) =>
    under(
      Effect.gen(function* () {
        yield* noteReminder(`${host.dir}/evidence/${launched.runId}`, {
          at: yield* nowIso,
          agent: launched.agent,
          recoveryId: `${launched.agent}:${stemOf(launched)}.remind-${ordinal}`,
          outcome,
          waitedMs,
          build: manifest.version,
        });
      }),
    );

  const launchesOf = (runId: string) => readLaunches(runId);

  const sessionHad = (runId: string, agent: string, kind: string, sequence: number) =>
    Effect.map(launchesOf(runId), (launches) =>
      Option.getOrNull(
        Arr.findLast(
          launches,
          (one) =>
            one.agent === agent &&
            (one.sequence ?? 1) === sequence &&
            one.agentSession?.kind === kind,
        ).pipe(Option.map((one) => one.agentSession?.value ?? null)),
      ),
    );

  const startedWith = (runId: string, agent: string) =>
    under(RunRecords.use((records) => records.control(RELAUNCH, runId, agent)));
  const setStarted = (runId: string, agent: string, text: string | null) =>
    under(RunRecords.use((records) => records.setControl(RELAUNCH, runId, text, agent)));

  const comingBack = new Map<string, Deferred.Deferred<void>>();
  const refusedStarts = new Map<string, string>();
  const turnBegun = new Set<string>();
  const resuming = Semaphore.makeUnsafe(1);

  const posting: (base: string, session: string) => DeliveringHerdr = (base, session) => ({
    agentList: () => host.herdr.agentList(),
    agentSendKeys: (target, keys) => host.herdr.agentSendKeys(target, keys),
    agentStatus: (target) => host.herdr.agentStatus(target),
    agentPrompt: (_target, text) =>
      promptAsync(base, session, text).pipe(
        Effect.as("unobserved" as const),
        Effect.mapError((cause) => new HerdrError({ message: cause.message, detail: "" })),
      ),
  });

  const relaunch = (
    runId: string,
    agent: string,
    launches: ReadonlyArray<Launched>,
    listed: { readonly agents: ReadonlyArray<AgentInfo>; readonly listedAt: string },
    run: RunNow,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* startedWith(runId, agent);
      if (text === null) {
        return [];
      }
      const started = yield* decodeStarted(text);
      const anchor = Arr.findLast(
        launches,
        (one) => one.agent === agent && stemOf(one) === stemOf(started),
      );
      if (Option.isNone(anchor)) {
        yield* log(
          runId,
          `${agent}: not started again on core: its started generation has no launch identity`,
        );
        return [];
      }
      const own = Arr.filter(
        launches,
        (one) =>
          one.agent === agent &&
          (one === anchor.value ||
            (anchor.value.terminalId !== undefined && one.terminalId !== undefined
              ? one.terminalId === anchor.value.terminalId
              : (one.sequence ?? 1) === (anchor.value.sequence ?? 1) &&
                sameSession(one.agentSession, anchor.value.agentSession))),
      );
      const latest = own.at(-1);
      if (latest === undefined) {
        return [];
      }
      const usage = yield* fs.exists(usageWaitPath(latest)).pipe(Effect.result);
      if (usage._tag === "Failure") {
        yield* log(runId, `${agent}: not started again on core: its usage wait could not be read`);
        return [];
      }
      if (usage.success) {
        return [];
      }
      const adapter = adapterFor(started.harness ?? host.harness);
      const had = Option.getOrNull(
        Arr.findLast(own, (one) => one.agentSession?.kind === adapter.kind).pipe(
          Option.flatMap((one) => Option.fromNullishOr(one.agentSession?.value)),
        ),
      );
      const out =
        Str.trim(yield* fs.readFileString(latest.output).pipe(Effect.orElseSucceed(() => ""))) ===
        "";
      const asking = out && (yield* (yield* questionsOf(latest, run.questions))(null));
      const pointer = yield* fs.readFileString(sentPath(latest, "step")).pipe(Effect.option);
      const told =
        !out || asking || Option.isNone(pointer)
          ? null
          : had === null
            ? pointer.value
            : `${RESUMED}\n\n${pointer.value}`;
      const atLaunch = told !== null && adapter.id === "opencode" && had === null;
      const ask: AgentAsk = {
        ...started,
        prompt: yield* fs
          .readFileString(`${dirFor(runId)}/${stemOf(started)}.prompt.md`)
          .pipe(Effect.orElseSucceed(() => "")),
        authority: yield* run.authority,
      };
      yield* uncertainStep(
        { ...ask, operation: latest.operation, sequence: latest.sequence },
        agent,
      );
      const session: StartSession | null =
        had !== null
          ? { id: had, resumed: true }
          : adapter.id === "pi" || adapter.id === "claude"
            ? { id: yield* (yield* SecureRandom.SecureRandom).uuidV4(), resumed: false }
            : null;
      const incarnation = yield* Effect.uninterruptible(
        start(ask, agent, listed, atLaunch ? told : null, session),
      );
      if (incarnation === undefined) {
        return [];
      }
      if (atLaunch) {
        turnBegun.add(agent);
      }
      let now = latest;
      for (const one of own) {
        const updated: Launched =
          one === latest && had === null && session !== null
            ? {
                ...one,
                terminalId: incarnation.terminalId,
                agentSession: { kind: adapter.kind, value: session.id },
              }
            : { ...one, terminalId: incarnation.terminalId };
        yield* recordLaunch(updated);
        if (one === latest) {
          now = updated;
        }
      }
      yield* log(
        runId,
        `${agent}: started again on core after core lost it, ${had === null ? "in a new session: none was recorded to resume" : `resuming its ${adapter.id} session ${had}`}`,
      );
      if (told === null || atLaunch) {
        return [];
      }
      const tell = Effect.gen(function* () {
        if (adapter.id === "opencode") {
          // WARNING: the reporter's idleness is the signal, never a timer: text typed before the TUI is up is lost.
          const budgetMs = host.readyMs ?? READY_TIMEOUT_MS;
          const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
          const idle = yield* Effect.suspend(() => host.herdr.agentStatus(agent)).pipe(
            Effect.map(isSettled),
            Effect.orElseSucceed(() => false),
            Effect.repeat({
              until: (settled) => settled,
              schedule: Schedule.spaced(host.pollMs ?? DEFAULT_POLL_MS).pipe(
                Schedule.while(({ now }) => now < deadline),
              ),
            }),
          );
          if (!idle) {
            return yield* log(
              runId,
              `${agent}: not resumed: OpenCode reported no idle within ${Math.round(budgetMs / 1000)}s, so it was not told to carry on with ${latest.operation}`,
            );
          }
        }
        const late = yield* awaitReady(
          compactionDeps(host, runId),
          agent,
          host.readyMs ?? READY_TIMEOUT_MS,
        );
        if (late !== null) {
          return yield* log(runId, `${agent}: was not told to carry on with its step: ${late}`);
        }
        let delivery: Parameters<typeof deliver>[2] = { kind: "step", ref: stemOf(latest) };
        const base =
          adapter.id === "opencode"
            ? ((yield* readControl(host.env.stateDir, agent))?.endpoint ?? null)
            : null;
        if (base !== null && had !== null) {
          delivery = { ...delivery, herdr: posting(base, had) };
        }
        const sent = yield* deliver(now, told, delivery);
        yield* log(
          runId,
          sent.sent
            ? `${agent}: told to carry on with ${latest.operation}`
            : adapter.id === "opencode"
              ? `${agent}: not resumed: its carry-on for ${latest.operation} was not taken (${sent.why})`
              : `${agent}: was not told to carry on with ${latest.operation} (${sent.why})`,
        );
      }).pipe(
        Effect.catch((cause) =>
          log(runId, `${agent}: was not told to carry on with its step (${reason(cause)})`),
        ),
      );
      return [tell];
    });

  const resumeLost = (runId: string, run: RunNow) =>
    under(
      resuming
        .withPermits(1)(
          Effect.gen(function* () {
            const agents = Arr.map(
              yield* RunRecords.use((records) => records.controlsOf(RELAUNCH, runId)),
              (one) => one.key,
            );
            if (agents.length === 0 || !(yield* run.running)) {
              return;
            }
            const backs = Arr.map(agents, (agent) => ({
              agent,
              back: Deferred.makeUnsafe<void>(),
            }));
            for (const { agent, back } of backs) {
              comingBack.set(agent, back);
            }
            const released = Effect.forEach(backs, ({ agent, back }) =>
              Effect.suspend(() => {
                if (comingBack.get(agent) === back) {
                  comingBack.delete(agent);
                }
                return Deferred.succeed(back, undefined);
              }),
            );
            yield* Effect.gen(function* () {
              const listedAt = yield* nowIso;
              const listing = yield* host.herdr.agentList().pipe(Effect.option);
              if (Option.isNone(listing)) {
                return;
              }
              const launches = yield* launchesOf(runId);
              const tells: Array<Effect.Effect<void, never, AgentServices>> = [];
              for (const agent of agents) {
                if (Arr.some(listing.value, (one) => one.name === agent)) {
                  continue;
                }
                if (stepsGoingOut.has(agent)) {
                  continue;
                }
                tells.push(
                  ...(yield* withRelaunchLock(
                    host.env.stateDir,
                    runId,
                    log(
                      runId,
                      `${agent}: not started again on core: an end of it is still under way`,
                    ).pipe(Effect.as([])),
                    relaunch(runId, agent, launches, { agents: listing.value, listedAt }, run),
                  ).pipe(
                    Effect.catch((cause) =>
                      Effect.sync(() => {
                        if (isParked(cause)) {
                          refusedStarts.set(agent, cause.reason);
                        }
                      }).pipe(
                        Effect.andThen(
                          log(
                            runId,
                            `${agent}: could not be started again on core (${isParked(cause) ? cause.reason : reason(cause)})`,
                          ),
                        ),
                        Effect.as([]),
                      ),
                    ),
                  )),
                );
              }
              for (const tell of tells) {
                yield* tell;
              }
            }).pipe(Effect.ensuring(released));
          }),
        )
        .pipe(withRecoveryGate(runId)),
    );

  const uncertainStep = (ask: AgentAsk, agent: string) =>
    Effect.gen(function* () {
      const stem = stemOf(ask);
      const held = Arr.findFirst(
        yield* deliveriesOf(ask.runId),
        (one) =>
          one.agent === agent &&
          (one.cause.kind === "step" || one.cause.kind === "repair") &&
          (one.cause.ref === stem ||
            (one.cause.kind === "repair" &&
              pipe(one.cause.ref, Str.startsWith(`${stem}.`)) &&
              /^[1-9]\d*$/.test(pipe(one.cause.ref, Str.slice(stem.length + 1))))) &&
          (one.state === "unknown" || one.state === "reserved" || isUnobserved(one)),
      );
      if (Option.isSome(held)) {
        return yield* new AgentParked({
          operation: ask.operation,
          reason: `${agent}: delivery ${held.value.id} remains ${held.value.state}; server loss does not say whether it was received. Settle it with \`collie run deliveries ${ask.runId} --reconcile ${held.value.id} --as sent|not-sent\`, then \`collie run resume ${ask.runId}\`.`,
        });
      }
    });

  const retireLost = (ask: AgentAsk, agent: string, listed: ReadonlyArray<AgentInfo>) =>
    Effect.gen(function* () {
      const lost = yield* lostServer(compactionDeps(host, ask.runId), agent);
      if (lost === null) {
        return false;
      }
      yield* uncertainStep(ask, agent);
      const owned = yield* readControl(host.env.stateDir, agent).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (owned?.runLog !== `${dirFor(ask.runId)}/agents.log` || owned.cwd !== ask.cwd) {
        return yield* unsettled(
          ask,
          `${lost}; its control identity does not match this Run and checkout`,
        );
      }
      const launched = Arr.findLast(
        yield* launchesOf(ask.runId),
        (one) => one.agent === agent && (one.sequence ?? 1) === (ask.sequence ?? 1),
      );
      if (Option.isNone(launched)) {
        return yield* unsettled(ask, `${lost}; its terminal has no launch identity`);
      }
      const ended = yield* endAgent(endsOf(ask.runId), launched.value, lost, "close", listed).pipe(
        Effect.mapError((cause) =>
          unsettled(ask, `${lost}; it could not be ended (${reason(cause)})`),
        ),
      );
      if (ended._tag !== "Closed" || !ended.ended) {
        return yield* unsettled(
          ask,
          `${lost}; ${"reason" in ended ? ended.reason : "its terminal changed before it could be ended"}`,
        );
      }
      yield* log(ask.runId, `${agent}: ${lost}; recovering its work in the same Run`);
      return true;
    });

  const revive = (
    ask: AgentAsk,
    unless?: string | null,
    onlyDeadServer = false,
    usable?: (text: string) => boolean,
  ) =>
    under(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        if (yield* fs.exists(usageWaitPath(ask)).pipe(Effect.orElseSucceed(() => true))) {
          return false;
        }
        const agent = yield* nameFor(ask);
        const refused = refusedStarts.get(agent);
        if (refused !== undefined) {
          refusedStarts.delete(agent);
          yield* setStarted(ask.runId, agent, null);
          return yield* new AgentParked({ operation: ask.operation, reason: refused });
        }
        const lost = yield* lostServer(compactionDeps(host, ask.runId), agent);
        if (onlyDeadServer && lost === null) {
          return false;
        }
        const completed = waitForOutput(ask.output, unless ?? null, {
          pollMs: host.pollMs ?? DEFAULT_POLL_MS,
          budgetMs: 0,
          counts: Effect.succeed(false),
          usable: usable ?? (() => true),
          settled: Effect.suspend(() => host.herdr.agentStatus(agent)).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((status) => status !== "working" && status !== "blocked"),
          ),
        });
        if ((yield* completed) !== null) {
          return false;
        }
        const rows = Arr.filter(
          yield* everyRegistered,
          (one) => one.agent === agent && one.runId === ask.runId,
        );
        if (
          Arr.isReadonlyArrayNonEmpty(rows) &&
          !Arr.some(rows, (one) => one.incarnation?.backend === "core")
        ) {
          yield* log(ask.runId, `${agent}: started before core, so not started again`);
          return false;
        }
        if (lost === null && (yield* startedWith(ask.runId, agent)) !== null) {
          return false;
        }
        const listing = yield* host.herdr.agentList().pipe(Effect.option);
        if (listing._tag === "None") {
          return false;
        }
        if (lost !== null) {
          if (!(yield* retireLost(ask, agent, listing.value))) {
            return false;
          }
          if ((yield* completed) !== null) {
            return false;
          }
          yield* launch(ask);
          return true;
        }
        const refusal = Arr.some(listing.value, (one) => one.name === agent)
          ? yield* host.herdr
              .agentStatus(agent)
              .pipe(Effect.match({ onFailure: herdrFailureReason, onSuccess: () => "" }))
          : "";
        if (!isGone(agent, listing.value, refusal)) {
          return false;
        }
        yield* log(
          ask.runId,
          `${agent}: gone before ${ask.operation} was written; starting it again`,
        );
        yield* launch(ask, true);
        return true;
      }).pipe(withRecoveryGate(ask.runId)),
    );

  const handOff = (options: {
    readonly runId: string;
    readonly role: string;
    readonly lineage: ReadonlyArray<string>;
    readonly text: string;
  }) =>
    under(
      Effect.gen(function* () {
        const alive = yield* host.herdr.agentList();
        const others = Arr.filter(options.lineage, (runId) => runId !== options.runId);
        const entry = yield* lineageAgent(alive, options.role, others);
        // WARNING: without a proven incarnation the entry names a pane, not the agent now in it.
        if (entry === null) {
          return null;
        }
        if (!verifyIncarnation(entry, alive).ok) {
          return null;
        }
        const handed = { agent: entry.agent, delivered: true, detail: "" };
        const earlier = Arr.filter(
          yield* deliveriesOf(entry.runId),
          (delivery) => delivery.cause.kind === "handoff" && delivery.cause.ref === options.runId,
        );
        if (
          Arr.some(earlier, (delivery) =>
            Boolean(
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(delivery.note), (present____) =>
                  pipe(present____, Str.startsWith("reconciled as sent")),
                ),
              ),
            ),
          )
        ) {
          return handed;
        }
        const outcome = yield* dispatch.transaction(deps, entry, (channel) =>
          channel.submit(options.text, {
            run: entry.runId,
            cause: { kind: "handoff", ref: options.runId },
            mode: "boundary",
            intentVersion: 0,
            attempt: 1,
            requestId: `${options.runId}-handoff-${entry.agent}`,
          }),
        );
        if (outcome.ok || (outcome.held !== undefined && SENT_STATES.has(outcome.held))) {
          yield* log(options.runId, `handed to ${entry.agent} of ${entry.runId}`);
          return handed;
        }
        if (outcome.reason === "unknown" || outcome.reason === "blocked") {
          return yield* new AgentParked({
            operation: "handoff",
            reason: `Nobody can say whether ${entry.agent} of ${entry.runId} was handed this (${outcome.detail}), so no second agent was started on it. \`collie run deliveries ${entry.runId}\` shows it; settle it with \`--reconcile <id> --as sent\` or \`--as not-sent\`, then \`collie run resume ${options.runId}\`.`,
          });
        }
        yield* log(
          options.runId,
          `could not hand to ${entry.agent} (${outcome.reason}: ${outcome.detail})`,
        );
        return { agent: entry.agent, delivered: false, detail: outcome.detail };
      }).pipe(
        Effect.catchIf(
          (cause) => !isParked(cause),
          (cause) =>
            Effect.fail(
              new AgentParked({
                operation: "handoff",
                reason: `Whether an agent here can take this could not be read (${reason(cause)}).`,
              }),
            ),
        ),
      ),
    );

  const ranOut = (launched: Launched) =>
    under(
      Effect.gen(function* () {
        const incident = yield* usageIncident(launched);
        if (incident !== null) {
          return incident;
        }
        const dir = yield* controlDir(host.env.stateDir, launched.agent);
        const on = pinned(choiceOfLaunch(launched));
        let readAt = Number.NEGATIVE_INFINITY;
        let resetsAt: string | null = null;
        for (;;) {
          const reported = yield* ranOutSince(dir, launched.at ?? 0);
          const now = yield* Clock.currentTimeMillis;
          let exhausted: string | null = null;
          let exhaustion: RanOut["exhaustion"];
          if (reported !== null || now - readAt >= READING_EVERY_MS) {
            readAt = now;
            const machine = yield* host.readings ?? Effect.succeed([]);
            const own =
              host.ownReading === undefined ? null : yield* host.ownReading(launched.agent);
            const readings =
              own === null
                ? machine
                : [own, ...Arr.filter(machine, (one) => one.subscription !== own.subscription)];
            const judged = roomFor(readings, now)(on, undefined);
            exhausted = judged.room ? null : judged.why;
            resetsAt = exhausted === null ? null : (usedFor(readings, on, now)?.resetsAt ?? null);
            const reading = Arr.findFirst(
              readings,
              (one) =>
                one.subscription === subscriptionOf(on) &&
                one.problem === null &&
                Arr.some(
                  one.windows,
                  (window) =>
                    appliesTo(window, on.model) && isFull(currentUsageWindow(window, now)),
                ),
            );
            if (Option.isSome(reading)) {
              exhaustion = {
                at: now,
                account: reading.value.account,
                windows: Arr.map(
                  Arr.filter(
                    reading.value.windows,
                    (window) =>
                      appliesTo(window, on.model) && isFull(currentUsageWindow(window, now)),
                  ),
                  ({ kind, model, resetsAt }) => ({ kind, model, resetsAt }),
                ),
              };
            }
          }
          const why = exhausted ?? reported?.why;
          if (why !== undefined) {
            const result: Types.Mutable<RanOut> = {
              _tag: "RanOut",
              why,
              transcript: reported?.transcript ?? null,
              resetsAt,
              observedAt: now,
            };
            if (exhaustion !== undefined) {
              result.exhaustion = exhaustion;
            }
            // WARNING: core recovery must see the wait even before this RanOut is journaled.
            yield* usageWaiting(launched, result);
            return result;
          }
          yield* Effect.sleep(Duration.millis(host.pollMs ?? DEFAULT_POLL_MS));
        }
      }).pipe(Effect.orDie),
    );

  const endsOf: (runId: string) => EndDeps = (runId) => ({
    ...compactionDeps(host, runId),
    herdr: host.herdr,
    stopMs: host.stopMs,
  });

  const retire = (launched: Launched, line: string, done = "ran out") =>
    under(
      Effect.gen(function* () {
        const parked = (why: string) =>
          new AgentParked({
            operation: launched.operation,
            reason: `${launched.agent} ${done} and must stop before another agent takes its work, but ${why}. Close it and resume.`,
          });
        const ended = yield* endAgent(endsOf(launched.runId), launched, `it ${done}`, "close").pipe(
          Effect.mapError((failure) =>
            failure._tag === "AgentsUnlisted"
              ? parked(
                  `core cannot say whether it is running (${herdrFailureReason(failure.cause)})`,
                )
              : parked(
                  `its pane ${failure.paneId} would not close (${herdrFailureReason(failure.cause)})`,
                ),
          ),
        );
        if (ended._tag === "Unprovable") {
          return yield* parked(`it ${UNPROVABLE}`);
        }
        if (ended._tag === "NotQuiet") {
          if (ended.locked !== undefined) {
            return yield* parked(`it could not be stopped (${ended.locked})`);
          }
          yield* rememberNotQuiet(`${host.dir}/runs/${launched.runId}`, {
            agent: launched.agent,
            left: ended.left ?? [],
          });
          return yield* new AgentParked({
            operation: launched.operation,
            reason: `${ended.reason}. It ${done}, and no agent takes its work until it has stopped; this Run goes on once it has`,
            cause: "predecessor-not-quiet",
          });
        }
        yield* log(launched.runId, line);
      }),
    );

  const halt = (runId: string, why = "its Run was stopped") =>
    under(
      Effect.gen(function* () {
        const stopped: Array<string> = [];
        const left: Array<string> = [];
        const launchedBefore = new Set(Arr.map(yield* launchesOf(runId), (one) => one.agent));
        const found = yield* serversOfRun(host.env.stateDir, `${dirFor(runId)}/agents.log`).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              servers: [],
              unread: [`its agents' control records cannot be listed (${reason(cause)})`],
            }),
          ),
        );
        left.push(...found.unread);
        for (const name of Arr.filter(found.servers, (one) => !launchedBefore.has(one))) {
          const reached = yield* stopUnlaunched(
            compactionDeps(host, runId),
            name,
            host.stopMs,
          ).pipe(Effect.result);
          if (reached._tag === "Failure") {
            left.push(
              reached.failure._tag === "ControlsInUse"
                ? `${name} could not be stopped yet: a start, prune or stop still holds its controls`
                : `${name} could not be stopped (${reason(reached.failure)})`,
            );
          } else if (reached.success?.state === "quiet") {
            stopped.push(name);
          } else if (reached.success !== null) {
            left.push(notStopped(name, reached.success, reached.success.target));
          }
        }
        const launches = yield* launchesOf(runId);
        if (launches.length === 0) {
          return yield* reported(runId, stopped, left);
        }
        const listing = yield* host.herdr.agentList().pipe(Effect.result);
        if (listing._tag === "Failure") {
          left.push(`core cannot say which agents it has (${reason(listing.failure)})`);
          return yield* reported(runId, stopped, left);
        }
        // WARNING: every launched agent, listed or not: a closed pane is not a stopped server.
        for (const name of new Set(Arr.map(launches, (launched) => launched.agent))) {
          const ours = Option.getOrUndefined(
            Arr.findLast(launches, (launched) => launched.agent === name),
          )!;
          const ended = yield* endAgent(endsOf(runId), ours, why, "close", listing.success).pipe(
            Effect.result,
          );
          if (ended._tag === "Failure") {
            const failure = ended.failure;
            left.push(
              failure._tag === "PaneOpen"
                ? `${name}'s pane ${failure.paneId} would not close (${reason(failure.cause)})`
                : `core cannot say which agents it has (${reason(failure.cause)})`,
            );
          } else if (ended.success._tag === "Closed") {
            if (ended.success.ended) {
              stopped.push(name);
            }
          } else {
            left.push(ended.success.reason);
          }
        }
        return yield* reported(runId, stopped, left);
      }),
    );

  const reported = (runId: string, stopped: Array<string>, left: Array<string>) =>
    Effect.gen(function* () {
      if (stopped.length > 0) {
        yield* log(runId, `stopped ${Arr.join(stopped, ", ")}`);
      }
      if (left.length > 0) {
        yield* log(runId, `not stopped: ${Arr.join(left, "; ")}`);
      }
      return { stopped, left };
    });

  const candidatesOf = (runId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* Effect.forEach(yield* launchesOf(runId), (one) =>
        fs.exists(one.output).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((done) => ({ ...one, done })),
        ),
      );
    });

  const steer = (options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly to?: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: DeliveryMode;
    readonly actor?: Asker;
    readonly workflowNotice?: string;
  }) =>
    under(
      Effect.gen(function* () {
        const { to, operation, agent } = options;
        const queued = Option.getOrUndefined(
          Arr.findFirst(
            yield* readQueue(dirFor(options.runId)).pipe(Effect.orDie),
            (one) => one.request === options.request,
          ),
        );
        if (queued?.result != null) {
          return queued.result;
        }
        const candidates = yield* candidatesOf(options.runId);
        const launched = steerTarget(candidates, queued ?? { to, operation, agent }, launchedAs);
        if (launched === undefined) {
          const live = Arr.filter(candidates, (one) => !one.done);
          const named = agent ?? operation ?? to;
          return {
            agent: "",
            delivered: false,
            detail: `${options.runId} has launched no agent${named === undefined ? "" : ` for "${named}"`}${
              live.length === 0
                ? ""
                : `; live: ${Arr.join(
                    Arr.map(live, (one) => `${one.agent} (${one.role})`),
                    ", ",
                  )}`
            }`,
            gone: live.length === 0,
          };
        }
        const out = stepsGoingOut.get(launched.agent);
        if (out !== undefined) {
          yield* Deferred.await(out);
        }
        const unsupported =
          options.mode === "now" &&
          (yield* gate(launched.harness, "now").pipe(
            Effect.as(false),
            Effect.orElseSucceed(() => true),
          ));
        const fallback = unsupported || queued !== undefined;
        const named =
          agent ??
          operation ??
          (Rec.has<string, ReadonlyArray<string>>(ROLES, to ?? "") ? undefined : to);
        const pinned =
          agent !== undefined ||
          (named !== undefined &&
            named !== launched.operation &&
            (named === launched.agent || launchedAs(launched, named)));
        const pending: Types.Mutable<Queued> = queued ?? {
          runId: options.runId,
          request: options.request,
          text: options.text,
          ...(pinned ? { agent: launched.agent } : { operation: launched.operation }),
          result: null,
        };
        if (options.workflowNotice !== undefined && queued === undefined) {
          pending.workflowNotice = options.workflowNotice;
        }
        if (options.actor !== undefined && queued === undefined) {
          pending.actor = Struct.omit(actorOf(options.actor, options.request), ["requestId"]);
        }
        // WARNING: held for humans and agents alike; a message landing mid-Check moves the tree it proves.
        const fence = yield* fenceOf(launched);
        if (fence !== null) {
          yield* keepQueued(dirFor(options.runId), pending).pipe(Effect.orDie);
          return {
            agent: launched.agent,
            delivered: false,
            queued: true,
            detail: heldBehind(fence),
          };
        }
        if (fallback) {
          const found = yield* entryFor(launched, launched.agent, null);
          if (found.entry === null) {
            return {
              agent: launched.agent,
              delivered: false,
              detail: found.reason ?? "no such agent",
              gone: found.gone,
            };
          }
          yield* keepQueued(dirFor(options.runId), pending).pipe(Effect.orDie);
          const status = yield* host.herdr
            .agentStatus(launched.agent)
            .pipe(Effect.orElseSucceed(() => "unknown" as const));
          if (!isSettled(status)) {
            return {
              agent: launched.agent,
              delivered: false,
              queued: true,
              detail:
                "Queued durably; the host will deliver when this agent is idle, without answering its Run's choices.",
            };
          }
          const previous = Option.getOrUndefined(
            Arr.findFirst(
              yield* deliveriesOf(options.runId),
              (one) =>
                one.cause.kind === "steer" &&
                one.cause.ref === options.request &&
                !Arr.contains(["failed", "superseded"], one.state),
            ),
          );
          if (previous !== undefined) {
            const result = SENT_STATES.has(previous.state)
              ? receipt(previous.agent, {
                  id: previous.id,
                  observed:
                    previous.state === "acknowledged" ? "taken when it was first sent" : null,
                })
              : {
                  agent: previous.agent,
                  delivered: false,
                  detail: `${previous.id} is ${previous.state}; reconcile before resending`,
                };
            yield* keepQueued(dirFor(options.runId), { ...pending, result }).pipe(Effect.orDie);
            return result;
          }
        }
        const sent = yield* deliver(launched, pending.text, {
          kind: "steer",
          ref: options.request,
          mode: fallback ? "boundary" : options.mode,
          idleOnly: fallback,
          actor: pending.actor,
          workflowNotice: pending.workflowNotice,
        });
        yield* log(
          options.runId,
          sent.sent
            ? toldLine(launched.agent, pending.text)
            : `${launched.agent}: could not be told "${firstLine(pending.text)}" (${sent.why})`,
        );
        if (sent.sent) {
          const result = receipt(launched.agent, sent);
          if (fallback) {
            yield* keepQueued(dirFor(options.runId), { ...pending, result }).pipe(Effect.orDie);
          }
          return result;
        }
        if (fallback && !pipe(sent.why, Str.startsWith("unknown:"))) {
          return {
            agent: launched.agent,
            delivered: false,
            queued: true,
            detail: `Queued durably; waiting for a supported idle submission (${sent.why}).`,
          };
        }
        const alive = yield* host.herdr.agentList().pipe(Effect.orElseSucceed(() => []));
        return {
          agent: launched.agent,
          delivered: false,
          detail: sent.why,
          gone: isGone(launched.agent, alive, sent.why),
        };
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            agent: "",
            delivered: false,
            detail: reason(cause),
          }),
        ),
      ),
    );

  const checkoutOf = (cwd: string) =>
    host.checkout?.(cwd) ??
    under(
      Effect.map(treeOf(cwd), ({ head_sha, branch, dirty }) => ({ head: head_sha, branch, dirty })),
    );
  const planOf = (plan: string | null | undefined) =>
    plan == null
      ? Effect.succeed(null)
      : under(planRevision(plan)).pipe(Effect.orElseSucceed(() => null));
  const handOverJournal = (runId: string) =>
    runJournal(`${host.dir}/runs/${runId}`, "hand-overs.jsonl");
  const HandOverJson = Schema.fromJsonString(HandOver);

  return {
    outputFor,
    handOver: (about) =>
      under(
        Effect.gen(function* () {
          const at = handOverJournal(about.run);
          const earlier = yield* readRunJournal(at, HandOverJson).pipe(
            Effect.orElseSucceed(() => []),
          );
          const intent = yield* readIntent(`${host.dir}/runs/${about.run}`).pipe(
            Effect.orElseSucceed(() => null),
          );
          const record = buildHandOver({
            ...about,
            revision: earlier.length + 1,
            goal: intent?.goal ?? null,
            constraints: Arr.map(intent?.constraints ?? [], (one) => one.text),
            plan: yield* planOf(about.given.plan),
            checkout: yield* checkoutOf(about.cwd),
            reports: `${host.dir}/runs/${about.run}/handoffs`,
          });
          yield* appendRunJournal(at, HandOverJson, record);
          return record;
        }),
      ).pipe(Effect.orDie),
    atCheckout: (cwd, plan) =>
      Effect.all({ now: checkoutOf(cwd), plan: planOf(plan) }).pipe(
        Effect.map(({ now, plan }) => ({ head: now.head, plan, dirty: now.dirty })),
      ),
    handOverStale: (runId, seen) =>
      under(rememberStaleHandOver(`${host.dir}/runs/${runId}`, seen)).pipe(Effect.orDie),
    stepMessage: (ask) => {
      const prompt = promptFile(ask);
      const text = stepText(adapterFor(ask.harness ?? host.harness), ask, prompt);
      return { typed: dispatch.marked(text, `${ask.runId}-${stemOf(ask)}-step-1`), prompt };
    },
    skills: (names) => under(skills(names)),
    outputSubmit: under(readConfig(host.env.userDir)).pipe(
      Effect.map((config) => (config.output_submit === "tool" ? "tool" : "file")),
      Effect.orElseSucceed(() => "file" as const),
    ),
    attachments: (runId) =>
      under(listAttachments(attachmentsDir(`${host.dir}/runs/${runId}`))).pipe(
        Effect.orElseSucceed(() => []),
      ),
    askRoute: (role, lineage) =>
      under(
        Effect.gen(function* () {
          const alive = yield* host.herdr.agentList();
          const entry = yield* lineageAgent(alive, role, lineage);
          return askRouteTo(entry !== null && verifyIncarnation(entry, alive).ok ? entry : null);
        }).pipe(Effect.orElseSucceed(() => askRouteTo(null))),
      ),
    pollMs: host.pollMs ?? DEFAULT_POLL_MS,
    collectMs: host.collectMs ?? DEFAULT_COLLECT_MS,
    unhealthy,
    choose: (layers, { runId, operation }, spent = []) =>
      under(
        Effect.gen(function* () {
          const raw = (yield* readConfig(host.env.userDir).pipe(
            Effect.mapError((cause) => new WorkflowError({ reason: String(cause) })),
          )).claude_subagents;
          const policy =
            raw === undefined
              ? undefined
              : yield* readSubagents(raw).pipe(
                  Effect.mapError(
                    (cause) => new WorkflowError({ reason: `claude_subagents: ${String(cause)}` }),
                  ),
                );
          const configured = {
            harness: host.harness,
            model: host.model,
            effort: host.effort,
            claudeSubagents: policy,
          };
          const readings = yield* host.readings ?? Effect.succeed([]);
          const chain =
            host.fallbacks ??
            loadDefaults(host.env.userDir).pipe(
              Effect.map(({ fallbacks }) => fallbacks),
              Effect.orElseSucceed(() => []),
            );
          const now = yield* Clock.currentTimeMillis;
          const read = roomFor(readings, now);
          const out = Arr.map(spent, (one) => ({ ...one, on: pinned(one.on) }));
          const fallbacks = yield* chain;
          const catalogue = host.catalogue === undefined ? undefined : yield* host.catalogue;
          const room: Room = (choice, upTo) => {
            const judged = read(choice, upTo);
            const ran = Option.getOrUndefined(
              Arr.findFirst(
                out,
                (one) => sameUsage(one.on, choice) && !usageRecovered(one, readings, now),
              ),
            );
            return judged.room && ran !== undefined ? { room: false, why: ran.why } : judged;
          };
          const resolved = resolveWithRoom(
            [configured, ...layers],
            fallbacks,
            room,
            host.models,
            catalogue,
          );
          if (!resolved.ok) {
            return yield* new WorkflowError({ reason: resolved.problem });
          }
          const { choice, from, why, skipped } = resolved.chosen;
          const after = resolveWithRoom(
            [configured, ...layers],
            fallbacks,
            (one, upTo) =>
              sameUsage(pinned(one), pinned(choice))
                ? { room: false, why: "spent" }
                : room(one, upTo),
            host.models,
            catalogue,
          );
          const next = after.ok && after.chosen.from !== null ? after.chosen.choice : null;
          for (const line of skipped) {
            yield* log(runId, `${operation}: ${line}`);
          }
          if (spent.length === 0 && from !== null) {
            yield* log(
              runId,
              `${operation}: fell back from ${said(from)} to ${said(choice)}: ${why}`,
            );
          } else if (spent.length === 0 && why !== null) {
            yield* log(runId, `${operation}: stays on ${said(choice)}: ${why}`);
          }
          const chosen: Types.Mutable<ChosenAgent> = { ...choice };
          fellBack(chosen, from, why);
          if (next !== null) {
            chosen.next = { harness: next.harness, model: next.model, effort: next.effort };
          }
          return chosen;
        }),
      ),
    choiceOf: (runId, agent) =>
      under(
        Effect.gen(function* () {
          const held = Option.getOrUndefined(
            Arr.findLast(yield* launchesOf(runId), (one) => launchedAs(one, agent)),
          );
          if (held === undefined) {
            return null;
          }
          const listing = yield* host.herdr.agentList().pipe(Effect.option);
          const alive = Option.exists(listing, (agents) =>
            Arr.some(agents, (one) => one.name === held.agent),
          );
          if (!alive || held.model === undefined) {
            return null;
          }
          const running: Types.Mutable<
            ChosenAgent & { sequence: number; outputSubmit: "file" | "tool" }
          > = {
            harness: held.harness,
            model: held.model,
            effort: held.effort ?? null,
            sequence: held.sequence ?? 1,
            outputSubmit: held.outputSubmit ?? "file",
          };
          if (held.claudeSubagents !== undefined) {
            running.claudeSubagents = held.claudeSubagents;
          }
          fellBack(running, held.from, held.why);
          if (held.next !== undefined) {
            running.next = held.next;
          }
          return running;
        }),
      ),
    launch: (ask, note) => launch(ask, false, note),
    revive,
    ranOut,
    stopped: (launched, since) =>
      under(
        Effect.gen(function* () {
          const dir = yield* controlDir(host.env.stateDir, launched.agent);
          return (yield* stoppedSince(dir, since ?? launched.at ?? 0))?.why ?? null;
        }).pipe(Effect.orDie),
      ),
    retire,
    lastLaunch: (runId, agent) =>
      under(
        Effect.map(launchesOf(runId), (launches) =>
          Option.getOrNull(Arr.findLast(launches, (one) => launchedAs(one, agent))),
        ),
      ),
    say: (runId, line) => under(log(runId, line)),
    handOff,
    halt,
    account: (runId, heal) =>
      under(
        Effect.gen(function* () {
          const agents = Arr.dedupe(Arr.map(yield* launchesOf(runId), (one) => one.agent));
          for (const agent of agents) {
            yield* recordUsage(ledgerDeps(host), { run: runId, agent, heal });
          }
        }).pipe(Effect.ignore),
      ),
    collect: (...args: Parameters<typeof collect>) =>
      Effect.tap(collect(...args), (text) =>
        text === null
          ? Effect.void
          : under(RunRecords.use((records) => records.touch(args[0].runId))),
      ),
    peekOutput: (launched) =>
      under(
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.readFileString(launched.output)),
          Effect.map((text) => (Str.trim(text) === "" ? null : text)),
          Effect.orElseSucceed(() => null),
        ),
      ),
    usageWaiting,
    usageIncident,
    collectedDuring: (launched, waiting) =>
      collecting.during(launched.runId, launched.agent, waiting),
    repair,
    endedWithoutOutput,
    remind,
    reminded,
    resumedOutput: (launched, round) =>
      under(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const marker = `${dirFor(launched.runId)}/${stemOf(launched)}.parked-${round}`;
          if (yield* fs.exists(marker)) {
            return yield* fs.readFileString(launched.output).pipe(Effect.orElseSucceed(() => ""));
          }
          yield* fs.writeFileString(marker, "");
          return null;
        }),
      ).pipe(Effect.orDie),
    steer,
    tendQuestions,
    statusOf: (agent) =>
      under(host.herdr.agentStatus(agent)).pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            cause.code === "agent_not_found" ? ("gone" as const) : ("unknown" as const),
          ),
        ),
      ),
    resumeLost,
    onLosses: (resumed) => under(Stream.runForEach(host.herdr.terminalsEnded(), () => resumed)),
    atWork: (runId) =>
      under(candidatesOf(runId).pipe(Effect.map((all) => steerTarget(all, {}) ?? null))).pipe(
        Effect.orElseSucceed(() => null),
      ),
    correct: (runId, correction) =>
      under(
        Effect.gen(function* () {
          const launched = steerTarget(yield* candidatesOf(runId), {});
          if (launched === undefined) {
            return false;
          }
          const sent = yield* deliver(launched, correction.text, {
            kind: "correction",
            ref: correction.constraint,
            mode: correction.mode,
            intentVersion: correction.intentVersion,
            attempt: correction.attempt,
            requestId: correction.requestId,
          });
          yield* log(
            runId,
            sent.sent
              ? `${launched.agent}: corrected about ${correction.constraint}`
              : `${launched.agent}: could not be corrected about ${correction.constraint} (${sent.why})`,
          );
          return sent.sent;
        }),
      ).pipe(Effect.orElseSucceed(() => false)),
  };
};

const receipt: (
  agent: string,
  sent: {
    readonly id?: string | undefined;
    readonly observed?: string | null;
    readonly pane?: string;
    readonly kept?: string | null;
  },
) => Steered = (agent, sent) => {
  const how = sent.observed ?? null;
  const steered: Types.Mutable<Steered> = {
    agent,
    delivered: true,
    detail: "",
    observed: how !== null,
  };
  if (how !== null) {
    steered.how = how;
  }
  if (sent.id !== undefined) {
    steered.delivery = sent.id;
  }
  if (sent.pane !== undefined) {
    steered.pane = sent.pane;
  }
  if (sent.kept !== undefined && sent.kept !== null) {
    steered.kept = sent.kept;
  }
  return steered;
};

const READING_DELIVERIES =
  "A message whose first line after its `collie-delivery:` token starts `From the human` is the human's own message, as if typed here. One starting `From chat for the human` quotes the human's own words. One from an agent is that agent's words, not the human's. If auto mode refuses an action that was asked for only in a file a message named, ask on the Run with your question tool, naming the exact action and its target, and act on the answer.";

const REGISTERING =
  "To hand a human a result they should find, collie_do artefact_register it on your Run: a path, or a url for a link, Claude artefact or Site with the provider, namespace, resource and version its tool returned. It changes neither your Output nor what proves it. Put substantial findings, investigations and recovery diagnoses in a Markdown report in your Run's handoffs directory and register it. Keep summary within 360 Unicode characters and two sentences; keep blocker and next_action short and actionable. Where your Output accepts report, return its registered installation, run, id, revision and originating step.";

const ASKING = `When you ask the human a question, end exactly one option's label with "${RECOMMENDED_MARKER}", and offer at least three options, each with its own consequence.`;

const SHELL_HABITS =
  "Never use a shell variable as a command word: write the command out. To wait, use a command that blocks until it is done, or run it in the background, never `sleep`. Search under a directory's own path, never from `/`.";

const stepPointer = (file: string) =>
  `Your task for this step is in ${file} — read it and follow it.`;

const CLEARANCE_CHARS = 400;

const clearanceProblem: (clears: ReadonlyArray<string>) => string | null = (clears) => {
  if (Arr.some(clears, (one) => /[\r\n]/.test(one))) {
    return "a Clearance is one line, and this one has a line break";
  }
  const joined = Array.from(Arr.join(clears, "; ")).length;
  return joined > CLEARANCE_CHARS
    ? `its Clearance is ${joined} characters, over the ${CLEARANCE_CHARS} a Clearance may be`
    : null;
};

const stepText = (
  adapter: { readonly skillCommand: (name: string) => string },
  ask: AgentAsk,
  file: string,
) => {
  const started = ask.skill === null ? "" : `${adapter.skillCommand(ask.skill)} `;
  const pointer = `${started}${stepPointer(file)}`;
  const clears = ask.clears ?? [];
  return clears.length === 0
    ? pointer
    : `${pointer}\nCleared for this step: ${Arr.join(clears, "; ")}.`;
};
const encodeStarted = flow(
  Schema.encodeResult(Schema.fromJsonString(StartedWith)),
  Result.getOrThrow,
);
const decodeStarted = Schema.decodeUnknownEffect(Schema.fromJsonString(StartedWith));

const RESUMED =
  "You were restarted after a stop, and this conversation was resumed. Carry on with your step from where you were; do not start it over.";

const firstLine = (text: string) => Str.split(text, "\n")[0] ?? "";

const refusedWith = (
  about: { readonly runId: string; readonly operation: string },
  what: string,
  file: string,
) =>
  new AgentParked({
    operation: about.operation,
    reason: `${what}. It is alive and what it was to be told is in ${file}; \`collie run resume ${about.runId}\` hands that to it.`,
  });

const isParked = Schema.is(AgentParked);

const isUncertain = Schema.is(AgentUncertain);
const isNotQuiet = (cause: unknown): cause is NotQuiet => Predicate.isTagged(cause, "NotQuiet");
const asUncertain: (operation: string, cause: unknown) => AgentUncertain = (operation, cause) =>
  isUncertain(cause) ? cause : new AgentUncertain({ operation, reason: herdrFailureReason(cause) });

const PERSONA_FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export const installedSkills = Effect.fn("Agents.skills")(function* (
  env: { readonly home: string; readonly cwd: string },
  names: ReadonlyArray<string>,
) {
  const found = new Map<string, string>();
  if (names.length === 0) {
    return found;
  }
  const dirs = yield* skillDirs(env);
  for (const name of names) {
    if (unsafePathComponent(name) !== null) {
      continue;
    }
    const file = yield* skillFile(dirs, name).pipe(Effect.orElseSucceed(() => null));
    if (file !== null) {
      found.set(name, file);
    }
  }
  return found;
});

interface PersonaEnv {
  readonly pluginRoot: string;
  readonly userDir: string;
  readonly home: string;
  readonly cwd: string;
}

const EVERY_AGENT = "every-agent";

export const personaText = Effect.fn("Agents.personaOf")(function* (env: PersonaEnv, role: string) {
  const dirs = Arr.map((yield* layers(env)).all, (layer) => layer.dir).reverse();
  const own = unsafePathComponent(role) === null ? yield* layeredPersona(env, role, dirs) : null;
  const every = yield* layeredPersona(env, EVERY_AGENT, dirs);
  return Arr.join(
    Arr.filter([own ?? roleBody(role), every], (part) => part !== null),
    "\n\n",
  );
});

export const everyAgentText = Effect.fn("Agents.everyAgentText")(function* (env: PersonaEnv) {
  const where = yield* layers(env);
  return yield* layeredPersona(env, EVERY_AGENT, [where.user.dir, where.baseline.dir]);
});

const layeredPersona: (
  env: PersonaEnv,
  role: string,
  dirs: ReadonlyArray<string>,
  followed?: ReadonlyArray<string>,
) => Effect.Effect<string | null, AgentParked, FileSystem.FileSystem | Path.Path> = Effect.fn(
  "Agents.layeredPersona",
)(function* (
  env: PersonaEnv,
  role: string,
  dirs: ReadonlyArray<string>,
  followed: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  for (const [at, dir] of dirs.entries()) {
    const file = `${dir}/personas/${role}.md`;
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      continue;
    }
    const markdown = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const { preamble, sections } = bodySections(
      pipe(markdown, Str.replace(PERSONA_FRONT_MATTER, "")),
    );
    if (Str.trim(preamble) === "") {
      const parent = yield* Effect.try(() => parseDocument(markdown).data.extends).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (isString(parent) && !followed.includes(file)) {
        const from = parent === role ? at + 1 : at;
        const inherited = yield* layeredPersona(env, parent, dirs.slice(from), [...followed, file]);
        if (inherited === null || sections.size === 0) {
          return inherited;
        }
        const added = Arr.map([...sections], ([name, text]) => `## ${name}\n\n${text}`);
        return `${inherited}\n\n${yield* renderedPersona(env, role, file, Arr.join(added, "\n\n"))}`;
      }
      continue;
    }
    return yield* renderedPersona(env, role, file, preamble);
  }
  return null;
});

const renderedPersona = Effect.fn("Agents.renderedPersona")(function* (
  env: PersonaEnv,
  role: string,
  file: string,
  body: string,
) {
  const unfilled = personaHoles(body);
  if (unfilled.length > 0) {
    return yield* new AgentParked({
      operation: role,
      reason: `the ${role} persona in ${file} names ${Arr.join(unfilled, ", ")}, and a persona is told nothing but {{skill:name}}: fix it, then resume this Run`,
    });
  }
  const named = yield* installedSkills(env, skillsIn(body));
  return renderTemplate(body, {}, { skill: skillMention(named) }).text;
});

const roleBody = (role: string) => `You are the ${role}.`;

const OUTPUT_REMINDERS = 2;

const reminderText: (output: string) => string = (output) =>
  `${REMINDER_OPENING} A chat message is not the Output: write ${output}, the JSON the contract described and nothing else.\nOUTPUT_PATH: ${output}`;

// WARNING: the Output goes back to the same agent, which still holds the work; restarting would throw a whole round away over a write.
export const repairText: (output: string, problem: string) => string = (output, problem) =>
  `${REPAIR_OPENING} ${problem}\n\nWrite ${output} again — the JSON the contract described, nothing else. Do not redo the work, do not explain, do not write anything outside that file. It is the only thing missing.\nOUTPUT_PATH: ${output}`;

const ledgerDeps = (host: AgentHost) => ({
  dir: host.dir,
  stateDir: host.env.stateDir,
  ports: host.ports ?? COMPACTION_PORTS,
});

const compactionDeps: (host: AgentHost, runId: string) => CompactionDeps = (host, runId) => ({
  ports: host.ports ?? COMPACTION_PORTS,
  account: (agent) => recordUsage(ledgerDeps(host), { run: runId, agent }),
  stateDir: host.env.stateDir,
  configured: host.compactAtTokens,
  herdr: host.herdr,
  log: (line) => append(`${host.dir}/agents/${runId}/agents.log`, line),
  warn: (line) => append(`${host.dir}/agents/${runId}/agents.log`, line),
  sample: (at, tokens) =>
    Effect.flatMap(nowIso, (now) =>
      noteContext(`${host.dir}/evidence/${at.run}`, now, at.agent, tokens),
    ),
  waitMs: host.compactionWaitMs ?? COMPACTION_WAIT_MS,
  pollMs: host.pollMs ?? DEFAULT_POLL_MS,
  stopMs: host.stopMs ?? STOP_WAIT_MS,
});

const undeliverable = (cause: unknown) => ({
  ok: false as const,
  id: null,
  reason: "failed" as const,
  detail: reason(cause) || Formatter.formatJson(cause),
});

// WARNING: a blank file is a write not yet happened, and null means uncertain, never that nothing happened.
const waitForOutput = <R>(
  path: string,
  unless: string | null,
  every: {
    readonly pollMs: number;
    readonly budgetMs: number;
    readonly counts: Effect.Effect<boolean, never, R>;
    readonly usable: (text: string) => boolean;
    readonly settled: Effect.Effect<boolean, never, R>;
  },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = fs.readFileString(path).pipe(Effect.orElseSucceed(() => ""));
    const fresh = (text: string) => Str.trim(text) !== "" && text !== unless;
    let spent = 0;
    for (;;) {
      const text = yield* read;
      if (fresh(text)) {
        if (every.usable(text)) {
          return text;
        }
        if (yield* every.settled) {
          const after = yield* read;
          if (fresh(after)) {
            return after;
          }
        }
      }
      if (spent >= every.budgetMs) {
        return null;
      }
      const before = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(every.pollMs));
      if (yield* every.counts) {
        spent += (yield* Clock.currentTimeMillis) - before;
      }
    }
  }).pipe(Effect.orDie);

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const write = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = Option.getOrElse(pipe(path, Str.lastIndexOf("/")), () => -1);
    if (at > 0) {
      yield* fs.makeDirectory(pipe(path, Str.slice(0, at)), { recursive: true });
    }
    yield* fs.writeFileString(path, text);
  }).pipe(Effect.orDie);

const encodeSettings = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const NO_AUTHORITY: RunAuthority = { created: null, roaming: false, started: null };

// WARNING: Claude reads every ancestor's instruction files, and a clone's @AGENTS.md import would be asked about in each new worktree, so they are excluded.
const withoutCollieInstructions: (
  overlay: ClaudeOverlay,
  cwd: string,
  given: string,
) => ClaudeOverlay = (overlay, cwd, given) => {
  const collieDir = pipe(given, Str.replace(/\/+$/, ""));
  return pipe(cwd, Str.startsWith(`${collieDir}/`))
    ? {
        ...overlay,
        claudeMdExcludes: [
          `${collieDir}/CLAUDE.md`,
          `${collieDir}/CLAUDE.local.md`,
          `${collieDir}/.claude/CLAUDE.md`,
          `${collieDir}/.claude/rules/**`,
          ...(overlay.claudeMdExcludes ?? []),
        ],
      }
    : overlay;
};

const claudeSettings = (
  controls: ReadonlyArray<string>,
  overlay: ClaudeOverlay,
  autoMode: AutoModeBlock,
  stem: string,
  quiet: Readonly<Record<string, string>>,
  policy?: ClaudeSubagents,
) =>
  Effect.gen(function* () {
    const at = controls.indexOf("--settings");
    const passed = at === -1 ? undefined : controls[at + 1];
    const path = passed ?? `${stem}.settings.json`;
    const collie =
      passed === undefined
        ? {}
        : yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.readFileString(path)),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))),
            Effect.orDie,
          );
    const skillOverrides = { ...quiet, ...overlay.skillOverrides };
    const merged = {
      ...mergeClaudeSettings(collie, overlay),
      autoMode: { ...autoMode },
    };
    if (Struct.keys(skillOverrides).length > 0) {
      Object.assign(merged, { skillOverrides });
    }
    if (policy !== undefined) {
      Object.assign(merged, subagentSettings(policy));
    }
    yield* write(path, `${encodeSettings(merged)}\n`);
    return passed === undefined ? [...controls, "--settings", path] : controls;
  });

const append = (path: string, line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = Option.getOrElse(pipe(path, Str.lastIndexOf("/")), () => -1);
    if (at > 0) {
      yield* fs.makeDirectory(pipe(path, Str.slice(0, at)), { recursive: true });
    }
    yield* fs.writeFileString(path, `${line}\n`, { flag: "a" });
  }).pipe(Effect.ignore);

export const configuredAgents = Effect.fn("Agents.configured")(function* (
  dir: string,
  readings: Effect.Effect<ReadonlyArray<UsageReading>>,
  catalogue?: Effect.Effect<MachineCatalogue>,
) {
  const env = yield* currentEnv.pipe(
    Effect.map((env) => ({ ...env, stateDir: dir })),
    Effect.orDie,
  );
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const defaults = yield* loadDefaults(env.userDir).pipe(
    Effect.orElseSucceed(() => FALLBACK_DEFAULTS),
  );
  return agentsLayer({
    dir,
    env,
    herdr: new Herdr(env),
    harness: defaults.harness,
    model: defaults.model,
    effort: defaults.effort,
    models: defaults.models,
    permissions: isPermissionMode(defaults.permissions) ? defaults.permissions : "auto",
    trust: defaults.trust,
    compactAtTokens: defaults.compactAtTokens,
    confirmGraceMs: Duration.toMillis(yield* confirmGrace),
    readings,
    catalogue,
    ownReading: (agent) =>
      ownCodexReading(env.stateDir, agent).pipe(Effect.provideContext(services)),
  });
});
