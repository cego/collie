import type { Verification, VerifyEvent } from "./verify-model";
import { Artefacts } from "./artefacts";
import { submitOutput } from "./output-submit";
import { Artefact } from "./artefact-model";

import { requestedOver } from "./review-requests";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Arr from "effect/Array";
import { branchMovement } from "./recovery";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { pipe } from "effect/Function";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- A signal handler decides a hand-over before the interrupt it races can end a check, so it reads synchronously.
import { readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket as NetSocket } from "node:net";
import { withdrawStepNote } from "./step-steering";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import type { PlatformServices } from "./platform";
import type { Exit, Scope } from "effect";
import {
  Cause,
  Clock,
  Config,
  Context,
  Data,
  Deferred,
  Ref,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  PubSub,
  Queue,
  Result,
  Path,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  Struct,
  flow as Schemaflow,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HttpClient from "effect/http/HttpClient";
import * as Socket from "effect/socket/Socket";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import manifest from "../package.json";
import { RunModel, runModelLayer } from "./run-model";
import { RunPageAsked, RunSummary, pageOf, summaryOf } from "./run-list";
import { recordsAt } from "./records";
import type { Records } from "./records";
import { RUN_RECORDS, RunRecords } from "./run-records";
import { controlOf, controlSet } from "./controls";
import { FINISHED_STEPS, recordFlow, recordFrames } from "./record";
import type { RecordSources } from "./record";
import { markFirst } from "./record-marks";
import { doorThread, engineEnd } from "./door";
import type { EngineEnd, Listed, Opened } from "./door";
import { SLOW_RPC_MS, firstValueTimed } from "./first-value";
import { TurnScheduler } from "./turns";
import {
  Foreground,
  PATIENCE,
  foregroundFileSystem,
  foregroundLayer,
  servedNow,
} from "./foreground";
import { tracingLayer } from "./tracing";
import { Host } from "./sdk";
import * as Scheduler from "effect/Scheduler";
import {
  EntryError,
  REFUSED_INPUT,
  Registrations,
  RunStatus,
  terminalStatus,
  RunView,
  Steered,
  foundationLayer,
  registryLayer,
  Registry,
  Reliance,
  runDir,
  evidenceDir,
  STOP,
  AWAITING,
  revisionOf,
} from "./engine";
import type { HostServices, KeptViews, Locate } from "./engine";
import { RequestedBy, sortBoard } from "./board-model";
import { CardRows } from "./card-rows";
import type { CardRow } from "./card-rows";
import { MERGE_REQUESTS } from "./merge-requests";
import { MODULE_REVISIONS, ModuleRevisions, onSyncedRevisions } from "./module-revisions";
import { BRANCHES, Branches, branchKey } from "./branches";
import { CONNECTIONS, ConnectionRows } from "./connection-rows";
import type { MeasureEvent } from "./measurement-model";
import {
  RunMetrics,
  RunCards,
  RunDrift,
  RunIntent,
  RunDispositions,
  RunOutputs,
  RunChecks,
  CheckEvent,
  outputsOf,
} from "./run-record";
import { REQUESTABLE } from "./outcome";
import { OutcomeRecords, outcomeRecordsOf } from "./outcomes";
import { trialRecordsOf } from "./trial";
import { TrialRecords } from "./trial-model";
import { descendantsOf, UsageEntry } from "./usage-ledger-model";
import { readUsage } from "./usage-ledger";
import { removedNotice, scrub, scrubJson } from "./redact";
import { readMetrics } from "./metrics";
import { readCards } from "./cards";
import { CheckProcesses, endAllWithin, hostCheckProcesses } from "./check-processes";
import type { CheckProcessesApi, Leftover, LeftoverEnd } from "./check-processes";
import { readDrift } from "./drift";
import {
  readIntent,
  amend,
  verificationGrant,
  updateIntent,
  propagate as propagateIntent,
} from "./intent";
import { ChangedIntent } from "./intent-model";
import { donePasses, markersOf, runningCheck, followLog } from "./checks";
import { startCheckout } from "./agent-start";
import { configuredAgents } from "./agents";
import { Collecting } from "./collecting";
import { memoryWaitOf, waitForMemory, waitLine } from "./memory-wait";
import { runLog } from "./agent-end";
import { hostLogger, rotateInPlace } from "./host-log";
import { handoffsDir, handoffsIn } from "./handoffs";
import { Catalogue, discover, searchPath } from "./discovery";
import { readDefinitions } from "./authoring";
import { SharedDefinition } from "./definitions-model";
import { DefinitionRefused, sharedDefinitions, takeDefinitions } from "./shared-definitions";
import { sideJobs } from "./side-jobs";
import { healParks, recoverParks } from "./park-recovery";
import { Notifier } from "./notify";
import { machineMemory } from "./memory";
import { Usage, usageLayer } from "./usage";
import { HarnessCatalogues, catalogueLayer } from "./catalogue";
import { connectionsOnMachine } from "./connections";
import { SLACK_BOT_RETIRED } from "./slack-credentials";
import { readConnectionLogin } from "./connection-login";
import { Schedules, schedulesLayer } from "./schedules";
import { dataHomeOf, desktopRootOf } from "./desktop";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import {
  collieCache,
  checksSweeper,
  compactionSweeper,
  desktopSweeper,
  renovateClonesSweeper,
  measurementTreesSweeper,
  buildCachesSweeper,
  retentionSweeper,
  runnersSweeper,
  settlingOf,
  stateSweeper,
  uploadsSweeper,
  tasksSweeper,
  idleAgentsSweeper,
  noteIdle,
  generationsDir,
  generationsSweeper,
  judge,
  sweepAsked,
  sweepingWith,
  worktreesSweeper,
} from "./cleanup";
import type { FinishedSince, IdleSince, SweptBy } from "./cleanup";
import { startedOf } from "./automode";
import { startedOf as processStarted } from "./processes";
import { once, readAudit, recordAudit, startedBy, trimAudit, whoActed, actorOf } from "./audit";
import { usagePhrase } from "./usage-model";
import { currentEnv, leaveLauncher, withoutHerdrOne, withoutLauncher } from "./env";
import { installation as installedRelease, RELEASE_TAG } from "./release";
import { Herdr, isSettled } from "./herdr";
import type { AgentInfo } from "./herdr";
import { taskOffers } from "./offers";
import type { Offer } from "./offers";
import { buildBoard, LANDED_STATES, ownedMrs, taskFlowOf } from "./board";
import type { KeptCard, KeptCards } from "./board";
import { mrOf, readForge, readMrStates, watchedMr } from "./merges";
import type { MrPanels } from "./merges";
import { mrIdIn, projectHere, shell } from "./mr";
import { ForgeHttp, forgeHttpLayer } from "./forge/http";
import { fetchRef, followDetail } from "./run-detail";
import { buildMachineOwn, buildRunDetail } from "./views";
import type { PlanCache } from "./views";
import {
  Answered,
  ASKED_KINDS,
  RunAgent,
  Flow,
  Controlled,
  Disposition,
  CarriedWork,
  mrIdProject,
  RunReply,
  Seen,
  FindingStatus,
  FrontDoorRpcs,
  IdentityRpc,
  HostRefused,
  StaleAct,
  NewsBatch,
  PaneAt,
  SharedSettings,
  ShellResult,
  PROTOCOL,
  readinessOfRun,
  readMrRef,
  ProposalRefused,
  PART_BYTES,
  RequestConflict,
  Started,
  SteerOutcome,
  Attachments,
} from "./board-model";
import type { RunRevision, Toasted, FrontDoor, OfferView, TaskView, Where } from "./board-model";
import {
  attachedLine,
  attachmentRefusal,
  attachmentsDir,
  copyInto,
  namesIn,
  sha256Hex,
} from "./attachments";
import type { Attached } from "./attachments";
import { boardMessages, shareBoard } from "./board-stream";
import { recordDisposition, refRuns, qualifiedRuns } from "./disposition";
import {
  findingsWithStatus,
  keepOpenCount,
  recordFindingStatus,
  storeOpenCount,
} from "./finding-status";
import { markSeenSince, readSeen, recordSeen } from "./seen";
import { readReplies } from "./replies";
import {
  NEWS_TRAIL,
  newsPath,
  newsTrail,
  pending as pendingNews,
  read as readNews,
  settle as settleNews,
} from "./news";
import { evaluationDeps } from "./evaluator";
import { ActionSchema, refusedAction } from "./actions";
import { clearOverride, err, request, steer } from "./operations";
import type { OpResult } from "./operations";
import { REJECTED } from "./envelope";
import {
  appendLine,
  DELIVERIES,
  deliveriesOf,
  overriddenRuns,
  DeliverySchema,
  herdDir,
  readLedger,
  reconcile as reconcileDelivery,
  machineHerd,
} from "./steering";
import {
  actorName,
  answeredBy,
  decline,
  journalOf,
  LineSchema as ProposalLineSchema,
  PROPOSALS,
  proposalsOf,
  read as readProposals,
  RecordSchema,
  reconcileStep,
  stepResults,
  voiceOf,
} from "./proposals";
import type { ProposalLine, ProposalRecord, Asker, Voice } from "./proposals";
import { carryOut, carryOutAsked, followUpField } from "./run-actions";
import { retitleGenericTasks } from "./tasknames";
import { VerifySpecSchema } from "./verify-spec";
import { AgentEntrySchema, everyRegistered, REGISTERED } from "./registry";
import { listTasks, readTask, TASKS, TaskSchema } from "./task";
import { epochMs, nowIso } from "./time";
import { appendLog } from "./oversight";
import { decodeVerifying, VERIFYING, verifyingOf } from "./verify";
import { reason } from "./naming";
import { editString, globFiles, grepFiles, readPart, writeWhole } from "./host-files";
import { receive, uploadsDir } from "./uploads";
import { ownInventory, readOwnWords, SESSION_STORES } from "./own-words";
import {
  configValue,
  readConfig,
  loadDefaults,
  SettingRefused,
  sharedSettings,
  takeShared,
} from "./config";
import { coreSocket } from "./hc";
import { decodeAnswer, machineName, peersOf, relayOf, runShell, startPeers } from "./peers";
import type { Peers } from "./peers";
import { RunLinkNotice, readRunLinks, recordRunLink } from "./run-links";
import type { SshMachine } from "./ssh-connection";
import { LADDER_BOUND } from "./peer-transport";
import { Invited, MachineUnreachable, Peer, PeerView, RelayHeaderJson } from "./peers-model";
import type { RelayHeader } from "./peers-model";
import { latest, readDispositions } from "./disposition";
import {
  fallbacksOf,
  Launched,
  LAUNCHES,
  launchesOf,
  operationsOf,
  readLaunches,
  runAgents,
} from "./launches";
import { factsOfView, newestFirst, settled } from "./runs";
import type { RunFacts } from "./runs";
import { Store } from "./store";
import type { Woke } from "./mr-watch-model";
import { SESSIONS_EVERY, agentsIn, focusPane, herdChanges, liveHerds } from "./herds";
import {
  currentPid,
  ensureLockDir,
  holderLives,
  hostLockOf,
  lockHolder,
  releaseOwnLock,
  signalProcess,
  withLock,
} from "./lock";
import type { LockHolder } from "./lock";
import { stringifyJson, parseJson } from "./json";

export const BUILD: string = Bun.env.COLLIE_TEST_BUILD ?? manifest.version;

export const socketOf = (dir: string) => `${dir}/host.sock`;
const lockOf = hostLockOf;
const logOf = (dir: string) => `${dir}/host.log`;
export const outputOf = (dir: string) => `${dir}/host.out`;
const recordOf = (dir: string) => `${dir}/host.build`;
const HostRecord = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    build: Schema.String,
    root: Schema.String,
    herd: Schema.optionalKey(Schema.NullOr(Schema.String)),
    // WARNING: A pid is reused; the start token is what tells this owner's record from the last one's.
    started: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const encodeRecord = Schemaflow(Schema.encodeResult(HostRecord), Result.getOrThrow);

const handOverAskedOf = (dir: string) => `${dir}/host.handover`;
const HandOverAsked = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Int, build: Schema.String }),
);
// WARNING: Written before the lock is released, so the new host finds it.
const handedOverOf = (dir: string) => `${dir}/host.handed-over`;
const HandedOverJson = Schema.fromJsonString(
  Schema.Struct({
    build: Schema.String,
    host: Schema.Struct({ pid: Schema.Finite, started: Schema.String }),
    checks: Schema.Array(Schema.String),
  }),
);

const askHandOver = (dir: string, pid: number, build: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      Schema.encodeEffect(HandOverAsked)({ pid, build }).pipe(
        Effect.flatMap((text) => fs.writeFileString(handOverAskedOf(dir), text)),
      ),
    ),
    Effect.ignore({ log: "Warn" }),
  );

const newer = (build: string, than: string) =>
  build !== than && Bun.semver.order(build, than) === 1;
const atLeast = (build: string, than: string) => build === than || newer(build, than);

export class HostUnavailable extends Data.TaggedError("HostUnavailable")<{
  readonly dir: string;
  readonly reason: string;
}> {}

export class HostVersionMismatch extends Data.TaggedError("HostVersionMismatch")<{
  readonly dir: string;
  readonly host: string;
  readonly client: string;
  readonly pid: number;
  readonly restart: string;
  readonly development?: string;
}> {}

const newerHostSaid = (dir: string, host: string, client: string) =>
  `the host for ${dir} is collie ${host}, which is newer than this client's ${client}: update this collie`;

const RunShown = Schema.Struct({
  branchProgress: Schema.optionalKey(Schema.NullOr(Schema.String)),
  view: RunView,
  agents: Schema.Array(RunAgent),
  disposition: Schema.NullOr(Disposition),
  children: Schema.Array(RunView),
  startedBy: Schema.optional(Schema.String),
  handoffs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Int })),
  ),
  replies: Schema.optionalKey(Schema.Array(RunReply)),
  memory: Schema.optionalKey(Schema.NullOr(Schema.String)),
  flow: Schema.optionalKey(Schema.NullOr(Flow)),
});

export const RunPageAnswer = Schema.Struct({
  epoch: Schema.String,
  cursor: Schema.Finite,
  runs: Schema.Array(RunSummary),
  views: Schema.NullOr(Schema.Array(RunView)),
  omitted: Schema.Int,
});

const Loaded = Schema.Struct({
  id: Schema.String,
  registration: Schema.String,
  title: Schema.String,
});

const saying =
  (removed: ReadonlyArray<string>) =>
  <A extends object>(result: A) => {
    const returned: A & { readonly redacted?: ReadonlyArray<string> } =
      removed.length === 0 ? result : { ...result, redacted: [...removed] };
    return returned;
  };

const outcomeSaying: (removed: ReadonlyArray<string>, outcome: SteerOutcome) => SteerOutcome = (
  removed,
  outcome,
) => {
  const notice = removedNotice(removed);
  return notice === null
    ? outcome
    : { ...outcome, human: `${outcome.human}\n${notice}`, redacted: [...removed] };
};

export const HostRpcs = RpcGroup.make(
  IdentityRpc,
  Rpc.make("linkNotice", {
    payload: { notice: RunLinkNotice, request: Schema.String },
    success: Schema.Boolean,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("load", {
    payload: { entry: Schema.String },
    success: Loaded,
    error: EntryError,
  }),
  Rpc.make("registrations", { success: Registrations }),
  // WARNING: Asked per project: an override is one project's, and one host serves them all.
  Rpc.make("discover", { payload: { project: Schema.String }, success: Catalogue }),
  Rpc.make("status", {
    payload: { runId: Schema.String },
    success: RunStatus,
    error: HostRefused,
  }),
  // WARNING: A run whose module is missing is still returned, with its file to repair named, not an error.
  Rpc.make("run", { payload: { runId: Schema.String }, success: Schema.NullOr(RunView) }),
  Rpc.make("runWork", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(
      Schema.Struct({ run: Schema.String, task: Schema.NullOr(Schema.String), work: CarriedWork }),
    ),
  }),
  Rpc.make("runMetrics", {
    payload: { runId: Schema.String },
    success: RunMetrics,
    error: HostRefused,
  }),
  Rpc.make("runCards", {
    payload: { runId: Schema.String },
    success: RunCards,
    error: HostRefused,
  }),
  Rpc.make("runDrift", {
    payload: { runId: Schema.String },
    success: RunDrift,
    error: HostRefused,
  }),
  Rpc.make("runIntent", {
    payload: { runId: Schema.String },
    success: RunIntent,
    error: HostRefused,
  }),
  Rpc.make("runDispositions", {
    payload: { runId: Schema.String },
    success: RunDispositions,
    error: HostRefused,
  }),
  Rpc.make("runOutcomes", {
    payload: { runId: Schema.String },
    success: OutcomeRecords,
    error: HostRefused,
  }),
  Rpc.make("runTrial", {
    payload: { runId: Schema.String },
    success: TrialRecords,
    error: HostRefused,
  }),
  Rpc.make("runUsage", {
    payload: { runId: Schema.String },
    success: Schema.Array(UsageEntry),
    error: HostRefused,
  }),
  Rpc.make("runOutputs", {
    payload: { runId: Schema.String },
    success: RunOutputs,
    error: HostRefused,
  }),
  Rpc.make("runChecks", {
    payload: { runId: Schema.String },
    success: RunChecks,
    error: HostRefused,
  }),
  Rpc.make("checkLog", {
    payload: { runId: Schema.String },
    success: CheckEvent,
    error: HostRefused,
    stream: true,
  }),
  Rpc.make("deliveries", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(Schema.Array(DeliverySchema)),
  }),
  Rpc.make("overridden", { success: Schema.Array(Schema.String) }),
  Rpc.make("tasks", { success: Schema.Array(TaskSchema) }),
  Rpc.make("proposals", {
    payload: { herd: Schema.String },
    success: Schema.Array(ProposalLineSchema),
  }),
  Rpc.make("runProposals", {
    payload: { run: Schema.String },
    success: Schema.Array(ProposalLineSchema),
  }),
  Rpc.make("proposal", { payload: { id: Schema.String }, success: Schema.NullOr(RecordSchema) }),
  Rpc.make("registered", { success: Schema.Array(AgentEntrySchema) }),
  Rpc.make("launches", { payload: { run: Schema.String }, success: Schema.Array(Launched) }),
  Rpc.make("runs", {
    payload: { task: Schema.NullOr(Schema.String) },
    success: Schema.Array(RunView),
  }),
  Rpc.make("runPage", { payload: RunPageAsked, success: RunPageAnswer }),
  Rpc.make("watch", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunView),
    stream: true,
  }),
  Rpc.make("recover", { success: Registrations }),
  Rpc.make("grant", {
    payload: {
      runId: Schema.String,
      name: Schema.String,
      command: Schema.NullOr(VerifySpecSchema.mapFields(Struct.omit(["name"]))),
      request: Schema.String,
    },
    success: Schema.Array(VerifySpecSchema),
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("steer", {
    payload: {
      runId: Schema.String,
      text: Schema.String,
      request: Schema.String,
      step: Schema.optional(Schema.String),
      to: Schema.optional(Schema.String),
      operation: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
      mode: Schema.optional(Schema.Literals(["boundary", "now", "interrupt"])),
      attachments: Schema.optional(Attachments),
    },
    success: Steered,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  Rpc.make("shown", { payload: { runId: Schema.String }, success: Schema.NullOr(RunShown) }),
  Rpc.make("invite", {
    payload: { for: Schema.String, name: Schema.String, address: Schema.NullOr(Schema.String) },
    success: Invited,
    error: HostRefused,
  }),
  Rpc.make("pair", { payload: { peer: Peer }, success: Schema.Void, error: HostRefused }),
  Rpc.make("forget", { success: Schema.Void, error: HostRefused }),
  Rpc.make("peers", { success: Schema.Array(PeerView) }),
  Rpc.make("wake", { payload: { machine: Schema.String } }),
  Rpc.make("unpair", { payload: { machine: Schema.String } }),
  Rpc.make("agentRun", {
    payload: { agent: Schema.String },
    success: Schema.NullOr(Schema.String),
  }),
);

// WARNING: A client of another build uses FrontDoorRpcs alone.
const AllRpcs = HostRpcs.merge(FrontDoorRpcs);

// WARNING: Streams are timed to their first value: they are meant to stay open.
export class SlowRpcs extends RpcMiddleware.Service<SlowRpcs>()("collie/SlowRpcs") {}

export const slowRpcsLayer = Layer.succeed(SlowRpcs)((effect, { rpc }) =>
  RpcSchema.isStreamSchema(rpc.successSchema)
    ? effect
    : Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        return yield* effect.pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const took = (yield* Clock.currentTimeMillis) - started;
              if (took > SLOW_RPC_MS) {
                yield* Effect.logWarning(`the ${rpc._tag} RPC took ${took} ms to answer`);
              }
            }),
          ),
        );
      }),
);

const serveAnswer = <A, E, R>(
  answer: Effect.Effect<A, E, R> | Stream.Stream<A, E, R>,
  name: string,
) => {
  if (Stream.isStream(answer)) {
    return Stream.transformPull(
      firstValueTimed(answer, (ms) =>
        Effect.logWarning(`the ${name} stream took ${ms} ms to send its first value`),
      ),
      (pull, scope) =>
        Effect.map(Foreground, ({ serve }) => {
          let first = true;
          return Effect.suspend(() => {
            if (!first) {
              return pull;
            }
            first = false;
            return Effect.flatMap(
              serve(
                Effect.gen(function* () {
                  const pulling = yield* Effect.forkIn(pull, scope);
                  yield* Fiber.await(pulling).pipe(Effect.timeoutOption(PATIENCE));
                  return pulling;
                }),
              ),
              Fiber.join,
            );
          });
        }),
    );
  }
  return Effect.flatMap(Foreground, ({ serve }) => serve(answer));
};

export const timingFirstValues: <
  H extends Record<string, (...args: ReadonlyArray<never>) => object>,
>(
  handlers: H,
) => H = <H extends Record<string, (...args: ReadonlyArray<never>) => object>>(handlers: H) =>
  // WARNING: each handler is replaced by one taking its arguments and answering its type.
  Rec.map(handlers, (handler, name) => (...args: ReadonlyArray<never>) => {
    const answer = handler(...args);
    return Stream.isStream(answer) || Effect.isEffect(answer) ? serveAnswer(answer, name) : answer;
  }) as H;

const HEALER_READS = new Set([
  "declare",
  "identity",
  "runDetail",
  "board",
  "toasts",
  "progress",
  "runFile",
  "artefacts",
  "artefactSearch",
  "artefactRead",
  "offers",
  "workflows",
  "definitions",
  "settings",
  "machineOwn",
  "ownInventory",
  "ownWords",
  "sharedDefinitions",
  "usage",
  "fallbacks",
  "models",
  "connections",
  "slackChoices",
  "schedules",
  "claimedInHelle",
  "read",
  "readFile",
  "glob",
  "grep",
  "verifyFollow",
  "registrations",
  "discover",
  "status",
  "run",
  "runMetrics",
  "runCards",
  "runDrift",
  "runIntent",
  "runDispositions",
  "runOutcomes",
  "runTrial",
  "runUsage",
  "runOutputs",
  "submitOutput",
  "runChecks",
  "checkLog",
  "deliveries",
  "overridden",
  "tasks",
  "proposals",
  "runProposals",
  "proposal",
  "registered",
  "launches",
  "runs",
  "runPage",
  "watch",
  "shown",
  "peers",
  "agentRun",
]);
const TargetsOne = Schema.Struct({ runId: Schema.String });
const RegistersReport = Schema.Struct({
  runId: Schema.String,
  path: Schema.String,
  role: Schema.String,
  url: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.Json),
});
const ActsOn = Schema.Struct({
  actions: Schema.Array(
    Schema.Struct({ kind: Schema.String, run: Schema.optional(Schema.String) }),
  ),
});

const healerBound =
  (declared: Declared, stateDir: string) =>
  <H extends Record<string, (...args: ReadonlyArray<never>) => object>>(handlers: H) =>
    Effect.map(
      Registry,
      (registry) =>
        // WARNING: each handler is replaced by one taking its arguments and answering its type.
        Rec.map(handlers, (handler, name) =>
          HEALER_READS.has(name)
            ? handler
            : (payload: never, options: never) => {
                const refusal = Effect.gen(function* () {
                  // WARNING: every RPC handler is called with the options carrying its client.
                  const who = stampIn(declared, (options as { client: { id: number } }).client);
                  if (who.origin !== "agent" || who.from?.run === undefined) {
                    return;
                  }
                  const heals = (yield* registry
                    .view(who.from.run)
                    .pipe(Effect.orElseSucceed(() => null)))?.heals;
                  if (heals === undefined) {
                    return;
                  }
                  if (name === "artefactRegister") {
                    const asked = Schema.decodeOption(RegistersReport)(payload);
                    if (
                      Option.isSome(asked) &&
                      asked.value.runId === who.from.run &&
                      asked.value.role === "report" &&
                      asked.value.url === undefined &&
                      asked.value.id === undefined &&
                      asked.value.provider === undefined
                    ) {
                      const fs = yield* FileSystem.FileSystem;
                      const path = yield* Path.Path;
                      const files = yield* Effect.all([
                        fs.realPath(`${runDir(stateDir, who.from.run)}/handoffs`),
                        fs.realPath(asked.value.path),
                      ]).pipe(Effect.option);
                      if (
                        Option.isSome(files) &&
                        Str.startsWith(`${files.value[0]}${path.sep}`)(files.value[1]) &&
                        Str.endsWith(".md")(Str.toLowerCase(files.value[1]))
                      ) {
                        return;
                      }
                    }
                  }
                  const targets =
                    name === "act"
                      ? Option.map(Schema.decodeOption(ActsOn)(payload), (asked) =>
                          Arr.map(asked.actions, (one) =>
                            one.kind === "deliver" || one.kind === "resume" ? one.run : undefined,
                          ),
                        )
                      : name === "steer" || name === "resume"
                        ? Option.map(Schema.decodeOption(TargetsOne)(payload), (one) => [one.runId])
                        : Option.none();
                  if (Option.isSome(targets) && Arr.every(targets.value, (run) => run === heals)) {
                    return;
                  }
                  return yield* new HostRefused({
                    reason: `${who.from.run} is a Heal of ${heals}: its agents may only deliver to ${heals}'s agents, resume it, or register Markdown reports in their own Run's handoffs`,
                  });
                });
                const answer = handler(payload, options);
                return Stream.isStream(answer)
                  ? Stream.unwrap(Effect.as(refusal, answer))
                  : // WARNING: a handler that answers no Stream answers an Effect.
                    Effect.andThen(refusal, answer as Effect.Effect<object, HostRefused>);
              },
        ) as H,
    );

export type HostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof AllRpcs>,
  RpcClientError.RpcClientError
>;

const serialization = RpcSerialization.layerNdjson;

// WARNING: One entry per connection, never removed: prune on disconnect if hosts live for months.
type Declared = Map<
  number,
  { readonly frontDoor: FrontDoor; readonly from?: Where | undefined; readonly voice?: Voice }
>;

const stampIn = (declared: Declared, client: { readonly id: number }) => {
  const channel = declared.get(client.id);
  return { origin: channel?.frontDoor ?? ("cli" as const), from: channel?.from };
};

type Development = { readonly development?: string };

const handlers = (
  dir: string,
  installation: string,
  development: Development,
  declared: Declared,
  peers: Peers,
) =>
  HostRpcs.toLayer(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const bun = yield* Effect.context<PlatformServices | Records>();
      const pid = yield* currentPid;
      const { aliveNow, boards } = yield* SharedBoard;
      const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
      const epoch =
        model?.epoch ?? `${installation}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
      const sources = yield* recordSources({ panels: null, plans: new Map() });
      const recordingLinks = yield* Semaphore.make(1);
      const env = yield* currentEnv.pipe(Effect.orDie);
      const catalogue = (project: string) =>
        onSyncedRevisions(
          discover(searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project })),
        );

      const record = <A, E, R>(runId: string, read: Effect.Effect<A, E, R>) =>
        registry.view(runId).pipe(
          Effect.flatMap((view) => {
            const returned: Effect.Effect<A, E | HostRefused, R> =
              view === null ? Effect.fail(new HostRefused({ reason: `No Run "${runId}".` })) : read;
            return returned;
          }),
          Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
        );
      return HostRpcs.of({
        linkNotice: ({ notice, request }, { client }) =>
          Effect.gen(function* () {
            const actor = stampIn(declared, client);
            const sender = actor.from?.machine;
            const peer =
              sender === undefined
                ? undefined
                : Option.getOrUndefined(
                    Arr.findFirst(
                      yield* peersOf(dir),
                      (one) => one.installation === sender.installation,
                    ),
                  );
            if (peer === undefined || sender?.installation !== notice.machine.installation) {
              return yield* new HostRefused({
                reason: "only a paired Machine can send a Run link notice",
              });
            }
            if (notice.requestedBy.machine.installation !== installation) {
              return yield* new HostRefused({
                reason: "the requesting Run belongs to another Machine",
              });
            }
            if (
              notice.narratives !== undefined &&
              Arr.some(
                notice.narratives,
                (one) =>
                  one.address !== undefined &&
                  (one.address.installation !== notice.machine.installation ||
                    one.address.run !== notice.run),
              )
            ) {
              return yield* new HostRefused({
                reason: "a Run link can report only its own registered material",
              });
            }
            const runId = notice.requestedBy.run;
            if ((yield* registry.view(runId)) === null) {
              return yield* new HostRefused({ reason: `No Run "${runId}".` });
            }
            const launch = Option.getOrUndefined(
              Arr.findLast(
                yield* readLaunches(runId),
                (one) => one.agent === notice.requestedBy.agent,
              ),
            );
            if (launch === undefined) {
              return yield* new HostRefused({
                reason: "the requesting agent was not launched by that Run",
              });
            }
            return yield* recordingLinks.withPermits(1)(
              once(
                runDir(dir, runId),
                {
                  operation: "run-link",
                  request,
                  ...actor,
                  asked: yield* Schema.encodeEffect(RunLinkNotice)(notice).pipe(Effect.orDie),
                  result: Schema.Boolean,
                },
                Effect.gen(function* () {
                  const prior = Option.getOrUndefined(
                    Arr.findFirst(
                      yield* readRunLinks(runDir(dir, runId)),
                      (one) =>
                        one.run === notice.run &&
                        one.machine.installation === notice.machine.installation,
                    ),
                  );
                  yield* recordRunLink(runDir(dir, runId), {
                    ...notice,
                    machine: { ...notice.machine, name: peer.name },
                    step: prior?.step ?? launch.step?.step ?? null,
                  }).pipe(Effect.orDie);
                  const catalogue = yield* Artefacts;
                  const parent = yield* registry.view(runId);
                  if (parent !== null) {
                    yield* catalogue.prepareReports(factsOfView(dir, parent));
                  }
                  return true;
                }),
              ),
            );
          }).pipe(Effect.provideContext(bun)),
        identity: () =>
          Effect.succeed({
            build: BUILD,
            pid,
            dir,
            root: env.pluginRoot,
            ...development,
            protocol: PROTOCOL,
            installation,
          }),
        load: ({ entry }) =>
          registry.load(entry).pipe(
            Effect.map((loaded) => ({
              id: loaded.id,
              registration: loaded.name,
              title: loaded.title,
            })),
          ),
        registrations: () => registry.registrations,
        discover: ({ project }) =>
          catalogue(project).pipe(
            Effect.map((found) => ({
              // WARNING: Without the revision: the host decides a reload itself, not the caller.
              entries: Arr.map(
                found.entries,
                ({ id, title, description, layer, path, inputs, outcome }) => ({
                  id,
                  title,
                  description,
                  layer,
                  path,
                  inputs,
                  outcome,
                }),
              ),
              problems: found.problems,
            })),
          ),
        status: ({ runId }) => registry.status(runId),
        run: ({ runId }) => registry.view(runId),
        runWork: ({ runId }) =>
          Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) {
              return null;
            }
            const ref = mrOf(factsOfView(dir, view));
            const mr = ref === null ? null : yield* mrIdIn(ref, view.cwd, shell);
            return {
              run: runId,
              task: view.task,
              work: {
                mr,
                branch: view.branch,
                repository: mr === null ? yield* projectHere(view.cwd, shell) : mrIdProject(mr),
              },
            };
          }).pipe(Effect.provideContext(bun)),
        runMetrics: ({ runId }) => record(runId, readMetrics(evidenceDir(dir, runId))),
        runCards: ({ runId }) => record(runId, readCards(runDir(dir, runId))),
        runDrift: ({ runId }) => record(runId, readDrift(runDir(dir, runId))),
        runIntent: ({ runId }) => record(runId, readIntent(runDir(dir, runId))),
        runDispositions: ({ runId }) => record(runId, readDispositions(runDir(dir, runId))),
        runOutcomes: ({ runId }) => record(runId, outcomeRecordsOf(dir, runId)),
        runTrial: ({ runId }) => record(runId, trialRecordsOf(dir, runId)),
        runUsage: ({ runId }) => record(runId, readUsage(evidenceDir(dir, runId))),
        runOutputs: ({ runId }) => record(runId, outputsOf(dir, runId)),
        runChecks: ({ runId }) =>
          Effect.gen(function* () {
            const views = yield* registry.views(null);
            const runs = Arr.map(views, (view) => factsOfView(dir, view));
            const run = Option.getOrUndefined(Arr.findFirst(runs, (one) => one.id === runId));
            if (run === undefined) {
              return yield* new HostRefused({ reason: `No Run "${runId}".` });
            }
            return {
              running: yield* runningCheck(
                run,
                runs,
                yield* markersOf(),
                yield* Clock.currentTimeMillis,
              ),
              done: yield* donePasses(run),
            };
          }),
        checkLog: ({ runId }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const views = yield* registry.views(null);
              const runs = Arr.map(views, (view) => factsOfView(dir, view));
              const run = Option.getOrUndefined(Arr.findFirst(runs, (one) => one.id === runId));
              if (run === undefined) {
                return yield* new HostRefused({ reason: `No Run "${runId}".` });
              }
              const running = yield* runningCheck(
                run,
                runs,
                yield* markersOf(),
                yield* Clock.currentTimeMillis,
              );
              if (running?.log == null) {
                return Stream.make({ _tag: "Ended" as const, check: null });
              }
              return Stream.callback<typeof CheckEvent.Type>((emit) =>
                Effect.gen(function* () {
                  yield* Queue.offer(emit, { _tag: "Output", text: `${running.sentence}\n` });
                  const ended = yield* followLog(run, running.log!, (text) =>
                    Queue.offer(emit, { _tag: "Output", text }).pipe(Effect.orDie),
                  );
                  yield* Queue.offer(emit, { _tag: "Ended", check: ended });
                  yield* Queue.end(emit);
                }).pipe(Effect.provideContext(bun)),
              );
            }),
          ),
        deliveries: ({ runId }) =>
          Effect.gen(function* () {
            if ((yield* registry.view(runId)) === null) {
              return null;
            }
            return yield* deliveriesOf(runId);
          }),
        overridden: () => Effect.map(overriddenRuns, (runs) => [...runs]),
        tasks: () => listTasks,
        registered: () => everyRegistered,
        launches: ({ run }) => readLaunches(run),
        proposals: ({ herd }) => readProposals(herd),
        runProposals: ({ run }) => proposalsOf(run),
        proposal: ({ id }) =>
          journalOf(id).pipe(
            Effect.flatMap((journal) =>
              journal === null ? Effect.succeed([]) : readProposals(journal),
            ),
            Effect.map(
              (lines) =>
                Option.getOrUndefined(
                  Arr.findFirst(
                    lines,
                    (line): line is ProposalRecord => line.kind === "proposal" && line.id === id,
                  ),
                ) ?? null,
            ),
          ),
        runs: ({ task }) => registry.views(task),
        runPage: (asked) =>
          Effect.gen(function* () {
            const built = yield* Stream.runHead(boards);
            const all = Option.match(built, { onNone: () => [], onSome: (one) => one.runs });
            const cards = Option.match(built, { onNone: () => [], onSome: (one) => one.views });
            const ids = Arr.map(all, (run) => run.id);
            const { page, omitted } = pageOf(
              Arr.map(
                Arr.filter(all, (run) => asked.task === null || run.task === asked.task),
                (facts) => ({ facts, revision: model?.inputsAt([facts.id]) ?? 0 }),
              ),
              // WARNING: With no Run model nothing says what moved, so every Run is marked as moved.
              model === undefined ? { ...asked, since: null } : asked,
            );
            const cardOf = (run: string) =>
              Option.getOrUndefined(Arr.findFirst(cards, (card) => card.runs.includes(run)));
            // WARNING: a listing asks git nothing; it reads the git syncer's rows.
            const branches = yield* Branches.use((rows) => rows.all).pipe(
              Effect.provideContext(bun),
            );
            const runs = Arr.map(page, ({ facts }) =>
              summaryOf(
                facts,
                cardOf(facts.id),
                facts.branch === null
                  ? null
                  : (branches.get(branchKey(facts.cwd, facts.branch))?.head ?? null),
              ),
            );
            const views = asked.full
              ? yield* Effect.map(registry.views(asked.task), (every) => {
                  const byId = new Map(Arr.map(every, (view) => [view.runId, view]));
                  return Arr.flatMap(page, ({ facts }) => {
                    const view = byId.get(facts.id);
                    return view === undefined ? [] : [view];
                  });
                })
              : null;
            return { epoch, cursor: model?.inputsAt(ids) ?? 0, runs, views, omitted };
          }),
        watch: ({ runId }) => registry.watch(runId),
        recover: () => registry.recover,
        shown: ({ runId }) =>
          Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) {
              return null;
            }
            const all = yield* registry.views(null);
            const hosted = yield* Effect.context<HostServices>();
            return {
              view,
              branchProgress: yield* branchMovement({
                cwd: view.cwd,
                dir: runDir(dir, runId),
                branch: view.branch,
                state: view.status.status === "complete" ? "succeeded" : view.status.status,
              }),
              agents: yield* runAgents(runId),
              disposition: latest(
                yield* readDispositions(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
              ),
              children: Arr.filter(all, (one) => one.parent === runId),
              startedBy: startedBy(
                yield* readAudit(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
                { id: runId, parent: view.parent },
              ),
              handoffs: Arr.map(yield* handoffsIn(runDir(dir, runId)), (file) => ({
                path: `${handoffsDir(runDir(dir, runId))}/${file.name}`,
                bytes: file.bytes,
              })),
              replies: yield* readReplies(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
              memory: yield* Effect.map(memoryWaitOf(runId), (wait) =>
                wait === null ? null : waitLine(wait),
              ),
              flow:
                sources !== undefined
                  ? yield* recordFlow({ ...sources, alive: aliveNow }, runId).pipe(
                      Effect.orElseSucceed(() => null),
                    )
                  : yield* taskFlowOf(
                      {
                        env,
                        runs: Arr.map(all, (one) => factsOfView(env.stateDir, one)),
                        alive: yield* aliveNow,
                        offers: (id) =>
                          registry.offers(id).pipe(
                            Effect.provideContext(hosted),
                            Effect.orElseSucceed(() => []),
                          ),
                      },
                      runId,
                    ).pipe(Effect.orElseSucceed(() => null)),
            };
          }).pipe(Effect.provideContext(bun)),
        invite: (asked) =>
          peers.invite({ installation: asked.for, name: asked.name, address: asked.address }),
        pair: ({ peer }) => peers.add(peer),
        forget: (_, { client }) => {
          const machine = stampIn(declared, client).from?.machine;
          return machine === undefined
            ? Effect.fail(new HostRefused({ reason: "only a paired Machine's link can forget it" }))
            : peers.forget(machine.installation);
        },
        peers: () => peers.list,
        wake: ({ machine }) => peers.wake(machine),
        unpair: ({ machine }) => peers.unpair(machine),
        agentRun: ({ agent }) =>
          everyRegistered.pipe(
            Effect.map(
              (entries) =>
                Option.getOrUndefined(Arr.findLast(entries, (entry) => entry.agent === agent))
                  ?.runId ?? null,
            ),
            Effect.orElseSucceed(() => null),
            Effect.provideContext(bun),
          ),
        grant: ({ runId, name, command, request }, { client }) =>
          once(
            runDir(dir, runId),
            {
              operation: "grant",
              request,
              ...stampIn(declared, client),
              asked: { name, command: fromText(toText(command)) },
              result: Schema.Array(VerifySpecSchema),
            },
            registry.grant({ runId, name, command }),
          ).pipe(Effect.provideContext(bun)),
        steer: (
          { runId, text: given, request, to, operation, agent, mode, attachments, step },
          { client },
        ) => {
          const { text, removed } = scrub(given);
          const into = attachmentsDir(runDir(dir, runId));
          const actor = { ...stampIn(declared, client), ...declared.get(client.id)?.voice };
          const known =
            (attachments ?? []).length === 0
              ? Str.trim(text) === ""
                ? Effect.fail(
                    new HostRefused({
                      reason: "The message is empty, so there is nothing to send.",
                    }),
                  )
                : Effect.void
              : Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(runDir(dir, runId))).pipe(
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((exists) =>
                    exists && !/[/\\]/.test(runId) && runId !== ".." && runId !== "."
                      ? Effect.void
                      : Effect.fail(new HostRefused({ reason: `There is no Run ${runId} here.` })),
                  ),
                );
          return known.pipe(
            Effect.andThen(attachedAs(into, attachments)),
            Effect.flatMap((attached) => {
              const asked: SteerAsked = {
                text,
                operation: operation ?? null,
                agent: agent ?? null,
                mode: mode ?? null,
              };
              if (attached !== undefined) {
                asked.attachments = attached;
              }
              // WARNING: Set only where given, so a request recorded before `to` existed still matches.
              if (to !== undefined) {
                asked.to = to;
              }
              if (step !== undefined) {
                asked.step = step;
              }
              return once(
                runDir(dir, runId),
                {
                  operation: "deliver",
                  request,
                  ...stampIn(declared, client),
                  asked,
                  result: Steered,
                },
                copyInto(into, attachments ?? []).pipe(
                  Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
                  Effect.map((copied) =>
                    Arr.join(
                      Arr.filter(
                        [text, ...Arr.map(copied, (one) => attachedLine(`${into}/${one.name}`))],
                        (line) => line !== "",
                      ),
                      "\n",
                    ),
                  ),
                  Effect.flatMap((told) =>
                    registry.steer({
                      runId,
                      text: told,
                      request,
                      to,
                      operation,
                      agent,
                      mode,
                      actor,
                      step,
                    }),
                  ),
                  Effect.map(saying(removed)),
                ),
              );
            }),
            Effect.provideContext(bun),
          );
        },
      });
    }).pipe(Effect.map(timingFirstValues), Effect.flatMap(healerBound(declared, dir))),
  );

type SteerAsked = {
  step?: string;
  readonly text: string;
  to?: string;
  readonly operation: string | null;
  readonly agent: string | null;
  readonly mode: string | null;
  attachments?: ReadonlyArray<Attached>;
};

const attachedAs = (into: string | null, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (paths === undefined || paths.length === 0) {
      return undefined;
    }
    const refused = yield* attachmentRefusal(paths);
    if (refused !== null) {
      return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${refused}` });
    }
    return Arr.map(yield* namesIn(into, paths), ({ name, from }) => ({ name, from }));
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
    ),
  );

// WARNING: Told to the caller but not kept as its request's answer.
class SteerUnanswered extends Schema.TaggedError<
  SteerUnanswered,
  { readonly brand: unique symbol }
>()("SteerUnanswered", {
  outcome: SteerOutcome,
}) {}

const ACTED_KINDS = new Set<string>([...ASKED_KINDS, "hold"]);
const ACT_REVISIONS_KEPT = 1024;

const outcomeOf: (result: OpResult) => SteerOutcome = (result) =>
  result.ok
    ? { ok: true, code: null, human: result.human, data: fromText(toText(result.data)) }
    : {
        ok: false,
        code: result.error.code,
        human: result.error.message,
        data: fromText(toText(result.error.details ?? {})),
      };

// WARNING: Through JSON text: an undefined field is dropped rather than refused.
const toText = Schemaflow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const fromText = Schemaflow(
  Schema.decodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

// WARNING: Built again with nothing written, so 'silent for' stays true.
const boardTick = Config.Duration("COLLIE_BOARD_TICK").pipe(
  Config.withDefault(Duration.seconds(5)),
  Effect.orDie,
);

const servingEnv = (dir: string) =>
  currentEnv.pipe(
    Effect.orDie,
    Effect.map((env) => ({ ...env, stateDir: dir })),
  );

interface BoardSource<E, F> {
  readonly runs: Effect.Effect<ReadonlyArray<RunFacts>, E>;
  readonly views: (
    herds: Effect.Success<ReturnType<typeof liveHerds>>,
  ) => Effect.Effect<ReadonlyArray<TaskView>, F>;
}

const hostBoard = (dir: string) =>
  Effect.gen(function* () {
    const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
    const registry = yield* Registry;
    const store = yield* Store;
    const checks = yield* CheckProcesses;
    const bun = yield* Effect.context<PlatformServices | Records>();
    const hosted = yield* Effect.context<HostServices>();
    const env = yield* servingEnv(dir);
    const herdr = new Herdr(env);
    // WARNING: Read no more often than herdChanges: each read is a herdr process.
    const herdsNow = yield* Effect.cachedWithTTL(liveHerds(herdr, env), SESSIONS_EVERY);
    // WARNING: A write moves no agent: herdr is read again only after herdrMoved.
    const [agentsCached, herdrMoved] = yield* Effect.cachedInvalidateWithTTL(
      Effect.flatMap(herdsNow, agentsIn),
      Duration.infinity,
    );
    let agentsRead: Effect.Success<typeof agentsCached> | undefined;
    // WARNING: Told synchronously, so a record opened after aliveNow draws it.
    const agentsSeen = new Set<(alive: ReadonlyArray<AgentInfo>) => void>();
    const agentsNow = Effect.map(agentsCached, (agents) => {
      if (agents !== agentsRead) {
        for (const told of agentsSeen) {
          told(agents.alive);
        }
      }
      return (agentsRead = agents);
    });
    const agentsLast = Effect.suspend(() =>
      agentsRead === undefined ? agentsNow : Effect.succeed(agentsRead),
    );
    const kept: KeptViews | undefined =
      model === undefined ? undefined : { revision: model.factsAt, views: new Map() };
    const facts = new WeakMap<RunView, RunFacts>();
    // WARNING: The same object for as long as the view is: callers key on its identity.
    const factsOf = (view: RunView) => {
      const known = facts.get(view);
      if (known !== undefined) {
        return known;
      }
      const made = factsOfView(env.stateDir, view);
      facts.set(view, made);
      return made;
    };
    const runs = registry.views(null, model?.reading, kept).pipe(Effect.map(Arr.map(factsOf)));
    const idle: IdleSince = new Map();
    const finishedSince: FinishedSince = new Map();
    const cards: KeptCards | undefined =
      model === undefined
        ? undefined
        : { revision: model.inputsAt, content: model.content, kept: new Map() };
    // WARNING: the previous host's cards stand until the first pass, unconfirmed until it finds their sources unmoved.
    const rows = cards === undefined ? [] : yield* CardRows.use((rows) => rows.all);
    const seeded = new Map<string, TaskView | null>();
    for (const row of rows) {
      seeded.set(row.task, row.view);
      cards?.kept.set(row.task, {
        key: "",
        digest: row.digest,
        due: row.due,
        view: row.view,
        unconfirmed: true,
      });
    }
    // WARNING: none left is no board to show; the first pass's board is the first.
    let projected: ReadonlyArray<TaskView> | null =
      cards === undefined || rows.length === 0
        ? null
        : sortBoard(
            Arr.flatMap(rows, (row) =>
              row.view === null ? [] : [{ ...row.view, confirmed: false, asOf: row.at }],
            ),
          );
    // WARNING: kept so a pass writes only the cards that moved.
    const written = new Map<string, { readonly view: TaskView | null; readonly kept: KeptCard }>(
      Arr.flatMap(rows, (row) => {
        const kept = cards?.kept.get(row.task);
        return kept === undefined ? [] : [[row.task, { view: row.view, kept }] as const];
      }),
    );
    const project = (views: ReadonlyArray<TaskView>) =>
      Effect.gen(function* () {
        if (cards === undefined) {
          return;
        }
        const at = yield* Clock.currentTimeMillis;
        const shown = new Map(Arr.map(views, (view) => [view.id, view] as const));
        const put: Array<CardRow> = [];
        for (const [task, kept] of cards.kept) {
          if (kept.unconfirmed === true) {
            continue;
          }
          const view = kept.view === null ? null : (shown.get(task) ?? null);
          const was = written.get(task);
          if (
            was !== undefined &&
            was.view === view &&
            was.kept.digest === kept.digest &&
            was.kept.due === kept.due
          ) {
            continue;
          }
          written.set(task, { view, kept });
          put.push({ task, view, digest: kept.digest, due: kept.due, at });
        }
        const drop = Arr.filter([...written.keys()], (task) => !cards.kept.has(task));
        for (const task of drop) {
          written.delete(task);
        }
        yield* CardRows.use((rows) => rows.write(put, drop));
      }).pipe(
        Effect.provideContext(bun),
        Effect.catchCause((cause) =>
          Effect.logWarning("the board's cards were not written", cause),
        ),
      );
    const offered = new Map<string, ReadonlyArray<OfferView>>();
    const boardOf = (facts: ReadonlyArray<RunFacts>, alive: ReadonlyArray<AgentInfo>) =>
      Effect.gen(function* () {
        if (cards !== undefined) {
          cards.modules = Arr.join(
            Arr.map(
              [...(yield* ModuleRevisions.use((rows) => rows.all))].sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
              ([dir, revision]) => `${dir}@${revision}`,
            ),
            "\n",
          );
          cards.connections = yield* ConnectionRows.use((rows) => rows.readings);
        }
        const refused = yield* hostRefuses;
        return yield* buildBoard({
          env,
          runs: facts,
          alive,
          collecting: new Set(yield* checks.collecting),
          quietMs: (yield* loadDefaults(env.userDir)).boardQuietMs,
          offers: (runId) =>
            registry.offers(runId).pipe(
              Effect.provideContext(hosted),
              Effect.orElseSucceed(() => []),
              Effect.tap((offers) => Effect.sync(() => offered.set(runId, offers))),
            ),
          cards,
        }).pipe((built) => (refused ? refusingOutside(built) : built));
      }).pipe(
        (built) =>
          model === undefined
            ? built
            : Effect.provideService(built, FileSystem.FileSystem, model.reading),
        Effect.provideContext(bun),
      );
    const statuses = new Map<string, string>();
    // WARNING: what an agent writes is read when its turn starts or ends, never watched.
    const turned = (alive: ReadonlyArray<AgentInfo>) =>
      Effect.gen(function* () {
        if (model === undefined) {
          return;
        }
        const moved = new Set<string>();
        const present = new Set<string>();
        for (const agent of alive) {
          present.add(agent.name);
          if (statuses.get(agent.name) !== agent.status) {
            moved.add(agent.name);
          }
          statuses.set(agent.name, agent.status);
        }
        for (const name of Arr.fromIterable(statuses.keys())) {
          if (!present.has(name)) {
            moved.add(name);
            statuses.delete(name);
          }
        }
        if (moved.size === 0) {
          return;
        }
        const runs = new Set(
          Arr.flatMap(yield* everyRegistered.pipe(Effect.provideContext(bun)), (entry) =>
            moved.has(entry.agent) ? [entry.runId] : [],
          ),
        );
        for (const run of runs) {
          for (const under of ["runs", "agents", "evidence"]) {
            yield* model.invalidate(`${env.stateDir}/${under}/${run}`);
          }
        }
        for (const name of moved) {
          yield* model.invalidate(`${env.stateDir}/compaction/${name}`);
        }
      });
    const listingOf = (agents: typeof agentsNow) =>
      Effect.gen(function* () {
        const { alive } = yield* agents.pipe(Effect.provideContext(bun));
        yield* turned(alive);
        noteIdle(idle, alive, yield* Clock.currentTimeMillis);
        const facts = yield* runs;
        // WARNING: Observed before the build, so each card's key holds the revisions as read.
        if (model !== undefined) {
          yield* model.observe(facts);
        }
        const views = yield* boardOf(facts, alive);
        return { runs: facts, views, alive };
      });
    let filled = false;
    const listing = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const built = yield* listingOf(agentsNow);
      if (model === undefined) {
        return built;
      }
      const views = model.stamp(built.views);
      yield* project(views);
      if (!filled) {
        filled = true;
        projected = null;
        const took = (yield* Clock.currentTimeMillis) - started;
        let confirmed = 0;
        for (const [task, view] of seeded) {
          if (cards?.kept.get(task)?.view === view) {
            confirmed++;
          }
        }
        seeded.clear();
        yield* Effect.logInfo(
          `the Run model holds ${built.runs.length} Runs, filled in ${took} ms; ${confirmed} of ${rows.length} cards the last host left were confirmed unchanged`,
        );
      }
      return { ...built, views };
    });
    const aliveOf = (agents: typeof agentsNow) =>
      Effect.map(agents, ({ alive }) => alive).pipe(Effect.provideContext(bun));
    const seen = new Map<string, number>();
    const storage = yield* Effect.context<MessageStorage.MessageStorage>();
    // WARNING: Fresh sessions, not the board's cached ones: a session opened since would look gone.
    const sweepersOver = <E, F>(board: BoardSource<E, F>) =>
      Effect.gen(function* () {
        const herds = yield* liveHerds(herdr, env);
        const sessions = Arr.map(herds, (session) => session.herdr);
        const all = yield* board.runs;
        const tasks = yield* listTasks;
        const views = yield* board.views(herds).pipe(Effect.option);
        return [
          // WARNING: Before the worktrees: a checkout goes only once its Task has closed.
          tasksSweeper({
            tasks,
            // WARNING: With no board, no Task is judged Finished, so nothing closes.
            views: Option.getOrElse(views, () => []),
            seen,
          }),
          idleAgentsSweeper({
            stateDir: env.stateDir,
            sessions: herds,
            runs: all,
            idle,
            finishedSince,
            // WARNING: A config that cannot be read closes nothing.
            idleCloseMs: yield* loadDefaults(env.userDir).pipe(
              Effect.map((defaults) => defaults.idleCloseMs),
              Effect.orElseSucceed(() => 0),
            ),
          }),
          worktreesSweeper({
            herdr,
            stateDir: env.stateDir,
            runs: all,
            registered: yield* everyRegistered,
            cwd: env.cwd,
            settling: settlingOf({
              stateDir: env.stateDir,
              runs: all,
              views: Option.getOrNull(views),
              tasks,
              protect: [env.pluginRoot],
            }),
          }),
          generationsSweeper(generationsDir()),
          stateSweeper(env.stateDir, new Set(Arr.map(all, (run) => run.id))),
          uploadsSweeper(env.stateDir),
          compactionSweeper(env.stateDir, sessions),
          runnersSweeper(`${collieCache()}/runners`, BUILD),
          checksSweeper(checks),
          renovateClonesSweeper(env.stateDir, all),
          measurementTreesSweeper(env.stateDir, all),
          buildCachesSweeper(board.runs.pipe(Effect.orElseSucceed(() => []))),
          desktopSweeper(
            desktopRootOf(dataHomeOf(env.home, env.raw["XDG_DATA_HOME"])),
            `${env.raw["XDG_STATE_HOME"] || `${env.home}/.local/state`}/collie-desktop`,
            process.platform === "darwin"
              ? `${env.home}/Applications/collie-desktop.app/Contents/Resources/version.json`
              : `${desktopRootOf(dataHomeOf(env.home, env.raw["XDG_DATA_HOME"]))}/app/Resources/version.json`,
          ),
          // WARNING: Last: a Task is kept while its workspace or checkout remains.
          retentionSweeper({
            stateDir: env.stateDir,
            sessions,
            // WARNING: All reads or none: a Task judged without its Runs would look forgettable.
            facts: Effect.all({
              tasks: listTasks,
              views: board.views(herds),
              runs: board.runs,
            }).pipe(
              Effect.orElseSucceed(() => ({ tasks: [], views: [], runs: [] })),
              Effect.provideContext(bun),
            ),
            retire: (ids) => registry.retire(ids).pipe(Effect.provideContext(storage)),
          }),
        ];
      }).pipe(
        Effect.map((list) =>
          model === undefined ? list : Arr.map(list, sweepingWith(model.reading)),
        ),
      );
    const sweepers = sweepersOver({
      runs,
      views: (herds) => Effect.map(listingOf(agentsIn(herds)), (built) => built.views),
    });
    const stop = (runId: string, reason: string) =>
      once(
        runDir(env.stateDir, runId),
        {
          operation: STOP,
          request: `merged-${runId}`,
          origin: "host",
          reason,
          asked: { reason },
          result: Controlled,
        },
        registry.control({ runId, control: STOP, set: true, alone: true, reason }),
      ).pipe(
        Effect.provideContext(hosted),
        Effect.provideContext(bun),
        Effect.catchCause((cause) => Effect.logWarning(`could not stop ${runId}`, cause)),
      );
    return {
      env,
      herdr,
      bun,
      listing,
      projected: () => projected,
      // WARNING: read on the forge syncer's next round, however recently it last read them.
      nudged: new Set<string>(),
      recover: (runId: string) => registry.syncRecovery(runId).pipe(Effect.provideContext(hosted)),
      runs,
      kept,
      factsOf,
      offered,
      herdrMoved,
      agentsSeen,
      alive: aliveOf(agentsLast),
      aliveNow: aliveOf(Effect.andThen(herdrMoved, agentsNow)),
      sweepers,
      sweepersOver,
      record: registry.mergeRequest,
      stop,
      watches: {
        list: store.watches,
        observe: store.observe,
        unavailable: (run: string, why: string) =>
          Effect.flatMap(Host, (host) => host.parked(run, why, "forge-unavailable")).pipe(
            Effect.provideContext(hosted),
          ),
        wake: (run: string, name: string, woke: Woke) =>
          registry.wake(run, name, woke).pipe(Effect.provideContext(hosted)),
      },
      requested: requestedOver(
        (suffix) => Effect.map(store.requestedEnding(suffix), (row) => row !== null),
        registry,
        env,
        hosted,
      ),
    };
  });

class SharedBoard extends Context.Service<
  SharedBoard,
  Omit<Effect.Success<ReturnType<typeof hostBoard>>, "listing" | "herdrMoved"> & {
    readonly changed: Stream.Stream<void>;
    readonly writes: Stream.Stream<void>;
    readonly boards: Stream.Stream<{
      readonly runs: ReadonlyArray<RunFacts>;
      readonly views: ReadonlyArray<TaskView>;
      readonly alive: ReadonlyArray<AgentInfo>;
    }>;
    readonly listed: Effect.Success<ReturnType<typeof hostBoard>>["sweepers"];
  }
>()("collie/SharedBoard") {}

export const boardTableWrites = Stream.unwrap(
  Effect.map(Reactivity.Reactivity, (reactivity) =>
    reactivity.stream(
      [
        DELIVERIES,
        LAUNCHES,
        PROPOSALS,
        REGISTERED,
        TASKS,
        RUN_RECORDS,
        MERGE_REQUESTS,
        MODULE_REVISIONS,
        BRANCHES,
        CONNECTIONS,
      ],
      Effect.void,
    ),
  ),
);

const sharedBoardLayer = (dir: string) =>
  Layer.effect(SharedBoard)(
    Effect.gen(function* () {
      const store = yield* Store;
      const reactivity = yield* Reactivity.Reactivity;
      const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
      const { listing, herdrMoved, ...board } = yield* hostBoard(dir);
      // WARNING: nothing is watched; debounced apart from the tick so a burst of writes cannot hold the board back.
      const writes = yield* Stream.mergeAll(
        [
          (model?.changed ?? Stream.empty).pipe(
            Stream.debounce("200 millis"),
            Stream.map(() => undefined),
          ),
          herdChanges(board.herdr).pipe(
            Stream.provideContext(board.bun),
            Stream.catch(() => Stream.empty),
            Stream.tap(() => herdrMoved),
          ),
          store.watching(Effect.void),
          boardTableWrites.pipe(Stream.provideService(Reactivity.Reactivity, reactivity)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.share({ capacity: 1, strategy: "sliding" }));
      const refresh = yield* Stream.tick(yield* boardTick).pipe(
        Stream.tap(() => herdrMoved),
        Stream.share({ capacity: 1, strategy: "sliding" }),
      );
      const changed = Stream.merge(writes, refresh);
      const { boards, latest } = yield* shareBoard({
        build: listing,
        changed: writes,
        refresh,
      });
      const listed = board.sweepersOver({
        runs: Effect.map(latest, (built) => built.runs),
        views: () => Effect.map(latest, (built) => built.views),
      });
      return { ...board, changed, writes, boards, listed };
    }),
  );

const targetOf = Schema.decodeUnknownOption(
  Schema.Struct({
    run: Schema.String,
    step: Schema.optional(Schema.String),
    before: Schema.optional(Schema.String),
  }),
);

const recordSources = (opts: { readonly panels: MrPanels | null; readonly plans: PlanCache }) =>
  Effect.gen(function* () {
    const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
    if (model === undefined) {
      return undefined;
    }
    const registry = yield* Registry;
    const hosted = yield* Effect.context<HostServices>();
    const { env, bun, alive, kept, factsOf } = yield* SharedBoard;
    const forgeHttp = Option.getOrUndefined(yield* Effect.serviceOption(ForgeHttp));
    const { panels } = opts;
    return {
      env,
      model,
      plans: opts.plans,
      alive,
      related: (runId, also) =>
        registry.related(runId, also, model.reading, kept).pipe(Effect.map(Arr.map(factsOf))),
      offers: (id) =>
        registry.offers(id).pipe(
          Effect.provideContext(hosted),
          Effect.orElseSucceed(() => []),
        ),
      mr: (run, fresh) => {
        const target = mrOf(run);
        if (panels === null || forgeHttp === undefined || target === null) {
          return Effect.succeed(null);
        }
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            watchedMr({
              stateDir: env.stateDir,
              panels,
              target,
              cwd: env.cwd,
              run: shell,
              now,
              fresh,
            }),
          ),
          Effect.provideContext(bun),
          Effect.provideService(ForgeHttp, forgeHttp),
        );
      },
    } satisfies RecordSources;
  });

const doorFeedLayer = (door: EngineEnd, panels: MrPanels) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
      const record = yield* recordSources({ panels, plans: new Map() });
      if (model === undefined || record === undefined) {
        return;
      }
      door.attach(model);
      yield* door.warmed.pipe(
        Effect.flatMap(({ runs, ms }) =>
          Effect.logInfo(`the door has read ${runs} records to warm it, in ${ms} ms`),
        ),
        Effect.forkScoped,
      );
      const branches = yield* Branches;
      yield* Queue.take(door.wants).pipe(
        Effect.flatMap(branches.want),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Queue.take(door.slow).pipe(
        Effect.flatMap(({ rpc, ms }) =>
          Effect.logWarning(`the door's ${rpc} stream took ${ms} ms to send its first value`),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      const { boards, kept, factsOf, offered, bun, agentsSeen, alive } = yield* SharedBoard;
      const agents = (alive: ReadonlyArray<AgentInfo>) =>
        door.post({ _tag: "Listed", runs: [], gone: [], order: null, alive, offers: [] });
      yield* Effect.acquireRelease(
        Effect.sync(() => agentsSeen.add(agents)),
        () => Effect.sync(() => agentsSeen.delete(agents)),
      );
      yield* alive.pipe(Effect.map(agents), Effect.forkScoped);
      const registry = yield* Registry;
      const readAt = (run: RunFacts) => {
        const held = kept?.views.get(run.id);
        return held !== undefined && factsOf(held.view) === run ? held.revision : null;
      };
      const listed = (runs: ReadonlyArray<RunFacts>) =>
        Arr.map(runs, (fact) => {
          const returned: Listed = { fact, seq: readAt(fact) };
          return returned;
        });
      const posted = new Map<string, RunFacts>();
      let order: ReadonlyArray<string> = [];
      yield* Effect.forkScoped(
        Stream.runForEach(boards, ({ runs }) =>
          Effect.sync(() => {
            const ids = Arr.map(runs, (run) => run.id);
            const present = new Set(ids);
            const gone = Arr.filter([...posted.keys()], (id) => !present.has(id));
            const moved =
              ids.length !== order.length || Arr.some(ids, (id, at) => order[at] !== id);
            const fresh = listed(Arr.filter(runs, (run) => posted.get(run.id) !== run));
            for (const id of gone) {
              posted.delete(id);
            }
            for (const run of runs) {
              posted.set(run.id, run);
            }
            if (moved) {
              order = ids;
            }
            const offers = [...offered];
            offered.clear();
            door.post({
              _tag: "Listed",
              runs: fresh,
              gone,
              order: moved ? ids : null,
              offers,
            });
          }),
        ),
      );
      const answer = (ask: number, value: Effect.Effect<unknown>) =>
        value.pipe(
          Effect.flatMap((found) =>
            Effect.sync(() => door.post({ _tag: "Answer", ask, value: found })),
          ),
          Effect.forkScoped,
        );
      yield* Queue.take(door.asks).pipe(
        Effect.flatMap(({ ask, asked }) => {
          switch (asked._tag) {
            case "Mr":
              return answer(ask, record.mr(asked.run, asked.fresh));
            case "Offers":
              return answer(ask, record.offers(asked.runId));
            case "Related":
              return answer(
                ask,
                registry
                  .related(asked.runId, asked.also, model.reading, kept)
                  .pipe(
                    Effect.map(Arr.map(factsOf)),
                    Effect.tap(model.note),
                    Effect.map(listed),
                    Effect.provideContext(bun),
                  ),
              );
          }
        }),
        Effect.forever,
        Effect.forkScoped,
      );
    }),
  );

const sideJobsLayer = (panels: MrPanels) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const {
        env,
        herdr,
        bun,
        boards,
        sweepers,
        record,
        stop,
        watches,
        requested,
        nudged,
        recover,
      } = yield* SharedBoard;
      const board = Stream.runHead(boards).pipe(
        Effect.flatMap((latest) =>
          latest._tag === "Some" ? Effect.succeed(latest.value) : Effect.never,
        ),
      );
      const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
      yield* Effect.forkScoped(
        sideJobs({
          env,
          herdr,
          board,
          panels,
          record,
          stop,
          watches,
          requested,
          sweepers,
          nudged,
          recover,
        }).pipe(
          (jobs) =>
            model === undefined
              ? jobs
              : Effect.provideService(jobs, FileSystem.FileSystem, model.reading),
          Effect.provideContext(bun),
        ),
      );
      yield* Effect.forkScoped(
        board.pipe(
          Effect.flatMap(({ runs }) => retitleGenericTasks(runs)),
          Effect.provideContext(bun),
          Effect.ignore({ log: "Warn" }),
        ),
      );
    }),
  );

const questionsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { changed } = yield* SharedBoard;
    const registry = yield* Registry;
    const hosted = yield* Effect.context<HostServices>();
    yield* Effect.forkScoped(
      changed.pipe(
        Stream.runForEach(() => registry.tendQuestions.pipe(Effect.provideContext(hosted))),
      ),
    );
  }),
);

const CLEANUP_TRAIL = 50;

const SETTINGS_TRAIL = 50;
const HELLE_TRAIL = 200;
const DEFINITIONS_TRAIL = 50;
const USAGE_TRAIL = 200;
const FILES_TRAIL = 1000;
const UPLOADS_TRAIL = 1000;
const Written = Schema.Struct({ path: Schema.String, bytes: Schema.Int });
const Edited = Schema.Struct({ path: Schema.String, replaced: Schema.Int });

// WARNING: A Herd's key names one directory under the state directory, never above it.
const isHerdName = (herd: string) => herd !== "." && herd !== ".." && /^[^/\\]+$/.test(herd);

const finishTakenOver = (stateDir: string) =>
  Effect.gen(function* () {
    const checks = yield* CheckProcesses;
    const { finishCheck, noVerdict } = yield* Effect.promise(() => import("./verify"));
    const { noteVerification } = yield* Effect.promise(() => import("./metrics"));
    const followed = new Map<string, Deferred.Deferred<Verification, HostRefused>>();
    for (const record of yield* checks.takenOver) {
      if (record.by !== "agent") {
        continue;
      }
      const done = yield* Deferred.make<Verification, HostRefused>();
      followed.set(record.id, done);
      yield* Effect.scoped(
        checks.claim(record.id).pipe(
          Effect.flatMap((running) =>
            running === null
              ? Effect.never
              : running.collected(
                  running.exit.pipe(Effect.mapError(noVerdict(record.name, "exit status", "read"))),
                ),
          ),
          Effect.flatMap((exit) => finishCheck(record.id, record.name, exit)),
        ),
      ).pipe(
        Effect.tap((verification) =>
          noteVerification(evidenceDir(stateDir, record.run), verification),
        ),
        Effect.mapError((cause) => new HostRefused({ reason: `invalid_state: ${cause.why}` })),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(done, exit)),
        Effect.forkScoped,
      );
    }
    return followed;
  });

const frontDoorHandlers = (
  dir: string,
  installation: string,
  development: Development,
  panels: MrPanels,
  declared: Declared,
  stamp: string,
  toasted: PubSub.PubSub<Toasted>,
  reconnects: Effect.Effect<number>,
  userDirMoved: Effect.Effect<void>,
) =>
  FrontDoorRpcs.toLayer(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const layerScope = yield* Effect.scope;
      const offerShared = Effect.asVoid(Effect.forkIn(userDirMoved, layerScope));
      const hosted = yield* Effect.context<HostServices>();
      const reliance = yield* Reliance;
      const { env, herdr, bun, sweepers, listed, changed, writes, projected, nudged, ...shared } =
        yield* SharedBoard;
      const collecting = yield* Collecting;
      const forgeHttp = yield* ForgeHttp;
      const boards = shared.boards.pipe(Stream.map((built) => built.views));
      const usage = yield* Usage;
      const harnesses = yield* HarnessCatalogues;
      const schedules = yield* Schedules;
      const artefacts = yield* Artefacts;
      // WARNING: Trimming rewrites the trail through one temporary file: one read records at a time.
      const recordingUsage = yield* Semaphore.make(1);
      const recordingShell = yield* Semaphore.make(1);
      // WARNING: Two doors acknowledging at once must still leave one seen line.
      const seeing = yield* Semaphore.make(1);
      // WARNING: Kept for the host's life: evict by age if a host lives for months.
      const plans: PlanCache = new Map();
      const record = yield* recordSources({ panels, plans });
      const model = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
      const told = (paths: ReadonlyArray<string>) =>
        Effect.forEach(
          paths,
          (path) =>
            Effect.gen(function* () {
              if (Str.startsWith(`${env.stateDir}/`)(path)) {
                if (model !== undefined) {
                  yield* model.invalidate(path);
                }
                return;
              }
              if (Str.startsWith(`${env.userDir}/`)(path)) {
                yield* offerShared;
              }
              const at = Str.lastIndexOf("/workflows")(path);
              if (Option.isNone(at)) {
                return;
              }
              const dir = Str.slice(0, at.value + "/workflows".length)(path);
              const rows = yield* ModuleRevisions;
              yield* rows.put(dir, yield* revisionOf(dir));
            }),
          { discard: true },
        );
      // WARNING: a retried request answers with the revision it first had; read anew it would be the Run's current one.
      const actRevisions = new Map<string, RunRevision>();
      const revisionOfAct = (request: string, index: number, now: RunRevision) => {
        const key = `${request}#${index}`;
        const first = actRevisions.get(key);
        if (first !== undefined && first.epoch === now.epoch) {
          return first;
        }
        if (actRevisions.size >= ACT_REVISIONS_KEPT) {
          const oldest = actRevisions.keys().next();
          if (oldest.done !== true) {
            actRevisions.delete(oldest.value);
          }
        }
        actRevisions.set(key, now);
        return now;
      };
      const { serve } = yield* Foreground;
      const stepStill = (run: string, step: string | undefined, shown: RunRevision | undefined) =>
        Effect.gen(function* () {
          if (shown === undefined || step === undefined || record === undefined) {
            return;
          }
          const flow = yield* recordFlow(record, run).pipe(
            Effect.provideContext(bun),
            Effect.orElseSucceed(() => null),
          );
          const node = Option.getOrUndefined(
            Option.flatMap(
              Arr.findFirst(flow?.lanes ?? [], (lane) => lane.run === run),
              (lane) => Arr.findFirst(lane.nodes, (one) => one.id === step),
            ),
          );
          if (node === undefined || !FINISHED_STEPS.has(node.state)) {
            return;
          }
          const { model } = record;
          const at = model.finishedAt(run, step, model.revision(run).seq);
          if (shown.epoch !== model.epoch || at > shown.seq) {
            return yield* new StaleAct({
              run,
              step,
              reason: `${node.title} has finished since the record you acted on was shown`,
            });
          }
        });
      const followed = yield* finishTakenOver(env.stateDir).pipe(Effect.provideContext(hosted));
      const stampOf = (client: { readonly id: number }) => stampIn(declared, client);
      const doorOf = (client: { readonly id: number }) => stampOf(client).origin;
      const askerOf: (client: { readonly id: number }) => Asker = (client) => ({
        origin: doorOf(client),
        ...declared.get(client.id)?.voice,
      });
      const whoOf = (client: { readonly id: number }) => ({
        ...askerOf(client),
        ...stampOf(client),
      });
      const parkHealedBy = (client: { readonly id: number }) =>
        Effect.gen(function* () {
          const who = stampOf(client);
          if (who.origin !== "agent" || who.from?.run === undefined) {
            return undefined;
          }
          const view = yield* registry.view(who.from.run).pipe(Effect.orElseSucceed(() => null));
          if (view?.heals === undefined) {
            return undefined;
          }
          return Option.getOrElse(
            Schema.decodeUnknownOption(Schema.String)(view.input["park"]),
            () => "",
          );
        });
      const closedTo = (client: { readonly id: number }) =>
        whoOf(client).origin === "desktop"
          ? []
          : Arr.map(SESSION_STORES, (store) => `${env.home}/${store}`);
      // WARNING: An agent settled while Collie waits on its Output is told its verify ended, or it waits forever.
      const toldVerifyEnded = (client: { readonly id: number }, verified: Verification) => {
        const asker = whoOf(client);
        const { run, agent } = asker.from ?? {};
        if (asker.origin !== "agent" || run === undefined || agent === undefined) {
          return Effect.void;
        }
        return Effect.gen(function* () {
          if (!(yield* collecting.has(run, agent))) {
            return;
          }
          if (!isSettled(yield* herdr.agentStatus(agent).pipe(Effect.provideContext(bun)))) {
            return;
          }
          yield* registry.steer({
            runId: run,
            agent,
            mode: "boundary",
            request: `verify-${verified.id}`,
            text: `Your collie verify "${verified.name}" ended: ${verified.result} (exit ${verified.exit}) at ${verified.end.head_sha}. Its log: ${verified.log ?? "none kept"}`,
          });
        }).pipe(
          Effect.catch((cause) =>
            runLog(
              env.stateDir,
              run,
            )(
              `${agent}: could not be told its verify ${verified.id} ended (${reason(cause)})`,
            ).pipe(Effect.provideContext(bun), Effect.ignore),
          ),
        );
      };
      type Carrying = ReturnType<typeof carryOut>;
      type Carried = Exit.Exit<Effect.Success<Carrying>, Effect.Error<Carrying>>;
      const carrying = new Map<string, Deferred.Deferred<Carried>>();
      const carryingKey = (proposal: string, request: string) => stringifyJson([proposal, request]);
      const carriedBy = (proposal: string, request: string) => {
        const running = carrying.get(carryingKey(proposal, request));
        return running === undefined ? null : Effect.flatten(Deferred.await(running));
      };
      // WARNING: In the host's scope: a caller that stops waiting leaves the control running.
      const controls = yield* Effect.scope;
      const controlling = new Map<
        string,
        {
          readonly operation: string;
          readonly asked: string;
          readonly joined: Effect.Effect<typeof Controlled.Type, HostRefused | RequestConflict>;
        }
      >();
      const askerEnv = (client: { readonly id: number }) => ({
        ...env,
        hostStamp: stamp,
        asker: whoOf(client),
      });
      const trail = (runId: string) => runDir(env.stateDir, runId);
      const askersHerd = (client: { readonly id: number }) =>
        machineHerd(askerEnv(client)).pipe(Effect.orElseSucceed(() => null));
      // WARNING: A host that dies between acting and recording leaves that one unrecorded.
      const fresh = <A extends { readonly fresh: boolean }, I extends Schema.Json, E>(
        runId: (value: A) => string,
        line: {
          readonly operation: string;
          readonly request: string;
          readonly origin: FrontDoor;
          readonly from?: Where | undefined;
          readonly asked?: Schema.Json | undefined;
          readonly result: Schema.Codec<A, I>;
        },
        act: Effect.Effect<A, E, HostServices>,
      ) =>
        act.pipe(
          Effect.tap((value) =>
            value.fresh
              ? recordAudit(trail(runId(value)), { ...line, value }).pipe(Effect.orDie)
              : Effect.void,
          ),
          Effect.provideContext(hosted),
        );
      const attachedFor = <A, E, R>(
        paths: ReadonlyArray<string> | undefined,
        act: (asked: { readonly attachments: Schema.Json } | undefined) => Effect.Effect<A, E, R>,
      ) =>
        attachedAs(null, paths).pipe(
          Effect.provideContext(bun),
          Effect.flatMap((attached) =>
            act(attached === undefined ? undefined : { attachments: attached }),
          ),
        );
      const known = (runId: string) =>
        registry.view(runId).pipe(
          Effect.filterOrFail(
            (view) => view !== null,
            () => new HostRefused({ reason: `no Run ${runId}` }),
          ),
        );
      const mrsOfTask = (view: RunView) =>
        Effect.gen(function* () {
          const runs = view.task === null ? [view] : yield* registry.views(view.task);
          return yield* ownedMrs(Arr.map(runs, (one) => factsOfView(env.stateDir, one)));
        }).pipe(Effect.provideContext(bun));
      const offersOn = Effect.fn("Host.offersOn")(function* (runId: string) {
        const own = yield* registry.offers(runId);
        const view = yield* registry.view(runId);
        const mrs = view === null ? [] : yield* mrsOfTask(view);
        if (mrs.length < 2) {
          return own;
        }
        const owned = yield* Effect.forEach(mrs, (one) =>
          registry.offers(one.owner).pipe(
            Effect.orElseSucceed(() => {
              const returned: ReadonlyArray<Offer> = [];
              return returned;
            }),
            Effect.map((offers) => ({ run: one.owner, named: one.short, offers })),
          ),
        );
        return taskOffers(runId, own, owned);
      });
      const disposedOn = (ref: string) =>
        Effect.fn("Host.disposedOn")(function* (view: RunView) {
          const asked = { run: view.runId, ref };
          const said = Str.toLowerCase(Str.trim(ref));
          if (said === "") {
            return asked;
          }
          const mrs = yield* mrsOfTask(view);
          const id = yield* mrIdIn(ref, view.cwd, shell);
          const named = Arr.findFirst(
            mrs,
            (one) =>
              one.id === id ||
              Str.toLowerCase(one.short) === said ||
              Str.toLowerCase(one.label) === said,
          );
          if (Option.isSome(named)) {
            return { run: named.value.owner, ref: named.value.id };
          }
          const anMr = id !== null || (readMrRef(ref) ?? readMrRef(`mr:${said}`)) !== null;
          if (mrs.length === 0 || !anMr) {
            return asked;
          }
          return yield* new HostRefused({
            reason: `${ref} is not one of this Task's merge requests: ${Arr.join(
              Arr.map(mrs, (one) => one.label),
              ", ",
            )}`,
          });
        }, Effect.provideContext(bun));
      const successorOn = Effect.fn("Host.successorOn")(function* (view: RunView, ref: string) {
        const here = env.machine ?? machineName();
        const short = (name: string) => Str.split(name, ".")[0];
        const refs = Arr.filter(
          qualifiedRuns(ref),
          (one) => one.machine !== here && one.machine !== short(here),
        );
        if (refs.length === 0) {
          return undefined;
        }
        if (refs.length !== 1) {
          return yield* new HostRefused({ reason: "a handoff must name one successor" });
        }
        const named = refs[0]!;
        const matches = Arr.filter(
          yield* peersOf(dir),
          (peer) => peer.name === named.machine || short(peer.name) === named.machine,
        );
        if (matches.length !== 1) {
          return yield* new HostRefused({
            reason: `successor ${ref} has no unambiguous paired Machine`,
          });
        }
        const peer = matches[0]!;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const remote = yield* connectPeer(dir, peer.name, { as: "host", client: here, stamp });
            const identity = yield* remote.identity();
            if (
              identity.installation !== peer.installation ||
              identity.installation === installation
            ) {
              return yield* new HostRefused({
                reason: `successor ${ref} did not answer as its paired Machine`,
              });
            }
            const target = yield* remote.runWork({ runId: named.run });
            if (target === null) {
              return yield* new HostRefused({ reason: `successor ${ref} does not exist` });
            }
            const owning = Arr.findFirst(
              yield* mrsOfTask(view),
              (one) => one.id === target.work.mr,
            );
            const helper = mrOf(factsOfView(dir, view)) === null;
            const carrier =
              helper && Option.isSome(owning) ? yield* known(owning.value.owner) : view;
            const ownMr = mrOf(factsOfView(dir, carrier));
            const own = ownMr === null ? null : yield* mrIdIn(ownMr, carrier.cwd, shell);
            const repository =
              own === null ? yield* projectHere(carrier.cwd, shell) : mrIdProject(own);
            const sameMr = own !== null && own === target.work.mr;
            const sameBranch =
              (own === null || target.work.mr === null) &&
              carrier.branch !== null &&
              carrier.branch === target.work.branch &&
              repository !== null &&
              repository === target.work.repository;
            if (!sameMr && !sameBranch) {
              return yield* new HostRefused({
                reason: `successor ${ref} does not carry this Run's work`,
              });
            }
            return {
              carrier: carrier.runId,
              successor: {
                machine: { installation: peer.installation, name: peer.name },
                run: target.run,
                task: target.task,
                work: { mr: own, repository, branch: carrier.branch },
              },
            };
          }),
        ).pipe(
          Effect.timeout(ASK_TIMEOUT),
          Effect.mapError((cause) =>
            Schema.is(HostRefused)(cause)
              ? cause
              : new HostRefused({
                  reason: `successor ${ref} could not be verified: ${reason(cause)}`,
                }),
          ),
          Effect.provideContext(bun),
        );
      });
      const auditedControl =
        (
          runId: string,
          operation: string,
          request: string,
          who: Asker & { readonly from?: Where | undefined },
          reason?: string,
        ) =>
        (
          act: Effect.Effect<typeof Controlled.Type, HostRefused | RequestConflict, HostServices>,
        ) => {
          const work = Effect.andThen(
            known(runId),
            once(
              trail(runId),
              {
                operation,
                request,
                ...who,
                reason,
                asked: { reason: reason ?? null },
                result: Controlled,
              },
              act,
            ),
          ).pipe(Effect.provideContext(hosted));
          const key = stringifyJson([runId, request]);
          const asked = stringifyJson([operation, reason ?? null]);
          return Effect.suspend(() => {
            const running = controlling.get(key);
            if (running !== undefined) {
              return running.asked === asked
                ? running.joined
                : Effect.fail(
                    new RequestConflict({
                      request,
                      reason: `request "${request}" is already running ${running.operation} for something else`,
                    }),
                  );
            }
            const done = Deferred.makeUnsafe<
              typeof Controlled.Type,
              HostRefused | RequestConflict
            >();
            const joined = Deferred.await(done);
            controlling.set(key, { operation, asked, joined });
            return work.pipe(
              Effect.ensuring(Effect.sync(() => controlling.delete(key))),
              Deferred.into(done),
              Effect.forkIn(controls),
              Effect.andThen(joined),
            );
          });
        };
      const refusedPlainly = <A, E, R extends PlatformServices | Records>(
        effect: Effect.Effect<A, E, R>,
      ) =>
        effect.pipe(
          Effect.mapError((cause) =>
            Schema.is(RequestConflict)(cause) || Schema.is(HostRefused)(cause)
              ? cause
              : new HostRefused({ reason: reason(cause) }),
          ),
          Effect.provideContext(bun),
        );
      const filesOnce = <A, I extends Schema.Json, E, R>(
        line: Parameters<typeof once<A, I, E, R>>[1],
        act: Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const trail = (yield* Path.Path).join(env.stateDir, "files");
          const done = yield* once(trail, line, act);
          yield* trimAudit(trail, FILES_TRAIL).pipe(Effect.orDie);
          return done;
        });
      const plainly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            Schema.is(ProposalRefused)(cause) ||
            Schema.is(RequestConflict)(cause) ||
            Schema.is(HostRefused)(cause)
              ? cause
              : new HostRefused({ reason: reason(cause) }),
          ),
          Effect.provideContext(bun),
          Effect.provideContext(hosted),
        );
      const answeredOnce = <A, E, R>(
        proposal: string,
        hash: string,
        request: string,
        kind: "confirmed" | "declined",
        act: (
          file: string,
          lines: ReadonlyArray<ProposalLine> | null,
        ) => Effect.Effect<A, E | ProposalRefused | RequestConflict, R>,
      ) =>
        Effect.gen(function* () {
          const file = yield* journalOf(proposal);
          if (file === null) {
            return yield* new ProposalRefused({
              refused: "not_found",
              detail: `no proposal "${proposal}"`,
            });
          }
          const lines = yield* readProposals(file);
          const found = Option.getOrUndefined(
            Arr.findFirst(
              lines,
              (line): line is ProposalRecord => line.kind === "proposal" && line.id === proposal,
            ),
          );
          if (found?.content_hash !== hash) {
            return yield* new ProposalRefused({
              refused: "hash_mismatch",
              detail: `"${proposal}" is ${found?.content_hash}, not ${hash}`,
            });
          }
          const prior = answeredBy(lines, request);
          if (prior === undefined) {
            return yield* act(file, null);
          }
          if (prior.kind !== kind || prior.id !== proposal) {
            return yield* new RequestConflict({
              request,
              reason: `request "${request}" already ${prior.kind} ${prior.id}`,
            });
          }
          return yield* act(file, lines);
        }).pipe(plainly);
      // WARNING: A Run stopped after its merge request landed stays stopped.
      const takeUp = Effect.fn("Host.takeUp")(function* (
        runId: string,
        recoveryPark?: string,
        healing?: string,
      ) {
        const view = yield* registry.view(runId);
        const run = view === null ? null : factsOfView(env.stateDir, view);
        const mr = run?.state === "stopped" ? mrOf(run) : null;
        const state =
          mr === null
            ? undefined
            : (yield* readMrStates(env.stateDir).pipe(Effect.orElseSucceed(() => new Map()))).get(
                (yield* mrIdIn(mr, run!.cwd, shell)) ?? "",
              );
        if (state === undefined || !LANDED_STATES.has(state)) {
          return yield* registry.resume(runId, recoveryPark, healing);
        }
        return {
          runId,
          control: STOP,
          set: false,
          left: [],
          applied: false,
          detail: `${runId} was stopped after its merge request merged; there is nothing left to resume`,
        };
      });
      const progressFor = (runId: string) =>
        Effect.gen(function* () {
          const view = yield* registry.view(runId);
          if (view === null) {
            return null;
          }
          const board = Option.getOrElse(yield* Stream.runHead(boards), () => []);
          const card = Option.getOrUndefined(
            Arr.findFirst(board, (one) => one.runs.includes(runId)),
          );
          const mr = card?.run === runId ? card.mr : null;
          const id = mr === null ? null : yield* mrIdIn(mr, view.cwd, shell);
          const forged = id === null ? undefined : (yield* readForge(env.stateDir)).get(id);
          return {
            ready: readinessOfRun(runId, card, terminalStatus(view.status)),
            ci: forged?.checks ?? null,
            steps: yield* operationsOf(runId),
            mrs: card?.mrs,
          };
        }).pipe(Effect.provideContext(bun));
      yield* Effect.forkScoped(
        recoverParks({
          env,
          herdr,
          views: registry.views(null),
          reconnects,
          panels,
          resume: (view, request, park) =>
            auditedControl(view.runId, "resume", request, { origin: "host" })(
              Effect.gen(function* () {
                if (
                  (yield* machineMemory(env)).short ||
                  configValue(yield* readConfig(env.userDir), "recovery.resume") === false
                ) {
                  return {
                    runId: view.runId,
                    control: STOP,
                    set: false,
                    left: [],
                    applied: false,
                    detail: "Recovery waits for memory or its setting",
                  };
                }
                return yield* takeUp(view.runId, park);
              }).pipe(Effect.mapError((cause) => new HostRefused({ reason: reason(cause) }))),
            ),
        }).pipe(Effect.provideContext(hosted)),
      );
      yield* Effect.forkScoped(
        healParks({
          env,
          herdr,
          views: registry.views(null),
          start: (view, healer, request, park) =>
            Effect.gen(function* () {
              const admitted = yield* registry.start({
                generation: yield* registry.resolve({ project: view.project, id: healer }),
                request,
                project: view.project,
                input: { run: view.runId, park },
                task: view.task,
                heals: view.runId,
              });
              const trail = runDir(env.stateDir, admitted.runId);
              const recorded = Arr.some(
                yield* readAudit(trail).pipe(Effect.orElseSucceed(() => [])),
                (line) => line.request === request,
              );
              if (!recorded) {
                yield* recordAudit(trail, {
                  operation: "start",
                  request,
                  origin: "host",
                  result: Started,
                  value: admitted,
                }).pipe(Effect.orDie);
              }
              return admitted.runId;
            }),
          notify: (runId, kind, body, key) =>
            Effect.serviceOption(Notifier).pipe(
              Effect.flatMap((notifier) =>
                Option.isNone(notifier)
                  ? Effect.void
                  : notifier.value.notify(runId, kind, body, { key }),
              ),
            ),
          host: Context.get(hosted, Host),
        }).pipe(Effect.provideContext(hosted)),
      );
      return FrontDoorRpcs.of({
        declare: (
          { frontDoor, session: _herdrSession, from, stamp: stamped, ...voice },
          { client },
        ) => {
          // WARNING: Which Machine a channel came from is said by this host's own link, never by the channel.
          if (from?.machine !== undefined && stamped !== stamp) {
            return Effect.fail(
              new HostRefused({ reason: "a channel cannot say which Machine it came from" }),
            );
          }
          if (frontDoor === "host" && stamped !== stamp) {
            return Effect.fail(new HostRefused({ reason: "only a host's own link is host" }));
          }
          const already = declared.get(client.id);
          if (frontDoor === "schedule") {
            return Effect.fail(
              new HostRefused({ reason: "only the host starts a Run as a Schedule" }),
            );
          }
          if (already !== undefined && already.frontDoor !== frontDoor) {
            return Effect.fail(
              new HostRefused({ reason: `this channel is already ${already.frontDoor}` }),
            );
          }
          return Effect.gen(function* () {
            let where = from;
            if (frontDoor === "agent" && from?.machine === undefined) {
              const entry = Option.getOrUndefined(
                Arr.findLast(yield* everyRegistered, (one) => one.agent === from?.agent),
              );
              if (entry === undefined || (from?.run !== undefined && from.run !== entry.runId)) {
                return yield* new HostRefused({
                  reason: "this agent's Run could not be named from its registration",
                });
              }
              where = {
                ...from,
                run: entry.runId,
                agent: entry.agent,
                machine: { installation, name: machineName() },
              };
            }
            const voiced = frontDoor === "chat" ? { voice: voiceOf(voice) } : {};
            if (already !== undefined) {
              declared.set(client.id, { ...already, ...voiced });
              return;
            }
            declared.set(client.id, { frontDoor, from: where, ...voiced });
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
            ),
            Effect.provideContext(bun),
          );
        },
        start: (
          {
            project,
            id,
            request,
            inferred,
            root,
            options,
            task,
            parent,
            verify,
            attachments,
            ...given
          },
          { client },
        ) => {
          const scrubbed = scrubJson(given);
          const { input, text, taskLabel, intent } = scrubbed.value;
          return attachedFor(attachments, (asked) =>
            fresh(
              (started) => started.runId,
              { operation: "start", request, ...whoOf(client), asked, result: Started },
              startCheckout(
                env,
                project,
                options,
                whoOf(client).from?.machine !== undefined &&
                  whoOf(client).from?.machine?.installation !== installation,
              ).pipe(
                Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
                Effect.flatMap((placed) =>
                  "error" in placed
                    ? Effect.fail(new HostRefused({ reason: `${REFUSED_INPUT}: ${placed.error}` }))
                    : Effect.all([
                        registry.resolve({ project: placed.project, id }),
                        Effect.succeed(task),
                      ]).pipe(
                        Effect.flatMap(([generation, task]) =>
                          registry.start({
                            generation,
                            started: startedOf(
                              whoOf(client).origin,
                              whoOf(client).said,
                              input,
                              text,
                            ),
                            requestedBy:
                              whoOf(client).origin === "agent"
                                ? Option.getOrUndefined(
                                    Schema.decodeUnknownOption(RequestedBy)(whoOf(client).from),
                                  )
                                : undefined,
                            project: placed.project,
                            request,
                            input,
                            text,
                            inferred,
                            root: placed.root ?? root,
                            options: placed.options,
                            branchBase: placed.branchBase,
                            task,
                            taskLabel,
                            parent,
                            intent,
                            verify,
                            attachments,
                          }),
                        ),
                        Effect.tap((started) =>
                          Effect.gen(function* () {
                            const view = yield* registry.view(started.runId);
                            if (
                              view?.requestedBy === undefined ||
                              view.requestedBy.machine.installation === installation
                            ) {
                              return;
                            }
                            const { notifyRunLink } = yield* Effect.promise(
                              () => import("./run-link-delivery"),
                            );
                            yield* notifyRunLink(
                              { ...env, hostStamp: stamp },
                              installation,
                              view,
                              "admitted",
                            );
                          }),
                        ),
                        Effect.map(saying(scrubbed.removed)),
                      ),
                ),
              ),
            ),
          );
        },
        answer: ({ runId, decision, value: given, request }, { client }) => {
          const { text: value, removed } = scrub(given);
          return serve(
            fresh(
              () => runId,
              { operation: "answer", request, ...whoOf(client), result: Answered },
              registry
                .answer({ runId, decision, value, request, by: whoOf(client) })
                .pipe(Effect.map(saying(removed))),
            ),
          );
        },
        control: ({ runId, control, set, request, reason, before, shown }, { client }) =>
          serve(
            Effect.andThen(
              stepStill(runId, before, shown),
              auditedControl(
                runId,
                `${set ? "" : "un"}${control}${before === undefined ? "" : `:before:${before}`}`,
                request,
                whoOf(client),
                reason,
              )(
                registry.control({
                  runId,
                  control,
                  set,
                  before,
                  by: whoActed(actorOf(whoOf(client), request)),
                }),
              ),
            ),
          ),
        publish: ({ runId, title, file, onto, pushOnly, skipCi, request }, { client }) =>
          once(
            runDir(dir, runId),
            {
              operation: "publish",
              request,
              ...whoOf(client),
              asked: {
                title,
                file,
                onto: onto ?? null,
                pushOnly: pushOnly ?? false,
                skipCi: skipCi ?? false,
              },
              result: Schema.Struct({ url: Schema.String }),
            },
            Effect.gen(function* () {
              yield* known(runId);
              const published = yield* (yield* Host)
                .publish({ runId, title, file, onto, pushOnly, skipCi })
                .pipe(Effect.mapError((error) => new HostRefused({ reason: error.reason })));
              if (!pushOnly) {
                yield* registry.mergeRequest(runId, published.url);
              }
              // WARNING: a push reaches its card on the forge syncer's next round, not its next minute.
              if (published.url !== "") {
                nudged.add(published.url);
              }
              return published;
            }),
          ).pipe(Effect.provideContext(hosted)),
        withdrawNote: ({ runId, note, request }, { client }) =>
          once(
            runDir(dir, runId),
            {
              operation: "withdraw_note",
              request,
              ...whoOf(client),
              asked: { note },
              result: Schema.Boolean,
            },
            Effect.andThen(known(runId), withdrawStepNote(runDir(dir, runId), note)).pipe(
              Effect.flatMap((removed) =>
                removed
                  ? Effect.succeed(true)
                  : Effect.fail(
                      new HostRefused({
                        reason: `Note ${note} has already been read or is absent`,
                      }),
                    ),
              ),
            ),
          ).pipe(Effect.provideContext(hosted)),
        resume: ({ runId, request }, { client }) =>
          auditedControl(
            runId,
            "resume",
            request,
            whoOf(client),
          )(Effect.flatMap(parkHealedBy(client), (healing) => takeUp(runId, undefined, healing))),
        offers: ({ runId }) => serve(offersOn(runId)),
        workflows: ({ project }) =>
          onSyncedRevisions(
            discover(searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project })),
          ).pipe(
            Effect.map(({ entries }) =>
              Arr.map(entries, ({ id, title, description, inputs }) => ({
                id,
                title,
                description,
                inputs: Arr.map(
                  Arr.filter(inputs, (one) => one.strategy !== "internal"),
                  ({ name, required, schema }) => ({ name, required, schema }),
                ),
              })),
            ),
            Effect.provideContext(bun),
          ),
        definitions: () =>
          readDefinitions(env).pipe(
            Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
            Effect.provideContext(bun),
          ),
        refresh: ({ request }, { client }) =>
          once(
            `${env.stateDir}/host`,
            { operation: "refresh", request, ...whoOf(client), result: Schema.Boolean },
            Effect.gen(function* () {
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const child = yield* spawner.spawn(
                ChildProcess.make("collie", ["--json", "machine", "list"], {
                  detached: true,
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                  extendEnv: true,
                }),
              );
              yield* Effect.asVoid(child.unref);
              return true;
            }).pipe(
              Effect.uninterruptible,
              Effect.scoped,
              Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
            ),
          ).pipe(Effect.provideContext(bun)),
        shell: ({ script, stdin, request }, { client }) =>
          plainly(
            recordingShell
              .withPermits(1)(
                once(
                  `${env.stateDir}/shell`,
                  {
                    operation: "shell",
                    request,
                    ...whoOf(client),
                    asked: { script, stdinHash: stdin === undefined ? null : sha256Hex(stdin) },
                    result: ShellResult,
                  },
                  runShell(script, stdin),
                ),
              )
              .pipe(
                Effect.timeoutOrElse({
                  duration: "10 minutes",
                  orElse: () =>
                    Effect.fail(
                      new HostRefused({ reason: "the shell did not finish within 10 minutes" }),
                    ),
                }),
              ),
          ),
        settings: () =>
          sharedSettings(env.userDir).pipe(
            Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
            Effect.provideContext(bun),
          ),
        machineOwn: () =>
          buildMachineOwn(env).pipe(
            Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
            Effect.provideContext(bun),
          ),
        ownInventory: () =>
          ownInventory({ home: env.home, stateDir: env.stateDir }).pipe(Effect.provideContext(bun)),
        ownWords: (_, { client }) =>
          whoOf(client).origin === "desktop"
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  readOwnWords({ home: env.home, stateDir: env.stateDir }, now),
                ),
                Effect.provideContext(bun),
              )
            : Effect.fail(
                new HostRefused({
                  reason:
                    "the human's own words are given only to Desktop, on their click there; no chat, agent or command reads them",
                }),
              ),
        setSettings: ({ settings, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const who = whoOf(client);
              if (
                who.origin === "agent" &&
                Arr.some(settings, ({ key }) => key === "standing_direction")
              ) {
                return yield* new HostRefused({
                  reason:
                    "a Run's agent cannot set standing_direction: it reads repositories and trackers, and what it wrote there would reach every chat as the human's words",
                });
              }
              const trail = (yield* Path.Path).join(env.stateDir, "settings");
              const taken = yield* once(
                trail,
                {
                  operation: "settings",
                  request,
                  ...who,
                  asked: { settings },
                  result: SharedSettings,
                },
                takeShared(
                  env.userDir,
                  settings,
                  who.origin === "host"
                    ? (who.from?.machine?.name ?? who.origin)
                    : who.origin === "desktop"
                      ? (who.from?.client ?? who.origin)
                      : null,
                  yield* nowIso,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new HostRefused({
                        reason:
                          cause instanceof SettingRefused
                            ? `${REFUSED_INPUT}: ${cause.reason}`
                            : reason(cause),
                      }),
                  ),
                ),
              );
              yield* trimAudit(trail, SETTINGS_TRAIL).pipe(Effect.orDie);
              yield* offerShared;
              return taken;
            }),
          ),
        sharedDefinitions: (_, { client }) =>
          Effect.gen(function* () {
            const held = yield* sharedDefinitions(env.userDir, yield* nowIso);
            const trail = (yield* Path.Path).join(env.stateDir, "definitions");
            yield* recordAudit(trail, {
              operation: "definitions",
              request: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
              ...whoOf(client),
              result: Schema.Finite,
              value: held.length,
            }).pipe(Effect.andThen(trimAudit(trail, DEFINITIONS_TRAIL)), Effect.orDie);
            return held;
          }).pipe(
            Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
            Effect.provideContext(bun),
          ),
        setSharedDefinitions: ({ definitions, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const who = whoOf(client);
              const trail = (yield* Path.Path).join(env.stateDir, "definitions");
              const held = yield* once(
                trail,
                {
                  operation: "share definitions",
                  request,
                  ...who,
                  asked: { definitions },
                  result: Schema.Array(SharedDefinition),
                },
                takeDefinitions(
                  env.userDir,
                  definitions,
                  who.from?.machine?.name ?? who.from?.client ?? who.origin,
                  yield* nowIso,
                ).pipe(
                  Effect.mapError(
                    (cause) =>
                      new HostRefused({
                        reason:
                          cause instanceof DefinitionRefused
                            ? `${REFUSED_INPUT}: ${cause.reason}`
                            : reason(cause),
                      }),
                  ),
                ),
              );
              yield* trimAudit(trail, DEFINITIONS_TRAIL).pipe(Effect.orDie);
              yield* offerShared;
              return held;
            }),
          ),
        usage: (_, { client }) =>
          plainly(
            Effect.gen(function* () {
              const readings = yield* usage.readings;
              const trail = (yield* Path.Path).join(env.stateDir, "usage");
              const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
              const value = usagePhrase(readings, yield* Clock.currentTimeMillis).text;
              yield* recordingUsage.withPermits(1)(
                recordAudit(trail, {
                  operation: "usage",
                  request,
                  ...whoOf(client),
                  result: Schema.String,
                  value,
                }).pipe(Effect.andThen(trimAudit(trail, USAGE_TRAIL)), Effect.orDie),
              );
              return readings;
            }),
          ),
        fallbacks: () =>
          plainly(
            Effect.gen(function* () {
              const unfinished = Arr.filter(
                yield* registry.views(null),
                (view) => !settled(factsOfView(env.stateDir, view)),
              );
              const launches = yield* launchesOf(Arr.map(unfinished, (view) => view.runId));
              const live = new Set(Arr.map(yield* shared.alive, (agent) => agent.name));
              return fallbacksOf(Arr.flatten([...launches.values()]), live);
            }),
          ),
        models: () => harnesses.catalogues,
        connections: () => connectionsOnMachine(env),
        slackChoices: () => Effect.fail(new HostRefused({ reason: SLACK_BOT_RETIRED })),
        connectionLogin: ({ id }) =>
          readConnectionLogin(env, id).pipe(
            Effect.mapError(
              () =>
                new HostRefused({
                  reason: `Could not read ${id}'s login; sign in on this Machine`,
                }),
            ),
            Effect.provideContext(bun),
          ),
        cleanup: () => plainly(judge(listed)),
        schedules: () => schedules.list,
        changeSchedule: ({ change, request }, { client }) =>
          schedules.change(change, request, whoOf(client)),
        sweep: ({ request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const who = whoOf(client);
              const spoken = { origin: who.origin, request, ...voiceOf(who) };
              const actor: SweptBy =
                who.from === undefined ? spoken : { ...spoken, from: who.from };
              const trail = (yield* Path.Path).join(env.stateDir, "cleanup");
              const swept = yield* sweepAsked(
                trail,
                { operation: "cleanup", request, ...who, asked: {} },
                sweepers,
                env.stateDir,
                actor,
              );
              yield* trimAudit(trail, CLEANUP_TRAIL).pipe(Effect.orDie);
              return swept;
            }),
          ),
        claimedInHelle: ({ slug, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const who = whoOf(client);
              const helleTrail = (yield* Path.Path).join(env.stateDir, "helle");
              const dropped = yield* once(
                helleTrail,
                {
                  operation: "helle_claimed",
                  request,
                  ...who,
                  asked: { slug },
                  result: Schema.Array(Schema.String),
                },
                Effect.gen(function* () {
                  const runs = yield* registry.forgetClaim(slug);
                  for (const runId of runs) {
                    yield* recordAudit(trail(runId), {
                      operation: "helle_claimed",
                      request,
                      ...who,
                      asked: { slug },
                      result: Schema.String,
                      value: slug,
                    }).pipe(Effect.orDie);
                  }
                  return runs;
                }),
              );
              yield* trimAudit(helleTrail, HELLE_TRAIL).pipe(Effect.orDie);
              return dropped;
            }),
          ),
        invoke: ({ runId, offer, input: given, request, attachments }, { client }) => {
          const { value: input, removed } = scrubJson(given);
          return attachedFor(attachments, (asked) =>
            fresh(
              () => runId,
              { operation: "invoke", request, ...whoOf(client), asked, result: Started },
              registry
                .invoke({
                  runId,
                  offer,
                  input,
                  request,
                  attachments,
                  by: actorName({ ...whoOf(client), requestId: request }),
                  started: startedOf(whoOf(client).origin, whoOf(client).said, input, undefined),
                })
                .pipe(Effect.map(saying(removed))),
            ),
          );
        },
        upload: (part, { client }) =>
          refusedPlainly(
            Effect.gen(function* () {
              const got = yield* receive(env.stateDir, part);
              if (got.path !== null && (got.complete || part.offset === 0)) {
                yield* recordAudit(uploadsDir(env.stateDir), {
                  operation: "upload",
                  request: part.sha256,
                  ...whoOf(client),
                  asked: { name: part.name, size: part.size, sha256: part.sha256 },
                  result: Schema.String,
                  value: got.path,
                }).pipe(
                  Effect.andThen(trimAudit(uploadsDir(env.stateDir), UPLOADS_TRAIL)),
                  Effect.orDie,
                );
              }
              return { path: got.path };
            }),
          ),
        readFile: ({ path, offset, length }, { client }) =>
          readPart(path, offset, length, closedTo(client)).pipe(Effect.provideContext(bun)),
        glob: ({ pattern, path }, { client }) =>
          refusedPlainly(globFiles(pattern, path ?? env.home, undefined, closedTo(client))),
        grep: ({ path, ...asked }, { client }) =>
          refusedPlainly(
            grepFiles({ ...asked, path: path ?? env.home }, undefined, closedTo(client)),
          ),
        writeFile: ({ path, content, request }, { client }) =>
          refusedPlainly(
            filesOnce(
              {
                operation: "write",
                request,
                ...whoOf(client),
                asked: {
                  path,
                  sha256: sha256Hex(content),
                },
                result: Written,
              },
              writeWhole(path, content, env.stateDir),
            ),
          ),
        editFile: ({ path, oldString, newString, replaceAll, request }, { client }) =>
          refusedPlainly(
            filesOnce(
              {
                operation: "edit",
                request,
                ...whoOf(client),
                asked: { path, oldString, newString, replaceAll: replaceAll ?? false },
                result: Edited,
              },
              editString({ path, oldString, newString, replaceAll }, env.stateDir),
            ),
          ),
        confirm: ({ proposal, hash, request }, { client }) =>
          answeredOnce(proposal, hash, request, "confirmed", (file, lines) =>
            lines === null
              ? Effect.uninterruptible(
                  Effect.gen(function* () {
                    const running = carriedBy(proposal, request);
                    if (running !== null) {
                      return yield* running;
                    }
                    const done = yield* Deferred.make<Carried>();
                    carrying.set(carryingKey(proposal, request), done);
                    const exit = yield* Effect.exit(
                      carryOut(askerEnv(client), proposal, hash, {
                        ...whoOf(client),
                        requestId: request,
                      }),
                    );
                    carrying.delete(carryingKey(proposal, request));
                    yield* Deferred.succeed(done, exit);
                    return yield* exit;
                  }),
                )
              : Effect.suspend(
                  () =>
                    carriedBy(proposal, request) ??
                    readProposals(file).pipe(
                      Effect.map((now) => ({ proposal, results: stepResults(now, proposal) })),
                    ),
                ),
          ),
        decline: ({ proposal, hash, request }, { client }) =>
          answeredOnce(proposal, hash, request, "declined", (file, lines) =>
            lines === null
              ? decline(file, proposal, { ...whoOf(client), requestId: request }).pipe(
                  Effect.flatMap((done) =>
                    done.refused === null
                      ? Effect.succeed({ proposal })
                      : Effect.fail(
                          new ProposalRefused({ refused: done.refused, detail: done.detail }),
                        ),
                  ),
                )
              : Effect.succeed({ proposal }),
          ),
        propose: ({ herd, request: requestId, ...given }, { client }) => {
          const scrubbed = scrubJson(given);
          const { interpretation, actions } = scrubbed.value;
          const removed = scrubbed.removed;
          return Effect.gen(function* () {
            const asker = askerEnv(client);
            const decoded = Schema.decodeUnknownOption(Schema.Array(ActionSchema))(actions);
            if (Option.isNone(decoded)) {
              return outcomeOf(err("invalid_input", `${refusedAction(actions)}.`));
            }
            if (herd !== null && !isHerdName(herd)) {
              return outcomeOf(err("invalid_input", `"${herd}" is not a Herd.`));
            }
            const key = herd ?? (yield* askersHerd(client));
            if (key === null) {
              return outcomeOf(err("invalid_state", "No Herd to keep the request in."));
            }
            const actor = { ...whoOf(client), requestId };
            return yield* once(
              yield* herdDir(env.stateDir, key),
              {
                operation: "propose",
                request: requestId,
                ...whoOf(client),
                asked: { interpretation, actions },
                result: SteerOutcome,
              },
              // WARNING: A refusal is not kept against its request, so it can be asked again corrected.
              request(asker, key, { interpretation, actions: decoded.value, actor }).pipe(
                Effect.flatMap((result) =>
                  !result.ok && REJECTED.includes(result.error.code)
                    ? Effect.fail(new SteerUnanswered({ outcome: outcomeOf(result) }))
                    : Effect.succeed(outcomeSaying(removed, outcomeOf(result))),
                ),
              ),
            );
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(SteerUnanswered)(cause)
                  ? outcomeSaying(removed, cause.outcome)
                  : Schema.is(RequestConflict)(cause)
                    ? outcomeOf(err("invalid_input", cause.reason))
                    : outcomeOf(
                        err("operation_failed", `Collie could not do it: ${reason(cause)}.`),
                      ),
              ),
            ),
            Effect.provideContext(bun),
            Effect.provideContext(hosted),
          );
        },
        act: ({ actions: given, request, shown }, { client }) => {
          const scrubbed = Arr.map(given, (one) => scrubJson(one));
          const actions = Arr.map(scrubbed, (one) => one.value);
          const targets = Arr.map(actions, (one) => Option.getOrUndefined(targetOf(one)));
          const checked = Effect.forEach(
            targets,
            (target) =>
              target === undefined
                ? Effect.void
                : stepStill(target.run, target.step ?? target.before, shown),
            { discard: true },
          );
          return serve(
            checked.pipe(
              Effect.andThen(
                plainly(
                  Schema.decodeUnknownEffect(Schema.Array(ActionSchema))(actions).pipe(
                    Effect.mapError(
                      () =>
                        new HostRefused({ reason: `${REFUSED_INPUT}: ${refusedAction(actions)}` }),
                    ),
                    Effect.flatMap((decoded) => {
                      const proposed = Arr.filter(
                        decoded,
                        (action) => !ACTED_KINDS.has(action.kind),
                      );
                      return proposed.length > 0
                        ? Effect.fail(
                            new HostRefused({
                              reason: `${REFUSED_INPUT}: ${Arr.join([...new Set(Arr.map(proposed, (a) => a.kind))], ", ")} is carried out through propose, so it is on the record as asked for`,
                            }),
                          )
                        : carryOutAsked(askerEnv(client), decoded, {
                            ...whoOf(client),
                            requestId: request,
                          }).pipe(
                            Effect.map((results) =>
                              Arr.map(results, (result, index) => {
                                const notice = removedNotice(scrubbed[index]?.removed ?? []);
                                const run = targets[index]?.run;
                                const revised =
                                  record === undefined || run === undefined
                                    ? result
                                    : {
                                        ...result,
                                        revision: revisionOfAct(
                                          request,
                                          index,
                                          record.model.revision(run),
                                        ),
                                      };
                                return notice === null
                                  ? revised
                                  : {
                                      ...revised,
                                      note: Arr.join(
                                        Arr.filter([result.note, notice], Boolean),
                                        "; ",
                                      ),
                                    };
                              }),
                            ),
                          );
                    }),
                  ),
                ),
              ),
            ),
          );
        },
        reconcile: ({ proposal, index, as, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const file = yield* journalOf(proposal);
              if (file === null) {
                return yield* new ProposalRefused({
                  refused: "not_found",
                  detail: `no proposal "${proposal}"`,
                });
              }
              const path = yield* Path.Path;
              return yield* once(
                path.dirname(file),
                {
                  operation: "reconcile",
                  request,
                  ...whoOf(client),
                  asked: { proposal, index, as },
                  result: Schema.Struct({ proposal: Schema.String }),
                },
                Effect.gen(function* () {
                  const done = yield* reconcileStep(file, proposal, index, as, {
                    ...whoOf(client),
                    requestId: request,
                  });
                  if (done.refused !== null) {
                    return yield* new ProposalRefused({
                      refused: done.refused,
                      detail: done.detail,
                    });
                  }
                  return { proposal };
                }),
              );
            }),
          ),
        verify: (
          { runId, name, executable, argv, cwd, expect, again, isolated, prepare },
          { client },
        ) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const view = yield* known(runId);
              const { collect, insideRun, missSaid } = yield* Effect.promise(
                () => import("./verify"),
              );
              const { baseTreesDir } = yield* Effect.promise(() => import("./base-tree"));
              const isolation =
                isolated === true || prepare !== undefined ? { prepare } : undefined;
              const { noteVerification } = yield* Effect.promise(() => import("./metrics"));
              const where = cwd ?? view.cwd;
              if (!(yield* insideRun(where, { cwd: view.cwd, worktree: null }))) {
                return yield* new HostRefused({
                  reason: `${REFUSED_INPUT}: "${where}" is not inside run ${runId}; a verification names the tree it ran on.`,
                });
              }
              const check = yield* reliance.relied(runId, { executable, argv, cwd: where });
              if (check !== null) {
                const { record } = check;
                if (record === null) {
                  return yield* new HostRefused({
                    reason: `invalid_state: "${check.check}" is one of this Run's Checks and no record answers for it (${missSaid(check.miss)}); Collie's gate runs it itself, on the final tree.`,
                  });
                }
                const log = record.log === undefined ? "" : `; its log is ${record.log}`;
                return Stream.make(
                  {
                    _tag: "Output" as const,
                    stream: "stderr" as const,
                    text: `not run again: verification ${record.id} of "${check.check}" ${record.result === "pass" ? "passed" : "failed"} on this tree${log}\n`,
                  },
                  { _tag: "Result" as const, verification: record, ran: false },
                );
              }
              const found =
                again === true
                  ? null
                  : yield* reliance.recorded(runId, {
                      name,
                      executable,
                      argv,
                      cwd: where,
                      expect,
                      ...(isolation !== undefined && { isolated: isolation }),
                    });
              const recorded = found?.record ?? null;
              if (recorded !== null) {
                const log = recorded.log === undefined ? "" : `; its log is ${recorded.log}`;
                return Stream.make(
                  {
                    _tag: "Output" as const,
                    stream: "stderr" as const,
                    text: `not run again: verification ${recorded.id} of "${name}" ${recorded.result === "pass" ? "passed" : "failed"} on this tree${log}; --again runs it anyway\n`,
                  },
                  { _tag: "Result" as const, verification: recorded, ran: false },
                );
              }
              return Stream.callback<typeof VerifyEvent.Type, HostRefused>(
                (queue) =>
                  Effect.gen(function* () {
                    const echo = (stream: "stdout" | "stderr") => (text: string) =>
                      Queue.offer(queue, { _tag: "Output", stream, text }).pipe(Effect.asVoid);
                    if (found?.miss) {
                      yield* echo("stderr")(`running it: ${missSaid(found.miss)}\n`);
                    }
                    const from = whoOf(client).from;
                    const step =
                      from?.run === runId
                        ? Option.getOrUndefined(
                            Arr.findLast(
                              yield* readLaunches(runId),
                              (one) => one.agent === from.agent,
                            ),
                          )?.step
                        : undefined;
                    const fs = yield* FileSystem.FileSystem;
                    const runRecords = yield* RunRecords;
                    const stopped = controlSet(runId, STOP).pipe(
                      Effect.provideService(RunRecords, runRecords),
                    );
                    const memory = yield* waitForMemory({
                      env,
                      stateDir: env.stateDir,
                      runId,
                      what: `collie verify "${name}"`,
                      checkout: where,
                      asker:
                        whoOf(client).origin === "agent" && from?.run === runId
                          ? (from.agent ?? null)
                          : null,
                      stopped,
                      say: (sentence) => echo("stderr")(`${sentence}\n`),
                    });
                    if (memory === "stopped") {
                      yield* Queue.fail(
                        queue,
                        new HostRefused({
                          reason: `invalid_state: run ${runId} was stopped while "${name}" waited for memory, so it did not run.`,
                        }),
                      );
                      return;
                    }
                    const started = pipe(yield* nowIso, Str.replaceAll(/[:.]/g, "-"));
                    const log = `${evidenceDir(env.stateDir, runId)}/verify/${started}-${pipe(name, Str.replaceAll(/[^\w.-]/g, "_"))}.log`;
                    const collected = yield* Effect.raceFirst(
                      collect(
                        evidenceDir(env.stateDir, runId),
                        {
                          run: runId,
                          name,
                          executable,
                          argv,
                          cwd: where,
                          by: "agent",
                          expect,
                          log,
                          step: step?.step,
                          place: step?.place,
                          ...(isolation !== undefined && {
                            isolated: {
                              ...isolation,
                              checkouts: baseTreesDir(env.stateDir, runId),
                            },
                          }),
                        },
                        {
                          stdout: echo("stdout"),
                          stderr: echo("stderr"),
                          started: (check) =>
                            Queue.offer(queue, { _tag: "Started", check }).pipe(Effect.asVoid),
                          said: (line) =>
                            echo("stderr")(`${line}\n`).pipe(
                              Effect.andThen(appendLog(runDir(env.stateDir, runId), line)),
                              Effect.ignore({ log: "Warn" }),
                              Effect.provideService(RunRecords, runRecords),
                              Effect.provideService(FileSystem.FileSystem, fs),
                            ),
                        },
                      ).pipe(
                        Effect.mapError(
                          (cause) =>
                            new HostRefused({
                              reason: `${cause.state ? "invalid_state" : REFUSED_INPUT}: ${cause.why}`,
                            }),
                        ),
                        Effect.result,
                      ),
                      // WARNING: Ending the race ends the command's process group with its scope.
                      stopped.pipe(
                        Effect.repeat({
                          until: (stop) => stop,
                          schedule: Schedule.spaced("1 second"),
                        }),
                        Effect.as(
                          Result.fail(
                            new HostRefused({
                              reason: `invalid_state: run ${runId} was stopped while "${name}" ran, so it was ended and recorded nothing.`,
                            }),
                          ),
                        ),
                      ),
                    );
                    if (collected._tag === "Failure") {
                      yield* Queue.fail(queue, collected.failure);
                      return;
                    }
                    yield* noteVerification(evidenceDir(env.stateDir, runId), collected.success);
                    yield* recordAudit(trail(runId), {
                      operation: "verify",
                      request: collected.success.id,
                      ...whoOf(client),
                      asked: { name, executable, argv, cwd: where, expect },
                      result: Schema.Json,
                      value: fromText(toText(collected.success)),
                    }).pipe(Effect.orDie);
                    yield* Queue.offer(queue, {
                      _tag: "Result",
                      verification: collected.success,
                      ran: true,
                    });
                    yield* toldVerifyEnded(client, collected.success);
                    yield* Queue.end(queue);
                  }).pipe(Effect.provideContext(hosted)),
                { bufferSize: 16 },
              );
            }),
          ),
        verifyFollow: ({ check }) => {
          const done = followed.get(check);
          return done === undefined
            ? Stream.fail(
                new HostRefused({
                  reason: `invalid_state: check ${check} is not one this host took over.`,
                }),
              )
            : Stream.fromEffect(
                Effect.map(Deferred.await(done), (verification) => ({
                  _tag: "Result" as const,
                  verification,
                  ran: true,
                })),
              );
        },
        measure: ({ runId, base, cwd, plan, pass, reason }, { client }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const view = yield* known(runId);
              const { insideRun } = yield* Effect.promise(() => import("./verify"));
              const { measure } = yield* Effect.promise(() => import("./measurement"));
              const where = cwd ?? view.cwd;
              if (!(yield* insideRun(where, { cwd: view.cwd, worktree: null }))) {
                return yield* new HostRefused({
                  reason: `${REFUSED_INPUT}: "${where}" is not inside run ${runId}; a Measurement's candidate is the Run's own tree.`,
                });
              }
              return Stream.callback<typeof MeasureEvent.Type, HostRefused>(
                (queue) =>
                  Effect.gen(function* () {
                    const runRecords = yield* RunRecords;
                    const answered = yield* measure({
                      stateDir: env.stateDir,
                      env,
                      ask: {
                        runId,
                        base,
                        cwd: where,
                        plan,
                        pass,
                        ...(reason !== undefined && { reason }),
                      },
                      evidence: evidenceDir(env.stateDir, runId),
                      awaiting: controlOf(runRecords, AWAITING, runId),
                      stopped: controlSet(runId, STOP).pipe(
                        Effect.provideService(RunRecords, runRecords),
                      ),
                      say: (text) => Queue.offer(queue, { _tag: "Said", text }).pipe(Effect.asVoid),
                    }).pipe(
                      Effect.mapError(
                        (cause) => new HostRefused({ reason: `${REFUSED_INPUT}: ${cause.why}` }),
                      ),
                      Effect.result,
                    );
                    if (answered._tag === "Failure") {
                      return yield* Queue.fail(queue, answered.failure);
                    }
                    if (answered.success === "stopped") {
                      return yield* Queue.fail(
                        queue,
                        new HostRefused({
                          reason: `invalid_state: run ${runId} was stopped before its Measurement finished, so none was recorded.`,
                        }),
                      );
                    }
                    const { measurement, ran } = answered.success;
                    if (ran) {
                      yield* recordAudit(trail(runId), {
                        operation: "measure",
                        request: measurement.id,
                        ...whoOf(client),
                        asked: {
                          base,
                          cwd: where,
                          plan,
                          pass,
                          ...(reason !== undefined && { reason }),
                        },
                        result: Schema.Json,
                        value: { measurement: measurement.id, result: measurement.result._tag },
                      }).pipe(Effect.orDie);
                    }
                    yield* Queue.offer(queue, { _tag: "Result", measurement, ran });
                    yield* Queue.end(queue);
                  }).pipe(Effect.provideContext(hosted)),
                { bufferSize: 16 },
              );
            }),
          ),
        rememberVerification: ({ runId, replace, request }, { client }) =>
          plainly(
            once(
              trail(runId),
              {
                operation: "remember-verification",
                request,
                ...whoOf(client),
                asked: { runId, replace },
                result: Schema.Json,
              },
              Effect.gen(function* () {
                const view = yield* known(runId);
                const { rememberChecks } = yield* Effect.promise(() => import("./lifecycle"));
                return fromText(
                  toText(
                    yield* rememberChecks(askerEnv(client), {
                      runId,
                      replace,
                      checkouts: [view.cwd, view.project],
                    }),
                  ),
                );
              }),
            ),
          ),
        clearOverride: ({ runId, agent, request }, { client }) =>
          plainly(
            once(
              trail(runId),
              {
                operation: "clear-override",
                request,
                ...whoOf(client),
                asked: { runId, agent },
                result: Schema.Json,
              },
              known(runId).pipe(
                Effect.andThen(
                  clearOverride(
                    env.stateDir,
                    herdr,
                    runId,
                    agent,
                    actorName({ ...whoOf(client), requestId: request }),
                    voiceOf(whoOf(client)),
                  ),
                ),
                Effect.map((value) => fromText(toText(value))),
              ),
            ),
          ),
        changeIntent: (
          { runId, change: given, propagate: spread, request, expected },
          { client },
        ) => {
          const scrubbed =
            given.kind === "set-goal" || given.kind === "add-constraint"
              ? scrubJson(given)
              : { value: given, removed: [] };
          const change = scrubbed.value;
          return plainly(
            Effect.gen(function* () {
              const edit = Effect.gen(function* () {
                const view = yield* registry.view(runId);
                if (view === null) {
                  return yield* new HostRefused({ reason: `No Run "${runId}".` });
                }
                if (change.kind === "set-outcome") {
                  const asked = change.outcome;
                  if (asked !== null && !REQUESTABLE.includes(asked)) {
                    return yield* new HostRefused({
                      reason: `${REFUSED_INPUT}: "${asked}" is not an outcome; a Run is held to one of ${Arr.join(REQUESTABLE, ", ")}`,
                    });
                  }
                  const fixed = Option.getOrNull(
                    yield* registry
                      .resolve({ project: view.project, id: view.workflow })
                      .pipe(Effect.option),
                  )?.fixedOutcome;
                  if (fixed !== null && fixed !== undefined) {
                    return yield* new HostRefused({
                      reason: `${REFUSED_INPUT}: "${view.workflow}" always proves ${fixed}`,
                    });
                  }
                }
                const by = { ...whoOf(client), requestId: request };
                const approved =
                  change.kind === "verification"
                    ? yield* once(
                        trail(runId),
                        {
                          operation: "grant",
                          request,
                          ...whoOf(client),
                          asked: { name: change.name, command: fromText(toText(change.command)) },
                          result: Schema.Array(VerifySpecSchema),
                        },
                        registry.grant({ runId, name: change.name, command: change.command }),
                      )
                    : undefined;
                const updated = yield* updateIntent(runDir(env.stateDir, runId), (current) =>
                  Effect.gen(function* () {
                    if (current === null) {
                      return null;
                    }
                    if (expected !== undefined && current.version !== expected) {
                      return yield* new HostRefused({
                        reason: `the Intent is v${current.version}, not v${expected}`,
                      });
                    }
                    const recorded =
                      change.kind === "verification"
                        ? Option.getOrUndefined(
                            Arr.findFirst(
                              yield* readAudit(trail(runId)),
                              (one) => one.request === request,
                            ),
                          )
                        : undefined;
                    const amendedBy = recorded?.actor ?? by;
                    if (
                      change.kind === "verification" &&
                      Arr.some(current.history, (one) => one.by === actorName(amendedBy))
                    ) {
                      return null;
                    }
                    const wanted =
                      change.kind === "verification"
                        ? verificationGrant(current, change.name, change.command)
                        : change;
                    const amended = amend(
                      current,
                      wanted,
                      actorName(amendedBy),
                      yield* nowIso,
                      voiceOf(amendedBy),
                    );
                    return amended === current ? null : amended;
                  }),
                ).pipe(Effect.result);
                if (updated._tag === "Failure") {
                  if (approved === undefined) {
                    return yield* new HostRefused({
                      reason: Schema.is(HostRefused)(updated.failure)
                        ? updated.failure.reason
                        : reason(updated.failure),
                    });
                  }
                  return {
                    version: null,
                    propagated: [],
                    approved,
                    warning: `The grant holds, but intent show will not list it: ${reason(updated.failure)}`,
                  };
                }
                const next = updated.success;
                if (next === null && change.kind !== "verification") {
                  return yield* new HostRefused({
                    reason: `Run "${runId}" has no Intent to amend.`,
                  });
                }
                const propagated: Array<string> = [];
                if (spread && next !== null) {
                  for (const child of Arr.filter(
                    yield* registry.views(null),
                    (view) => view.parent === runId && !terminalStatus(view.status),
                  )) {
                    yield* updateIntent(runDir(env.stateDir, child.runId), (current) => {
                      if (current === null) {
                        return Effect.succeed(null);
                      }
                      const carried = propagateIntent(next, current);
                      propagated.push(
                        `  ${child.runId}: propagated${carried.conflicts.length ? ` (${Arr.join(carried.conflicts, "; ")})` : ""}`,
                      );
                      return Effect.succeed(carried.intent);
                    }).pipe(
                      Effect.catchTag("IntentUnreadable", () => Effect.void),
                      Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
                    );
                  }
                }
                const answer = { version: next?.version ?? null, propagated };
                return approved === undefined ? answer : { ...answer, approved };
              }).pipe(Effect.map(saying(scrubbed.removed)));
              return yield* change.kind === "verification"
                ? edit
                : once(
                    trail(runId),
                    {
                      operation: `intent-${change.kind}`,
                      request,
                      ...whoOf(client),
                      asked: { runId, change, propagate: spread },
                      result: ChangedIntent,
                    },
                    edit,
                  );
            }),
          );
        },
        settleDelivery: ({ runId, delivery, as, request }, { client }) =>
          plainly(
            once(
              trail(runId),
              {
                operation: "settle-delivery",
                request,
                ...whoOf(client),
                asked: { delivery, as },
                result: Schema.Json,
              },
              Effect.gen(function* () {
                const found = Option.getOrUndefined(
                  Arr.findFirst(yield* deliveriesOf(runId), (one) => one.id === delivery),
                );
                if (!found) {
                  return yield* new HostRefused({
                    reason: `${REFUSED_INPUT}: no delivery "${delivery}" for this Run`,
                  });
                }
                const settled = reconcileDelivery(
                  yield* readLedger(found.incarnation),
                  delivery,
                  as,
                  actorName({ ...whoOf(client), requestId: request }),
                  yield* nowIso,
                );
                if ("error" in settled) {
                  return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${settled.error}` });
                }
                yield* appendLine(settled);
                return fromText(toText(settled));
              }),
            ),
          ),
        news: ({ herd, conversation, as, request, keys }, { client }) =>
          plainly(
            Effect.gen(function* () {
              if (herd !== null && !isHerdName(herd)) {
                return yield* new HostRefused({
                  reason: `${REFUSED_INPUT}: "${herd}" is not a Herd`,
                });
              }
              const key = herd ?? (yield* askersHerd(client));
              if (key === null) {
                return yield* new HostRefused({
                  reason: "invalid_state: no Herd to read News for",
                });
              }
              const trail = yield* newsTrail(env.stateDir, key);
              const batch = yield* once(
                trail,
                {
                  operation: "news",
                  request,
                  ...whoOf(client),
                  asked: keys === undefined ? { conversation, as } : { conversation, as, keys },
                  result: NewsBatch,
                },
                Effect.gen(function* () {
                  const file = yield* newsPath(env.stateDir, key);
                  const lines = yield* readNews(file);
                  if (keys === undefined) {
                    const batch = pendingNews(lines, conversation);
                    for (const item of batch.items) {
                      yield* settleNews(file, item.key, as, conversation);
                    }
                    return batch;
                  }
                  const batch = pendingNews(lines, conversation, Infinity);
                  for (const item of batch.items) {
                    if (keys.includes(item.key)) {
                      yield* settleNews(file, item.key, as, conversation);
                    }
                  }
                  return batch;
                }),
              );
              yield* trimAudit(trail, NEWS_TRAIL).pipe(Effect.orDie);
              return batch;
            }),
          ),
        runFindings: ({ runId }) =>
          known(runId).pipe(
            // WARNING: the count is kept here for a Run settled before the fact existed.
            Effect.andThen(keepOpenCount(trail(runId))),
            Effect.andThen(findingsWithStatus(trail(runId))),
            plainly,
          ),
        setFinding: ({ runId, id, status, reason, request }, { client }) =>
          known(runId).pipe(
            Effect.andThen(findingsWithStatus(trail(runId))),
            Effect.filterOrFail(
              (findings) => Arr.some(findings, (one) => one.id === id),
              () => new HostRefused({ reason: `no finding "${id}" on ${runId}` }),
            ),
            Effect.filterOrFail(
              () => status !== "dismissed" || Str.trim(reason ?? "") !== "",
              () =>
                new HostRefused({
                  reason: `${REFUSED_INPUT}: dismissing ${id} needs a reason of its own`,
                }),
            ),
            Effect.flatMap(() =>
              once(
                trail(runId),
                {
                  operation: "finding",
                  request,
                  ...whoOf(client),
                  asked: { id, status, reason },
                  result: FindingStatus,
                },
                Effect.gen(function* () {
                  const line: FindingStatus = {
                    id,
                    status,
                    reason: status === "dismissed" ? Str.trim(reason ?? "") : null,
                    offer: null,
                    run: null,
                    by: actorName({ ...whoOf(client), requestId: request }),
                    at: yield* nowIso,
                  };
                  yield* recordFindingStatus(trail(runId), line);
                  yield* storeOpenCount(trail(runId));
                  return line;
                }),
              ),
            ),
            plainly,
          ),
        dispose: ({ runId, kind, ref, note, request }, { client }) =>
          known(runId).pipe(
            Effect.flatMap(disposedOn(ref)),
            Effect.filterOrFail(
              (kept) =>
                kind !== "superseded" ||
                !Arr.contains(refRuns(kept.ref, env.machine ?? machineName()), kept.run),
              (kept) =>
                new HostRefused({
                  reason: `${REFUSED_INPUT}: a superseded line cannot name ${kept.run}, the Run it is recorded on`,
                }),
            ),
            Effect.flatMap((kept) =>
              once(
                trail(runId),
                {
                  operation: "disposition",
                  request,
                  ...whoOf(client),
                  asked: { kind, ref, note },
                  result: Disposition,
                },
                Effect.gen(function* () {
                  const handoff =
                    kind === "superseded"
                      ? yield* successorOn(yield* known(kept.run), kept.ref)
                      : undefined;
                  const plain: Disposition = {
                    at: yield* nowIso,
                    by: actorName({ ...whoOf(client), requestId: request }),
                    kind,
                    ref: kept.ref,
                    note,
                  };
                  const line: Disposition =
                    handoff === undefined ? plain : { ...plain, successor: handoff.successor };
                  yield* recordDisposition(trail(handoff?.carrier ?? kept.run), line);
                  return line;
                }),
              ),
            ),
            plainly,
          ),
        seen: ({ runId, request }, { client }) =>
          known(runId).pipe(
            Effect.andThen(
              seeing.withPermits(1)(
                once(
                  trail(runId),
                  { operation: "seen", request, ...whoOf(client), asked: {}, result: Seen },
                  Effect.gen(function* () {
                    const [first] = yield* readSeen(trail(runId));
                    if (first !== undefined) {
                      return first;
                    }
                    const line = {
                      at: yield* nowIso,
                      by: actorName({ ...whoOf(client), requestId: request }),
                    };
                    yield* recordSeen(trail(runId), line);
                    return line;
                  }),
                ),
              ),
            ),
            plainly,
          ),
        focus: ({ runId, agent, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              yield* known(runId);
              const agents = Arr.filter(
                yield* everyRegistered,
                (entry) => entry.runId === runId && (agent === undefined || entry.agent === agent),
              ).reverse();
              const sessions = yield* liveHerds(herdr, env);
              return yield* once(
                trail(runId),
                {
                  operation: "focus",
                  request,
                  ...whoOf(client),
                  asked: agent === undefined ? {} : { agent },
                  result: PaneAt,
                },
                focusPane(sessions, agents).pipe(
                  Effect.filterOrFail(
                    (at) => at !== null,
                    () => new HostRefused({ reason: `${runId} has no live agent on core` }),
                  ),
                ),
              );
            }),
          ),
        steerAbout: ({ runId, text: given, from, dryRun, request }, { client }) => {
          const { text, removed } = scrub(given);
          return Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) {
              return { ok: false, code: "run_not_found", human: `No Run "${runId}".`, data: {} };
            }
            const task = view.task === null ? null : yield* readTask(view.task);
            return yield* once(
              trail(runId),
              {
                operation: "steer",
                request,
                ...whoOf(client),
                asked: { text, from, dryRun },
                result: SteerOutcome,
              },
              Effect.gen(function* () {
                const asker = askerEnv(client);
                const deps = yield* evaluationDeps({
                  pluginRoot: asker.pluginRoot,
                  herdKey: task?.herd ?? (yield* machineHerd(asker)),
                });
                const said = yield* steer(asker, deps, {
                  text,
                  target: runId,
                  from,
                  dryRun,
                  requestId: request,
                  ...voiceOf(askerOf(client)),
                  origin: doorOf(client),
                });
                if (!said.ok) {
                  return yield* new SteerUnanswered({
                    outcome: {
                      ok: false,
                      code: said.error.code,
                      human: said.error.message,
                      data: fromText(toText(said.error.details)),
                    },
                  });
                }
                return outcomeSaying(removed, {
                  ok: true,
                  code: null,
                  human: said.human,
                  data: fromText(toText(said.data)),
                });
              }),
            );
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(SteerUnanswered)(cause)
                  ? outcomeSaying(removed, cause.outcome)
                  : Schema.is(RequestConflict)(cause)
                    ? { ok: false, code: "invalid_input", human: cause.reason, data: {} }
                    : {
                        ok: false,
                        code: "operation_failed",
                        human: `Collie could not answer: ${reason(cause)}.`,
                        data: {},
                      },
              ),
            ),
            Effect.provideContext(bun),
          );
        },
        followUp: ({ runId, text: given, request, attachments }, { client }) => {
          const { text, removed } = scrub(given);
          return attachedFor(attachments, (asked) =>
            fresh(
              () => runId,
              { operation: "followup", request, ...whoOf(client), asked, result: Started },
              Effect.gen(function* () {
                const view = yield* known(runId);
                if (!settled(factsOfView(env.stateDir, view))) {
                  return yield* new HostRefused({
                    reason: "a follow-up is a child of a finished run, and this one is still going",
                  });
                }
                const offered = Option.getOrUndefined(
                  Arr.findFirst(yield* registry.offers(runId), (one) => one.kind === "follow-up"),
                );
                if (offered === undefined) {
                  return yield* new HostRefused({
                    reason: `${runId} declares no follow-up, so there is nothing to carry on with`,
                  });
                }
                const into =
                  offered.textField === undefined
                    ? followUpField(offered.arguments)
                    : { field: offered.textField };
                if ("refused" in into) {
                  return yield* new HostRefused({
                    reason: `${runId}'s follow-up "${offered.id}" ${into.refused}`,
                  });
                }
                return yield* registry.invoke({
                  runId,
                  offer: offered.id,
                  input: { [into.field]: text },
                  request,
                  attachments,
                });
              }).pipe(Effect.map(saying(removed))),
            ),
          );
        },
        read: ({ tool, input }, { client }) =>
          Effect.promise(() => import("./tools")).pipe(
            Effect.flatMap(({ answerRead }) =>
              Effect.gen(function* () {
                if (tool !== "collie_run") {
                  return yield* answerRead(askerEnv(client), tool, input);
                }
                const { describeOffers, refusal } = yield* Effect.promise(
                  () => import("./lifecycle"),
                );
                const runs = Effect.map(shared.runs, newestFirst);
                const runId = Option.getOrUndefined(
                  Schema.decodeUnknownOption(Schema.String)(input.run),
                );
                const related = yield* Effect.cached(
                  record !== undefined && runId !== undefined
                    ? record
                        .related(runId, [
                          ...record.model.planned(runId),
                          ...descendantsOf(
                            Arr.flatMap([...record.model.indexes().byParent], ([parent, runs]) =>
                              Arr.map([...runs], (child) => ({ runId: child, parent })),
                            ),
                            runId,
                          ),
                        ])
                        .pipe(Effect.map(newestFirst))
                    : runs,
                );
                const offers = (id: string) =>
                  registry.offers(id).pipe(Effect.provideContext(hosted));
                return yield* answerRead(askerEnv(client), tool, input, {
                  runs: record === undefined ? related : runs,
                  related,
                  offers: (id) =>
                    offers(id).pipe(
                      Effect.map((listed) =>
                        listed.length === 0 ? "Nothing is offered." : describeOffers(listed),
                      ),
                      Effect.catch((cause) => Effect.succeed(refusal(cause).error.message)),
                    ),
                  progress: (id) => progressFor(id).pipe(Effect.provideContext(bun)),
                  launches: (id) =>
                    readLaunches(id).pipe(
                      Effect.orElseSucceed(() => []),
                      Effect.provideContext(bun),
                    ),
                  flow: (id) =>
                    record !== undefined
                      ? recordFlow(record, id).pipe(
                          Effect.orElseSucceed(() => null),
                          Effect.provideContext(bun),
                        )
                      : Effect.gen(function* () {
                          return yield* taskFlowOf(
                            {
                              env: askerEnv(client),
                              runs: yield* related,
                              alive: yield* shared.aliveNow,
                              offers: (run) => offers(run).pipe(Effect.orElseSucceed(() => [])),
                            },
                            id,
                          );
                        }).pipe(
                          Effect.orElseSucceed(() => null),
                          Effect.provideContext(bun),
                        ),
                });
              }),
            ),
            Effect.provideContext(bun),
          ),
        progress: ({ runId }) => progressFor(runId),
        runDetail: (key) => {
          const { runId, tail, pages, refreshMr } = key;
          // WARNING: whole records say their minutes as of their read, so they follow the tick.
          if (record !== undefined) {
            return recordFrames(record, key, key.parts === true ? writes : changed).pipe(
              markFirst("host:emit", runId),
              Stream.provideContext(bun),
              Stream.orDie,
            );
          }
          let fresh = refreshMr;
          const detail = Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) {
              return null;
            }
            const run = factsOfView(env.stateDir, view);
            const target = mrOf(run);
            const mr =
              target === null
                ? null
                : yield* watchedMr({
                    stateDir: env.stateDir,
                    panels,
                    target,
                    cwd: env.cwd,
                    run: shell,
                    now: yield* Clock.currentTimeMillis,
                    fresh,
                  });
            fresh = false;
            const runs = Arr.map(yield* registry.views(null), (one) =>
              factsOfView(env.stateDir, one),
            );
            const hosted = yield* Effect.context<HostServices>();
            const flow = yield* taskFlowOf(
              {
                env,
                runs,
                alive: yield* shared.alive,
                offers: (id) =>
                  registry.offers(id).pipe(
                    Effect.provideContext(hosted),
                    Effect.orElseSucceed(() => []),
                  ),
              },
              runId,
            ).pipe(Effect.orElseSucceed(() => null));
            return yield* buildRunDetail({ env, runId, runs, mr, tail, pages, plans, flow });
          }).pipe(Effect.provideContext(bun));
          return followDetail(detail, changed).pipe(Stream.orDie);
        },
        artefacts: ({ runId, refresh }) =>
          known(runId).pipe(
            Effect.flatMap((view) =>
              refresh === true
                ? artefacts.reconcile(factsOfView(env.stateDir, view))
                : artefacts
                    .cached(factsOfView(env.stateDir, view))
                    .pipe(
                      Effect.tap(() =>
                        artefacts
                          .schedule(factsOfView(env.stateDir, view))
                          .pipe(Effect.forkIn(controls)),
                      ),
                    ),
            ),
            Effect.provideContext(bun),
          ),
        artefactSearch: (asked) =>
          Effect.gen(function* () {
            const latest = yield* Stream.runHead(shared.boards);
            const runs = latest._tag === "Some" ? latest.value.runs : [];
            const found = yield* artefacts.search(
              asked,
              Arr.map(runs, (run) => run.id),
            );
            if (found.coverage.indexed < found.coverage.runs) {
              yield* artefacts.index(runs).pipe(Effect.forkIn(controls));
            }
            return found;
          }).pipe(Effect.provideContext(bun)),
        artefactRead: ({ runId, id, revision, offset }) =>
          known(runId).pipe(
            Effect.flatMap((view) =>
              artefacts.read(factsOfView(env.stateDir, view), id, revision, offset),
            ),
            Effect.provideContext(bun),
          ),
        submitOutput: ({ runId, output }, { client }) => {
          const who = whoOf(client);
          return who.origin === "agent" && who.from?.run === runId && who.from.agent !== undefined
            ? submitOutput(runId, who.from.agent, output).pipe(
                Effect.mapError(
                  (cause) =>
                    new HostRefused({
                      reason: `Your Output could not be written: ${cause.message}`,
                    }),
                ),
                Effect.provideContext(bun),
              )
            : Effect.fail(
                new HostRefused({ reason: `Only an agent of ${runId} submits its Output.` }),
              );
        },
        artefactRegister: ({ runId, request, ...input }, { client }) =>
          known(runId).pipe(
            Effect.flatMap((view) =>
              artefacts.register(
                factsOfView(env.stateDir, view),
                installation,
                input,
                request,
                actorOf(whoOf(client), request),
              ),
            ),
            Effect.tap((answer) =>
              answer.fresh
                ? recordAudit(trail(runId), {
                    operation: "artefact-register",
                    request,
                    ...whoOf(client),
                    asked: parseJson(Schema.Json, stringifyJson(input)),
                    result: Artefact,
                    value: answer.item,
                  }).pipe(Effect.orDie)
                : Effect.void,
            ),
            Effect.map(({ item }) => ({
              address: { installation, run: runId, id: item.id },
              item,
              retained: { revision: item.revision, digest: item.digest, size: item.size },
            })),
            Effect.provideContext(bun),
          ),
        artefactSeen: ({ runId, id, revision, request }, { client }) =>
          known(runId).pipe(
            Effect.andThen(
              artefacts.seen(runId, id, revision, request, actorOf(whoOf(client), request)),
            ),
            Effect.tap((answer) =>
              answer.fresh
                ? recordAudit(trail(runId), {
                    operation: "artefact-seen",
                    request,
                    ...whoOf(client),
                    asked: { id, revision },
                    result: Artefact,
                    value: answer.item,
                  }).pipe(Effect.orDie)
                : Effect.void,
            ),
            Effect.map((answer) => answer.item),
            Effect.provideContext(bun),
          ),
        runFile: ({ runId, ref, offset, length }) =>
          registry.view(runId).pipe(
            Effect.flatMap((view) =>
              view === null
                ? Effect.fail(new HostRefused({ reason: `no Run ${runId}` }))
                : fetchRef(
                    factsOfView(env.stateDir, view),
                    ref,
                    { offset: offset ?? 0, length: length ?? PART_BYTES },
                    env.cwd,
                  ),
            ),
            Effect.provideContext(bun),
            Effect.provideService(ForgeHttp, forgeHttp),
          ),
        toasts: () => Stream.fromPubSub(toasted),
        wrote: ({ paths }) => told(paths).pipe(Effect.provideContext(bun)),
        board: () =>
          Stream.unwrap(
            liveHerds(herdr, env).pipe(
              Effect.map((sessions) =>
                boardMessages({
                  head: {
                    installation,
                    build: BUILD,
                    ...development,
                    protocol: PROTOCOL,
                    files: true,
                    artefacts: true,
                    herds: Arr.flatMap(sessions, ({ herd }) =>
                      herd === null ? [] : [{ id: herd }],
                    ),
                  },
                  boards: Stream.unwrap(
                    Effect.sync(() => {
                      const first = projected();
                      return first === null ? boards : Stream.concat(Stream.make(first), boards);
                    }),
                  ),
                }),
              ),
              Effect.provideContext(bun),
            ),
          ).pipe(Stream.orDie),
      });
    }).pipe(Effect.map(timingFirstValues), Effect.flatMap(healerBound(declared, dir))),
  );

const installationOf = Effect.fn("Host.installationOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${dir}/installation`;
  const known = Str.trim(yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")));
  if (known !== "") {
    return known;
  }
  const made = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  // WARNING: Renamed into place, so a host that dies mid-write leaves no half an id.
  yield* fs.writeFileString(`${file}.new`, `${made}\n`);
  yield* fs.rename(`${file}.new`, file);
  return made;
});

const onLeftoversRun = (dir: string) => (leftover: Leftover, outcome: LeftoverEnd, line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = runDir(dir, leftover.run);
    if (!(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))) {
      return;
    }
    const marker = yield* verifyingOf(leftover.run);
    if (
      outcome !== "still running" &&
      marker !== null &&
      marker.name === leftover.name &&
      marker.pass === leftover.pass &&
      epochMs(marker.started) <= leftover.started
    ) {
      yield* RunRecords.use((records) => records.setControl(VERIFYING, leftover.run, null));
    }
    yield* appendLog(at, line).pipe(Effect.ignore);
  });

const endCiWaits = Effect.gen(function* () {
  for (const row of yield* RunRecords.use((records) => records.everyControl(VERIFYING))) {
    if (decodeVerifying(row.data)?.pass === "ci") {
      yield* RunRecords.use((records) => records.setControl(VERIFYING, row.run, null));
    }
  }
});

// WARNING: Losing the lock is not a failure: a host is already here, which is what the caller wanted.
export const serve: (
  named: string,
) => Effect.Effect<void, never, PlatformServices | Scope.Scope> = (named) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(named, { recursive: true });
    // WARNING: Resolved before the chdir below moves where a relative path points.
    const dir = yield* fs.realPath(named);
    yield* Effect.sync(() => {
      process.chdir(dir);
      leaveLauncher();
    });
    const lock = lockOf(dir);
    yield* ensureLockDir(lock);
    // WARNING: withLock breaks a dead holder's claim before its last attempt, so nothing is left for a human to clear.
    return yield* withLock(
      lock,
      Effect.void,
      Effect.gen(function* () {
        // WARNING: No process can carry an id this host has yet to make.
        const fresh = !(yield* fs.exists(`${dir}/installation`));
        const installation = yield* installationOf(dir);
        yield* markSeenSince(dir, yield* nowIso);
        const handedOver = yield* fs
          .readFileString(handedOverOf(dir))
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HandedOverJson)), Effect.option);
        yield* fs.remove(handedOverOf(dir), { force: true }).pipe(Effect.ignore);
        // WARNING: Opened after the checks a host before it left are taken over, and it migrates the store first.
        const checkRecords = yield* Layer.build(recordsAt(dir));
        const checks = yield* hostCheckProcesses({
          dir,
          installation,
          onRun: onLeftoversRun(dir),
          sweep: false,
          supervisor: yield* hostCommand,
          // WARNING: Only a host of the build it was handed to takes the checks over.
          ...(Option.isSome(handedOver) &&
            handedOver.value.build === BUILD && { handedOver: handedOver.value }),
        }).pipe(Effect.provideContext(checkRecords));
        yield* endCiWaits.pipe(Effect.provideContext(checkRecords));
        const sweep = fresh
          ? Effect.void
          : checks.left.pipe(
              Effect.flatMap((left) =>
                Effect.forEach(left, checks.endLeftover, {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ),
            );
        const stop = yield* boundedStop(dir, lock, checks);
        yield* Effect.logInfo(`collie ${BUILD} host started, pid ${process.pid}`);
        yield* Effect.forkScoped(
          rotateInPlace(outputOf(dir)).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
        );
        // WARNING: A config that cannot be read leaves the model on, its default.
        const modelled = yield* currentEnv.pipe(
          Effect.flatMap((env) => loadDefaults(env.userDir)),
          Effect.map((defaults) => defaults.runModel),
          Effect.orElseSucceed(() => true),
        );
        if (!modelled) {
          yield* Effect.logInfo(
            "the Run model is off: the board is read from disk on every change",
          );
        }
        const { port, gone } = yield* doorThread;
        const door = yield* engineEnd(port);
        const counter = new SharedArrayBuffer(4);
        const epoch = `${installation}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
        yield* Effect.raceAll([
          modelled
            ? own(dir, checks, sweep, door, { counter, epoch, installation }).pipe(
                Effect.provide(runModelLayer(dir, installation, door.link(counter, epoch))),
              )
            : own(dir, checks, sweep, door, undefined),
          orphaned(dir).pipe(Effect.flatMap(stop)),
          gone.pipe(Effect.flatMap(() => stop(StopReason.DoorGone()))),
        ]);
      }).pipe(Effect.provide(Logger.layer([hostLogger(logOf(dir))], { mergeWithExisting: true }))),
      0,
    );
  }).pipe(
    Effect.orDie,
    Effect.provideService(Scheduler.Scheduler, new TurnScheduler(servedNow)),
    Effect.updateService(FileSystem.FileSystem, foregroundFileSystem),
    refusingWatch,
    Effect.provide(Layer.merge(tracingLayer(BUILD), foregroundLayer)),
  );

const hostRefuses = Config.Boolean("COLLIE_HOST_REFUSES").pipe(
  Config.withDefault(false),
  Effect.orDie,
);

// WARNING: a card's derivation reads only the Run model and the syncers' rows, never git, a forge or HTTP.
const refusingOutside = <A, E, R>(derivation: Effect.Effect<A, E, R>) =>
  derivation.pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("a card's derivation spawned a process")),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.die(`a card's derivation asked ${request.url}`)),
    ),
  );

// WARNING: a host holds no file watch; under COLLIE_HOST_REFUSES one coming back is a defect.
const refusingWatch = <A, E, R>(host: Effect.Effect<A, E, R>) =>
  Effect.flatMap(hostRefuses, (refuses) =>
    refuses
      ? Effect.updateService(host, FileSystem.FileSystem, (fs) => ({
          ...fs,
          watch: (path) => Stream.die(`the host watched ${path}, and a host holds no file watch`),
        }))
      : host,
  );

const stopGrace = Config.Duration("COLLIE_HOST_STOP_GRACE").pipe(
  Config.withDefault(Duration.seconds(5)),
  Effect.orDie,
);
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;
// WARNING: Long enough for the log's next flush, which an exit does not wait for.
const LOG_FLUSH = "200 millis";

type StopReason = Data.TaggedEnum<{
  Asked: Record<never, never>;
  LockGone: Record<never, never>;
  WatchedGone: Record<never, never>;
  DoorGone: Record<never, never>;
}>;
const StopReason = Data.taggedEnum<StopReason>();
const stopSaid = StopReason.$match({
  Asked: () => "asked to stop",
  LockGone: () => "its lock is gone; stopping",
  WatchedGone: () => "the process it watches has exited; stopping",
  DoorGone: () => "its door has stopped; stopping",
});

const boundedStop = (dir: string, lock: string, checks: CheckProcessesApi) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const grace = yield* stopGrace;
    const stopping = yield* Deferred.make<StopReason>();
    const host = { pid: process.pid, started: (yield* processStarted(process.pid)) ?? "" };
    const context = yield* Effect.context<never>();
    let handed: { readonly build: string; readonly checks: ReadonlyArray<string> } | null = null;
    // WARNING: In the outer scope, which closes only once the shutdown it bounds has finished.
    yield* Deferred.await(stopping).pipe(
      Effect.flatMap((why) => Effect.logInfo(stopSaid(why))),
      Effect.andThen(
        Effect.suspend(() =>
          handed === null
            ? Effect.void
            : Schema.encodeEffect(HandedOverJson)({ ...handed, host }).pipe(
                Effect.flatMap((text) =>
                  fs
                    .writeFileString(`${handedOverOf(dir)}.new`, text)
                    .pipe(Effect.andThen(fs.rename(`${handedOverOf(dir)}.new`, handedOverOf(dir)))),
                ),
                Effect.andThen(
                  Effect.logInfo(
                    `handed ${handed.checks.length} check(s) over to collie ${handed.build}`,
                  ),
                ),
                Effect.ignore({ log: "Warn" }),
              ),
        ),
      ),
      Effect.andThen(
        endAllWithin(checks, grace, (ended) =>
          Effect.forEach(
            ended,
            (check) => Effect.logInfo(`ended check ${check.name} of ${check.run}`),
            { discard: true },
          ),
        ),
      ),
      Effect.andThen(Effect.logWarning(`still stopping after ${Duration.format(grace)}; exiting`)),
      Effect.andThen(Effect.sleep(LOG_FLUSH)),
      // WARNING: Released here, rather than left for the next host to judge stale.
      Effect.andThen(releaseOwnLock(lock)),
      Effect.catch((failed) =>
        Effect.fail(failed).pipe(
          Effect.ignore({ log: "Unhandled" }),
          Effect.andThen(Effect.sleep(LOG_FLUSH)),
        ),
      ),
      Effect.andThen(Effect.sync(() => process.exit(1))),
      Effect.forkScoped,
    );
    const signalled = () => {
      // WARNING: Decided as the signal lands, before an interrupted check's Scope can end it.
      const asked = handOverAsked(dir);
      if (asked !== null && asked.pid === process.pid && atLeast(asked.build, BUILD)) {
        handed = { build: asked.build, checks: Effect.runSyncWith(context)(checks.handOver) };
      }
      Deferred.doneUnsafe(stopping, Effect.succeed(StopReason.Asked()));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const signal of STOP_SIGNALS) {
          process.prependOnceListener(signal, signalled);
        }
      }),
      () =>
        Effect.sync(() => {
          for (const signal of STOP_SIGNALS) {
            process.off(signal, signalled);
          }
        }),
    );
    return (why: StopReason) => Deferred.succeed(stopping, why).pipe(Effect.asVoid);
  });

// WARNING: Read and removed at once: a signal handler must not wait.
const handOverAsked = (dir: string) => {
  try {
    const text = readFileSync(handOverAskedOf(dir), "utf8");
    rmSync(handOverAskedOf(dir), { force: true });
    return Option.getOrNull(Schema.decodeOption(HandOverAsked)(text));
  } catch {
    return null;
  }
};

// WARNING: Judged by the lock, not the directory: a host still starting recreates the directory.
const orphaned = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const watched = yield* Config.option(Config.Int("COLLIE_HOST_WATCH_PID")).pipe(
      Effect.orElseSucceed(() => Option.none<number>()),
    );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (;;) {
      yield* Effect.sleep("1 second");
      if (!(yield* fs.exists(lockOf(dir)).pipe(Effect.orElseSucceed(() => true)))) {
        return StopReason.LockGone();
      }
      if (Option.isSome(watched) && !alive(watched.value)) {
        return StopReason.WatchedGone();
      }
    }
  });

const locateIn: (install: { readonly pluginRoot: string; readonly userDir: string }) => Locate =
  (install) =>
  ({ project, id }) =>
    discover(searchPath({ ...install, project })).pipe(
      Effect.flatMap((found) => {
        const entry = Option.getOrUndefined(Arr.findFirst(found.entries, (one) => one.id === id));
        if (entry !== undefined) {
          return Effect.succeed({ entry: entry.path, revision: entry.revision });
        }
        const problem = Option.getOrUndefined(
          Arr.findFirst(found.problems, (one) => one.id === id),
        );
        return new HostRefused({
          reason:
            problem === undefined
              ? `no workflow "${id}" is saved for ${project}`
              : `${problem.path}: ${problem.message}`,
        });
      }),
    );

const isCrashPoint = Schema.is(
  Schema.Literals([
    "admitted",
    "executed",
    "answered",
    "reported",
    "recovery-park-cleared",
    "recovery-entered",
  ]),
);

const crashPoint = Config.option(Config.String("COLLIE_HOST_CRASH_AT")).pipe(
  Effect.map((set) => Option.filter(set, isCrashPoint).pipe(Option.getOrUndefined)),
  Effect.orDie,
);

const scheduleSeconds = Config.option(Config.String("COLLIE_HOST_SCHEDULE_SECONDS")).pipe(
  Effect.map((set) => Option.getOrUndefined(set) === "1"),
  Effect.orDie,
);

const supersedeGraceMs = Config.option(Config.Int("COLLIE_HOST_SUPERSEDE_GRACE_MS")).pipe(
  Effect.map(Option.getOrUndefined),
  Effect.orDie,
);

const own = (
  dir: string,
  checks: CheckProcessesApi,
  onceAnswering: Effect.Effect<void>,
  door: EngineEnd,
  model: Opened["model"],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = yield* currentEnv.pipe(Effect.orDie);
    const crashAt = yield* crashPoint;
    const graceMs = yield* supersedeGraceMs;
    const seconds = yield* scheduleSeconds;
    const bun = yield* Effect.context<PlatformServices>();
    const runModel = Option.getOrUndefined(yield* Effect.serviceOption(RunModel));
    const herdr = new Herdr(env);
    // WARNING: Under the lock, so the socket file is a dead host's: a unix socket cannot bind while its file exists.
    yield* fs.remove(socketOf(dir), { force: true }).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => fs.remove(socketOf(dir), { force: true }).pipe(Effect.ignore));
    const pid = yield* currentPid;
    const started = yield* processStarted(pid);
    const record = (herd: string | null) =>
      fs.writeFileString(
        recordOf(dir),
        encodeRecord({ pid, build: BUILD, root: env.pluginRoot, herd, started }),
      );
    const herdSocket = yield* coreSocket(env.raw);
    yield* record(herdSocket).pipe(Effect.orDie);
    const installation = yield* installationOf(dir).pipe(Effect.orDie);
    const installed = yield* installedRelease(env.pluginRoot, env.collieDir, BUILD);
    const development: Development = installed.release ? {} : { development: installed.build };
    door.open({
      socket: socketOf(dir),
      env: { ...env, stateDir: dir },
      identity: {
        build: BUILD,
        pid,
        dir,
        root: env.pluginRoot,
        ...development,
        protocol: PROTOCOL,
        installation,
      },
      model,
    });
    const usage = yield* Usage;
    const harnesses = yield* HarnessCatalogues;
    const catalogue = Effect.map(harnesses.catalogues, (harnesses) => ({
      machine: machineName(),
      harnesses,
    }));
    const panels: MrPanels = new Map();
    const declared: Declared = new Map();
    const stamp = yield* (yield* SecureRandom.SecureRandom).uuidV4();
    const toasted = yield* PubSub.unbounded<Toasted>();
    const reconnects = yield* Ref.make(0);
    // WARNING: Kept until the reports layer takes them, so a link up before it starts is not missed.
    const linked = yield* Queue.unbounded<Peer>();
    const peers = yield* startPeers({
      reconnected: Ref.update(reconnects, (count) => count + 1),
      dir,
      userDir: env.userDir,
      build: BUILD,
      ...development,
      connect: (peer) =>
        connectPeer(dir, peer.name, { as: "host", client: machineName(), stamp }).pipe(
          Effect.map((client) => ({
            ...client,
            identity: client.identity(),
            settings: client.settings(),
            sharedDefinitions: client.sharedDefinitions(),
          })),
        ),
      installation,
      stamp,
      socket: socketOf(dir),
      machines: herdr.machineList().pipe(
        Effect.map((machines) => {
          const returned: ReadonlyArray<SshMachine> = machines;
          return returned;
        }),
        Effect.orElseSucceed(() => null),
        Effect.provideContext(bun),
      ),
      linked: (peer) => Queue.offer(linked, peer).pipe(Effect.asVoid),
      tell: (peer) =>
        Effect.scoped(
          connectPeer(dir, peer.name, { as: "host", client: machineName(), stamp }).pipe(
            Effect.flatMap((client) => client.forget()),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`could not tell ${peer.name} it was forgotten: ${reason(cause)}`),
          ),
          Effect.provideContext(bun),
        ),
    });
    // WARNING: scoped as Layer.launch is, so a stop ends the server before the rest of the host.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(
          RpcServer.layer(AllRpcs.middleware(SlowRpcs)).pipe(
            Layer.provide(
              Layer.mergeAll(
                handlers(dir, installation, development, declared, peers),
                frontDoorHandlers(
                  dir,
                  installation,
                  development,
                  panels,
                  declared,
                  stamp,
                  toasted,
                  Ref.get(reconnects),
                  peers.userDirMoved,
                ),
                sideJobsLayer(panels),
                doorFeedLayer(door, panels),
                questionsLayer,
                slowRpcsLayer,
                Layer.effectDiscard(
                  Effect.gen(function* () {
                    const { reportsLayer } = yield* Effect.promise(() => import("./reports"));
                    yield* Layer.build(
                      reportsLayer({ env, installation, stamp, crashAt, linked, live: peers.live }),
                    );
                  }),
                ),
              ).pipe(
                Layer.provide(sharedBoardLayer(dir)),
                Layer.provide(
                  Layer.mergeAll(
                    schedulesLayer({
                      dir,
                      env: { ...env, stateDir: dir },
                      installation,
                      seconds,
                    }).pipe(
                      Layer.provideMerge(
                        registryLayer(dir, {
                          catalogue,
                          locate: locateIn(env),
                          userDir: env.userDir,
                          crashAt,
                          supersedeGraceMs: graceMs,
                          namesTasks: true,
                          placing: { herdr, env: { ...env, stateDir: dir } },
                          keep:
                            runModel === undefined
                              ? undefined
                              : { revision: runModel.factsAt, reading: runModel.reading },
                        }),
                      ),
                    ),
                    Layer.succeed(Usage, usage),
                    Layer.succeed(HarnessCatalogues, harnesses),
                  ),
                ),
              ),
            ),
            Layer.provide(door.protocol),
            Layer.provide(
              (yield* configuredAgents(dir, usage.readings, catalogue)).pipe(
                Layer.provideMerge(
                  foundationLayer({
                    dir,
                    userDir: env.userDir,
                    toast: (title, body, sound, runId) =>
                      PubSub.publish(toasted, { runId, title, body, sound }).pipe(Effect.asVoid),
                    herd: { socketPath: herdSocket, pluginRoot: env.pluginRoot },
                    readings: usage.readings,
                    messagePoll: seconds ? "1 second" : undefined,
                  }).pipe(Layer.provideMerge(Layer.succeed(CheckProcesses, checks))),
                ),
              ),
            ),
            Layer.provide(forgeHttpLayer),
            Layer.tap(() => Effect.forkScoped(onceAnswering)),
          ),
        );
        // WARNING: from now the engine answers a board; until now the door answered from the projection.
        door.post({ _tag: "Serving" });
        return yield* Effect.never;
      }),
    );
  }).pipe(Effect.provide([usageLayer, catalogueLayer(dir)]), Effect.orDie);

// WARNING: A newer host is reported, not replaced: the client is what is stale.
export const connect: (
  dir: string,
  options?: {
    readonly build?: string;
    readonly hostEnv?: Readonly<Record<string, string>>;
  },
) => Effect.Effect<
  HostClient,
  HostUnavailable | HostVersionMismatch,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> = (dir, options?) =>
  Effect.gen(function* () {
    const build = options?.build ?? BUILD;
    const hostEnv = options?.hostEnv ?? {};
    let who = yield* ensureRunning(dir, hostEnv, build);
    // WARNING: Only a newer copy of the same installation upgrades the host; a dev checkout is not one.
    const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
    const ours = who.root === undefined || sameInstallation(who.root, install);
    const replaced = ours && newer(build, who.build);
    if (replaced) {
      yield* replaceOwner(dir, who.pid, build);
      who = yield* ensureRunning(dir, hostEnv, build);
    }
    if (who.build !== build) {
      return yield* new HostVersionMismatch({
        dir,
        host: who.build,
        client: build,
        pid: who.pid,
        restart: newer(who.build, build)
          ? newerHostSaid(dir, who.build, build)
          : ours
            ? `the host for ${dir} is collie ${who.build} and this is ${build}: run \`collie host restart\` and run this again`
            : `the host for ${dir} serves ${who.root} and this is collie ${build} from ${install}: point COLLIE_STATE_DIR at a directory of its own`,
      });
    }
    return yield* open(dir);
  });

export interface HostSeen {
  readonly pid: number;
  readonly build: string | null;
}

export const restartHost = Effect.fn("Host.restart")(function* (
  dir: string,
  options?: { readonly build?: string; readonly hostEnv?: Readonly<Record<string, string>> },
) {
  const owner = yield* liveOwner(dir);
  const build = options?.build ?? BUILD;
  let before: HostSeen | null = null;
  if (owner !== null) {
    const answered = yield* ask(dir).pipe(Effect.option);
    const seen =
      Option.match(answered, {
        onNone: () => null,
        onSome: (who) => ({ build: who.build, root: who.root }),
      }) ?? (yield* recordedOwnerWithin(dir, owner));
    before = { pid: owner.pid, build: seen?.build ?? null };
    if (seen === null) {
      return yield* unavailable(
        dir,
        `pid ${owner.pid} owns the directory and has not said which build it is`,
      );
    }
    if (newer(seen.build, build)) {
      return yield* new HostVersionMismatch({
        dir,
        host: seen.build,
        client: build,
        pid: owner.pid,
        restart: newerHostSaid(dir, seen.build, build),
      });
    }
    const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
    const ours = seen.root === undefined || sameInstallation(seen.root, install);
    const upgrades = newer(build, seen.build);
    if (atLeast(build, seen.build) && (ours || upgrades)) {
      yield* replaceOwner(dir, owner.pid, build);
    } else {
      yield* stopOwner(dir, owner.pid);
    }
  }
  const who = yield* ensureRunning(dir, options?.hostEnv ?? {}, build);
  return { before, after: { pid: who.pid, build: who.build } };
});

export const restartSaid = (
  dir: string,
  restarted: { readonly before: HostSeen | null; readonly after: HostSeen },
) => {
  const named = (host: HostSeen) =>
    `pid ${host.pid} (${host.build === null ? "build unknown" : `collie ${host.build}`})`;
  return restarted.before === null
    ? `No host was running for ${dir}; started ${named(restarted.after)}.`
    : `Restarted the host for ${dir}: ${named(restarted.before)} → ${named(restarted.after)}.`;
};

const STOP_SLACK = Duration.seconds(5);

// WARNING: Waits by the clock, not a poll count, so load cannot stretch it.
const stopOwner = Effect.fn("Host.stopOwner")(function* (dir: string, pid: number) {
  const goneWithin = (duration: Duration.Input) =>
    liveOwner(dir).pipe(
      Effect.repeat({
        until: (owner) => owner?.pid !== pid,
        schedule: Schedule.spaced("100 millis"),
      }),
      Effect.timeoutOption(duration),
      Effect.map(Option.isSome),
    );
  yield* signalProcess(pid, "SIGTERM");
  if (yield* goneWithin(Duration.sum(yield* stopGrace, STOP_SLACK))) {
    return;
  }
  yield* signalProcess(pid, "SIGKILL");
  if (yield* goneWithin(STOP_SLACK)) {
    return;
  }
  return yield* unavailable(dir, `pid ${pid} owns the directory and did not stop`);
});

const replaceOwner = (dir: string, pid: number, build: string) =>
  askHandOver(dir, pid, build).pipe(
    Effect.andThen(stopOwner(dir, pid)),
    Effect.ensuring(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(handOverAskedOf(dir), { force: true })),
        Effect.ignore,
      ),
    ),
  );

const FOLLOW_FOR = "2 minutes";

type VerifyEventOf = typeof VerifyEvent.Type;
type Followed<E, D> = E | D | HostRefused | HostUnavailable | RpcClientError.RpcClientError;

export const followVerify: <E, R, D>(
  dir: string,
  events: Stream.Stream<VerifyEventOf, E, R>,
  declare: (client: HostClient) => Effect.Effect<unknown, D>,
) => Stream.Stream<VerifyEventOf, Followed<E, D>, R> = <E, R, D>(
  dir: string,
  events: Stream.Stream<VerifyEventOf, E, R>,
  declare: (client: HostClient) => Effect.Effect<unknown, D>,
) =>
  Stream.suspend(() => {
    let check: string | null = null;
    return events.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event._tag === "Started") {
            check = event.check;
          }
        }),
      ),
      Stream.catchCause((cause) => {
        const taken = check;
        const returned: Stream.Stream<VerifyEventOf, Followed<E, D>> = taken === null ||
        Option.exists(Cause.findErrorOption(cause), Schema.is(HostRefused))
          ? Stream.failCause(cause)
          : Stream.unwrap(
              open(dir).pipe(
                Effect.tap(declare),
                Effect.map((client) => client.verifyFollow({ check: taken })),
              ),
            ).pipe(
              Stream.retry(
                Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: FOLLOW_FOR })),
              ),
            );
        return returned;
      }),
    );
  });

const openGroup = <Rpcs extends Rpc.Any>(
  socket: string,
  group: RpcGroup.RpcGroup<Rpcs>,
  through: Layer.Layer<Socket.Socket, Socket.SocketError> = BunSocket.layerNet({ path: socket }),
) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(Layer.provide(through), Layer.provide(serialization)),
    );
    return yield* RpcClient.make(group).pipe(Effect.provideContext(context));
  }).pipe(Effect.mapError((cause) => unavailable(socket, String(cause))));

const open = (dir: string) => openGroup(socketOf(dir), AllRpcs);

// WARNING: Nothing is started or stopped from here, so a remote client cannot reach a process of its own.
export const frontDoor = (socket: string) => openGroup(socket, FrontDoorRpcs);

export const peerChannel = (stateDir: string, name: string, header: RelayHeader) =>
  Effect.acquireRelease(
    Effect.callback<NetSocket, HostUnavailable | MachineUnreachable>((resume) => {
      const path = relayOf(stateDir, name);
      const conn = createConnection(path);
      let seen = Buffer.alloc(0);
      const take = (chunk: Buffer) => {
        seen = Buffer.concat([seen, chunk]);
        const end = seen.indexOf(10);
        if (end === -1) {
          return;
        }
        conn.off("data", take);
        conn.pause();
        const line = seen.subarray(0, end).toString("utf8");
        const answer = decodeAnswer(line);
        if (Option.isNone(answer) || (!answer.value.ok && answer.value.unreachable === undefined)) {
          conn.destroy();
          const said = Option.isSome(answer) ? (answer.value.refused ?? line) : line;
          return resume(Effect.fail(unavailable(path, `the relay to ${name} refused: ${said}`)));
        }
        if (!answer.value.ok) {
          conn.destroy();
          const { unreachable, waits } = answer.value;
          return resume(
            Effect.fail(
              waits === undefined
                ? new MachineUnreachable({ machine: name, seen: unreachable! })
                : new MachineUnreachable({ machine: name, seen: unreachable!, waits }),
            ),
          );
        }
        const rest = seen.subarray(end + 1);
        if (rest.length > 0) {
          conn.unshift(rest);
        }
        resume(Effect.succeed(conn));
      };
      conn.on("data", take);
      conn.once("connect", () => conn.write(`${encodeHeader(header)}\n`));
      conn.once("error", (cause) =>
        resume(
          Effect.fail(
            unavailable(path, `${name} is not paired with this Machine: ${cause.message}`),
          ),
        ),
      );
      conn.once("close", () =>
        resume(Effect.fail(unavailable(path, `the relay to ${name} hung up`))),
      );
      return Effect.sync(() => conn.destroy());
    }),
    (conn) => Effect.sync(() => conn.destroy()),
  );

const encodeHeader = Schemaflow(Schema.encodeResult(RelayHeaderJson), Result.getOrThrow);

export const connectPeer: (
  stateDir: string,
  name: string,
  header: RelayHeader,
  options?: { readonly build?: string },
) => Effect.Effect<
  HostClient,
  HostUnavailable | HostVersionMismatch | MachineUnreachable,
  Scope.Scope
> = (stateDir, name, header, options?) => {
  const build = options?.build ?? BUILD;
  let mismatch: HostVersionMismatch | undefined;
  let hereIsRelease: boolean | undefined;
  return Effect.gen(function* () {
    const conn = yield* peerChannel(stateDir, name, header);
    const socket = yield* BunSocket.fromDuplex(Effect.succeed(conn));
    const client = yield* openGroup(
      relayOf(stateDir, name),
      AllRpcs,
      Layer.succeed(Socket.Socket, socket),
    );
    const who = yield* client.identity().pipe(
      Effect.timeoutOrElse({
        duration: ASK_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new MachineUnreachable({ machine: name, seen: `no answer within ${ASK_TIMEOUT}` }),
          ),
      }),
      Effect.mapError((cause) =>
        Schema.is(MachineUnreachable)(cause) ? cause : unavailable(stateDir, reason(cause)),
      ),
    );
    if (who.build !== build && header.as !== "host") {
      return yield* new HostVersionMismatch({
        development: who.development,
        dir: who.dir,
        host: who.build,
        client: build,
        pid: who.pid,
        restart:
          who.development !== undefined
            ? `${name} runs a development checkout of collie (${who.development}) and this is ${build}; nothing upgrades a development checkout`
            : `${name} runs collie ${who.build} and this is ${build}`,
      });
    }
    return client;
  }).pipe(
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        if (cause instanceof HostVersionMismatch) {
          mismatch = cause;
          hereIsRelease ??= yield* isRelease(stateDir);
        }
      }),
    ),
    // WARNING: Only a release's host upgrades the far one (levelPeer), so only then is a wait rewarded.
    Effect.retry({
      while: () =>
        hereIsRelease === true &&
        mismatch !== undefined &&
        mismatch.development === undefined &&
        RELEASE_TAG.test(build) &&
        RELEASE_TAG.test(mismatch.host) &&
        newer(build, mismatch.host),
      schedule: Schedule.spaced("200 millis"),
    }),
    Effect.timeoutOrElse({
      duration: REACH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          mismatch ??
            new MachineUnreachable({
              machine: name,
              seen: `no answer within ${Duration.format(REACH_TIMEOUT)}`,
            }),
        ),
    }),
  );
};

const unavailable = (dir: string, reason: string) => new HostUnavailable({ dir, reason });

const isRelease = (dir: string) =>
  Effect.scoped(open(dir).pipe(Effect.flatMap((client) => client.identity()))).pipe(
    Effect.map((who) => who.development === undefined),
    Effect.orElseSucceed(() => true),
  );

export const herdOfHost = Effect.fn("Host.herdOfHost")(function* (dir: string) {
  const owner = yield* liveOwner(dir);
  if (owner === null) {
    return undefined;
  }
  const recorded = yield* (yield* FileSystem.FileSystem)
    .readFileString(recordOf(dir))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostRecord)), Effect.option);
  return Option.isSome(recorded) && recorded.value.pid === owner.pid
    ? recorded.value.herd
    : undefined;
});

export const ownerOf: (
  dir: string,
) => Effect.Effect<LockHolder | null, never, FileSystem.FileSystem> = (dir) =>
  lockHolder(lockOf(dir));

const liveOwner = (dir: string) =>
  ownerOf(dir).pipe(
    Effect.flatMap((owner) =>
      owner === null
        ? Effect.succeed(null)
        : Effect.map(holderLives(owner), (lives) => (lives ? owner : null)),
    ),
  );

const HOST_START_TIMEOUT = "30 seconds";
const ASK_TIMEOUT = "5 seconds";
const REACH_TIMEOUT = Duration.sum(
  Duration.fromInputUnsafe(LADDER_BOUND),
  Duration.fromInputUnsafe(ASK_TIMEOUT),
);

const recordedOwnerOf = Effect.fn("Host.recordedOwner")(function* (dir: string, owner: LockHolder) {
  const fs = yield* FileSystem.FileSystem;
  const recorded = yield* fs
    .readFileString(recordOf(dir))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostRecord)), Effect.option);
  if (Option.isNone(recorded)) {
    return null;
  }
  const { pid, build, root, started } = recorded.value;
  const identified = started !== null && started !== undefined && started === owner.start;
  return pid === owner.pid && identified ? { build, root } : null;
});

// WARNING: A successor takes the lock before it writes its record, and may already have adopted a check.
const recordedOwnerWithin = (dir: string, owner: LockHolder) =>
  recordedOwnerOf(dir, owner).pipe(
    Effect.repeat({
      until: (seen) => seen !== null,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeoutOption(ASK_TIMEOUT),
    Effect.map(Option.getOrNull),
  );

const sameInstallation = (served: string, install: string) =>
  served === install || install === `${served}/release`;

// WARNING: Asking is the whole probe: a socket that opens proves a file, and only an answer proves a host.
const ensureRunning = Effect.fn("Host.ensureRunning")(function* (
  dir: string,
  hostEnv: Readonly<Record<string, string>>,
  build: string,
) {
  const first = yield* ask(dir).pipe(Effect.result);
  if (first._tag === "Success") {
    return first.success;
  }
  const owner = yield* liveOwner(dir);
  const silent = owner === null ? null : yield* recordedOwnerOf(dir, owner);
  if (owner !== null && silent !== null) {
    if (newer(silent.build, build)) {
      return yield* new HostVersionMismatch({
        dir,
        host: silent.build,
        client: build,
        pid: owner.pid,
        restart: newerHostSaid(dir, silent.build, build),
      });
    }
    const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
    if (newer(build, silent.build) && sameInstallation(silent.root, install)) {
      // WARNING: Too slow to answer is not gone: it still hears its signal and hands its checks over.
      yield* replaceOwner(dir, owner.pid, build);
    }
  }
  const started = Effect.scoped(
    Effect.gen(function* () {
      const host = yield* spawnHost(dir, hostEnv);
      const coming = Effect.all([
        host.isRunning.pipe(Effect.orElseSucceed(() => true)),
        liveOwner(dir),
      ]).pipe(Effect.map(([running, owner]) => running || owner !== null));
      return yield* ask(dir).pipe(
        Effect.retry({ schedule: Schedule.spaced("100 millis"), while: () => coming }),
      );
    }),
  );
  return yield* started.pipe(
    Effect.retry({ times: 2, while: () => Effect.map(liveOwner(dir), (owner) => owner === null) }),
    Effect.timeoutOrElse({ duration: HOST_START_TIMEOUT, orElse: () => diagnose(dir) }),
    Effect.catch(() => diagnose(dir)),
  );
});

const ask = (dir: string) =>
  Effect.scoped(open(dir).pipe(Effect.flatMap((client) => client.identity()))).pipe(
    Effect.timeoutOrElse({
      duration: ASK_TIMEOUT,
      orElse: () => unavailable(dir, `no answer on ${socketOf(dir)} within ${ASK_TIMEOUT}`),
    }),
  );

const diagnose = Effect.fn("Host.diagnose")(function* (dir: string) {
  const owner = yield* liveOwner(dir);
  return yield* unavailable(
    dir,
    owner === null
      ? "no host started, and nothing owns the directory"
      : `pid ${owner.pid} owns the directory and is not answering on ${socketOf(dir)}`,
  );
});

// WARNING: Detached and unreferenced: the host must outlive whoever started it.
const spawnHost = Effect.fn("Host.spawn")(function* (
  named: string,
  hostEnv: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const command = yield* hostCommand;
  const env = yield* currentEnv.pipe(Effect.orDie);
  const { pluginRoot, userDir } = env;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(named, { recursive: true });
    // WARNING: Resolved before the host starts in it, so a relative path would name somewhere else.
    const dir = yield* fs.realPath(named);
    yield* rotateInPlace(outputOf(dir));
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/sh",
        [
          "-c",
          'out=$1; shift; exec "$@" >>"$out" 2>&1',
          "sh",
          outputOf(dir),
          ...command,
          "host",
          "--dir",
          dir,
        ],
        {
          cwd: dir,
          // WARNING: A client started by Desktop may carry its launcher's LD_PRELOAD.
          env: withoutLauncher(
            withoutHerdrOne({
              ...process.env,
              ...hostEnv,
              COLLIE_ROOT: pluginRoot,
              COLLIE_USER_DIR: userDir,
            }),
          ),
          extendEnv: false,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    );
    // WARNING: Unreferenced before the caller's scope closes, or the spawner's finalizer kills the host.
    yield* Effect.asVoid(handle.unref);
    return handle;
  }).pipe(Effect.catch((cause) => unavailable(named, String(cause))));
});

const CommandJson = Schema.fromJsonString(Schema.Array(Schema.String));

const hostCommand: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
  const override = yield* Config.option(Config.String("COLLIE_HOST"));
  if (override._tag === "Some") {
    const value = override.value;
    if (!pipe(Str.trimStart(value), Str.startsWith("["))) {
      return [value];
    }
    return yield* Schema.decodeEffect(CommandJson)(value).pipe(Effect.orElseSucceed(() => [value]));
  }
  // WARNING: A compiled binary's entry lives under /$bunfs: passing that path would be read as a subcommand.
  return pipe(Bun.main, Str.startsWith("/$bunfs/"))
    ? [process.execPath]
    : [process.execPath, Bun.main];
}).pipe(Effect.orDie);
