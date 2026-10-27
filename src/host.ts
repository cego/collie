// The one local host per state directory: who owns it, how a client reaches it, and what
// it answers.
//
// A workflow outlives the thing that started it. The CLI exits when it has said what it
// came to say, a board is closed with a keystroke, and a chat turn ends — none of that is
// a reason for accepted work to stop. So the engine runs in a host of its own, started by
// whoever needs it first and shared by everyone after: one SQLite file, one set of
// registrations, one owner.
//
// Ownership is the pid lock every other long-lived thing here uses, so a host that
// crashed is recovered and a live process that merely inherited its pid is never touched.
// The protocol is Effect's own RPC over a unix socket in that same directory: schemas
// both ends share rather than a wire format of Collie's, and nothing listening off this
// machine. `docs/adr/0015-one-local-host-owns-a-state-directory.md` is why each of those
// is the way it is.

import { createConnection, type Socket as NetSocket } from "node:net";
import { withdrawStepNote } from "./step-steering";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import type { BunServices } from "@effect/platform-bun/BunServices";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import {
  Clock,
  Config,
  Context,
  Crypto,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Queue,
  Result,
  Path,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  Struct,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Socket from "effect/socket/Socket";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import manifest from "../herdr-plugin.toml";
import {
  EntryError,
  REFUSED_INPUT,
  Registrations,
  RunStatus,
  RunView,
  Steered,
  foundationLayer,
  registryLayer,
  Registry,
  Reliance,
  runDir,
  evidenceDir,
  STOP,
  controlPath,
  type HostServices,
  type Locate,
} from "./engine";
import { RequestedBy } from "./board-model";
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
import { removedNotice, scrub, scrubJson } from "./redact";
import { readMetrics } from "./metrics";
import { readCards } from "./cards";
import {
  CheckProcesses,
  endAllWithin,
  hostCheckProcesses,
  type CheckProcessesApi,
  type Leftover,
  type LeftoverEnd,
} from "./check-processes";
import { readDrift } from "./drift";
import {
  readIntent,
  amend,
  verificationGrant,
  writeIntentHeld,
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
import { QUESTIONS } from "./compactors";
import { Catalogue, discover, searchPath } from "./discovery";
import { readDefinitions } from "./authoring";
import { SharedDefinition } from "./definitions-model";
import { DefinitionRefused, sharedDefinitions, takeDefinitions } from "./shared-definitions";
import { sideJobs } from "./side-jobs";
import { Usage, usageLayer } from "./usage";
import { Schedules, schedulesLayer } from "./schedules";
import { dataHomeOf, desktopRootOf } from "./desktop";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import {
  collieCache,
  checksSweeper,
  compactionSweeper,
  desktopSweeper,
  renovateClonesSweeper,
  retentionSweeper,
  runnersSweeper,
  settlingOf,
  stateSweeper,
  uploadsSweeper,
  taskWorkspacesSweeper,
  idleAgentsSweeper,
  noteIdle,
  type FinishedSince,
  type IdleSince,
  generationsDir,
  generationsSweeper,
  judge,
  sweepAsked,
  worktreesSweeper,
  type SweptBy,
} from "./cleanup";
import { startedOf } from "./automode";
import { once, readAudit, recordAudit, startedBy, trimAudit, whoActed, actorOf } from "./audit";
import { usagePhrase } from "./usage-model";
import { currentEnv, leaveLauncher, withoutLauncher } from "./env";
import { installation as installedRelease, RELEASE_TAG } from "./release";
import { Herdr, isSettled, type AgentInfo } from "./herdr";
import { serverSocket } from "./home";
import { buildBoard, mrOf, taskFlowOf } from "./board";
import { readForge, watchedMr, type MrPanels } from "./merges";
import { shell } from "./mr";
import { ForgeHttp, forgeHttpLayer } from "./forge/http";
import { fetchRef, followDetail } from "./run-detail";
import { buildRunDetail, type PlanCache } from "./views";
import {
  Answered,
  ASKED_KINDS,
  RunAgent,
  Flow,
  Controlled,
  Disposition,
  Seen,
  FrontDoorRpcs,
  HostRefused,
  NewsBatch,
  PaneAt,
  SharedSettings,
  ShellResult,
  PROTOCOL,
  mrLabel,
  readinessOfRun,
  ProposalRefused,
  PART_BYTES,
  RequestConflict,
  Started,
  SteerOutcome,
  Attachments,
  type FrontDoor,
  type TaskView,
  type Where,
} from "./board-model";
import {
  attachedLine,
  attachmentRefusal,
  attachmentsDir,
  copyInto,
  namesIn,
  sha256Hex,
  type Attached,
} from "./attachments";
import { boardMessages, shareBoard } from "./board-stream";
import { recordDisposition } from "./disposition";
import { markSeenSince, readSeen, recordSeen } from "./seen";
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
import { clearOverride, err, request, steer, type OpResult } from "./operations";
import { REJECTED } from "./envelope";
import {
  appendLine,
  deliveriesOf,
  DeliverySchema,
  herdDir,
  herdOf,
  readLedger,
  reconcile as reconcileDelivery,
} from "./steering";
import {
  actorName,
  answeredBy,
  decline,
  journalOf,
  read as readProposals,
  reconcileStep,
  stepResults,
  type ProposalLine,
  type ProposalRecord,
  voiceOf,
  type Asker,
  type Voice,
} from "./proposals";
import { carryOut, carryOutAsked, followUpField } from "./run-actions";
import { VerifySpecSchema } from "./verify-spec";
import { everyRegistered } from "./registry";
import { listTasks, readTask } from "./task";
import { epochMs, nowIso } from "./time";
import { appendLog } from "./oversight";
import { VERIFYING_FILE, verifyingIn } from "./verify";
import { reason } from "./naming";
import { editString, globFiles, grepFiles, readPart, writeWhole } from "./host-files";
import { receive, uploadsDir } from "./uploads";
import { loadDefaults, SettingRefused, sharedSettings, takeShared } from "./config";
import {
  decodeAnswer,
  machineName,
  peersOf,
  relayOf,
  runShell,
  startPeers,
  type Peers,
} from "./peers";
import { RunLinkNotice, readRunLinks, recordRunLink } from "./run-links";
import type { SshMachine } from "./ssh-connection";
import { LADDER_BOUND } from "./peer-transport";
import {
  Invited,
  MachineUnreachable,
  Peer,
  PeerView,
  RelayHeaderJson,
  type RelayHeader,
} from "./peers-model";
import { latest, readDispositions } from "./disposition";
import { operationsOf, readLaunches, runAgents } from "./launches";
import { factsOfView, settled, type RunFacts } from "./runs";
import { Store } from "./store";
import { SESSIONS_EVERY, agentsIn, focusPane, herdChanges, liveHerds } from "./herds";
import {
  withDirLock,
  currentPid,
  ensureLockDir,
  holderLives,
  hostLockOf,
  lockHolder,
  releaseOwnLock,
  signalProcess,
  withLock,
  type LockHolder,
} from "./lock";

/** What a host says it is. A client that is not this stops rather than guessing. */
export const BUILD: string = manifest.version;

export const socketOf = (dir: string) => `${dir}/host.sock`;
const lockOf = hostLockOf;
const logOf = (dir: string) => `${dir}/host.log`;
/** What a spawned host writes to its stdout and stderr. */
export const outputOf = (dir: string) => `${dir}/host.out`;
/** Which build owns the directory, written down for a client the host does not answer. */
const recordOf = (dir: string) => `${dir}/host.build`;
const HostRecord = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    build: Schema.String,
    root: Schema.String,
    /** The herdr socket naming its Herd; absent from a host older than this field. */
    herd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const encodeRecord = Schema.encodeSync(HostRecord);

/** Whether `build` is a newer release than `than`. */
const newer = (build: string, than: string) =>
  build !== than && Bun.semver.order(build, than) === 1;

export class HostUnavailable extends Data.TaggedError("HostUnavailable")<{
  readonly dir: string;
  readonly reason: string;
}> {}

/**
 * The host running here is a different build of Collie. Upgrading replaces the binary but
 * not the process that is already running, and the two need not agree about anything —
 * so the client says so and stops, rather than sending a request the host may read
 * differently or taking the directory away from work that is still running.
 */
export class HostVersionMismatch extends Data.TaggedError("HostVersionMismatch")<{
  readonly dir: string;
  readonly host: string;
  readonly client: string;
  readonly pid: number;
  readonly restart: string;
  readonly development?: string;
}> {}

const Identity = Schema.Struct({
  build: Schema.String,
  pid: Schema.Int,
  dir: Schema.String,
  /** The installation it serves; absent from a host older than the field. */
  root: Schema.optionalKey(Schema.String),
  /** `<version>+<sha>` for a development checkout; absent for a release. */
  development: Schema.optionalKey(Schema.String),
  /** The board protocol it speaks; absent from a host older than the field. */
  protocol: Schema.optionalKey(Schema.Int),
  /** The state directory's own id; absent from a host older than the field. */
  installation: Schema.optionalKey(Schema.String),
});

const RunShown = Schema.Struct({
  view: RunView,
  agents: Schema.Array(RunAgent),
  disposition: Schema.NullOr(Disposition),
  children: Schema.Array(RunView),
  startedBy: Schema.optional(Schema.String),
  /** The handoff notes its agents left, where they are on the host's Machine. Absent from an older host. */
  handoffs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, bytes: Schema.Int })),
  ),
  /** What of it waits for memory, as the card says it. Absent from an older host. */
  memory: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The same Flow as its details carry. Absent from an older host. */
  flow: Schema.optionalKey(Schema.NullOr(Flow)),
});

const Loaded = Schema.Struct({
  id: Schema.String,
  registration: Schema.String,
  title: Schema.String,
});

/** A result that says what kind of credential-shaped value was taken out of its asking. */
const saying =
  (removed: ReadonlyArray<string>) =>
  <A extends object>(result: A): A & { readonly redacted?: ReadonlyArray<string> } =>
    removed.length === 0 ? result : { ...result, redacted: [...removed] };

/** A steer's outcome, telling its asker what kind of credential-shaped value was taken out. */
const outcomeSaying = (removed: ReadonlyArray<string>, outcome: SteerOutcome): SteerOutcome => {
  const notice = removedNotice(removed);
  return notice === null
    ? outcome
    : { ...outcome, human: `${outcome.human}\n${notice}`, redacted: [...removed] };
};

/**
 * What a client may ask of a host. Both ends read these declarations, so a request is a
 * value with a schema at each hop rather than a shape one side remembers.
 */
export const HostRpcs = RpcGroup.make(
  Rpc.make("identity", { success: Identity }),
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
  // Which project is asking, because the answer differs: an override is one project's
  // and the host serves them all.
  Rpc.make("discover", { payload: { project: Schema.String }, success: Catalogue }),
  Rpc.make("status", {
    payload: { runId: Schema.String },
    success: RunStatus,
    error: HostRefused,
  }),
  // The read model both front doors show. A run whose module is missing is still here,
  // with the file to repair named, rather than an error where its history was.
  Rpc.make("run", { payload: { runId: Schema.String }, success: Schema.NullOr(RunView) }),
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
  Rpc.make("runs", {
    payload: { task: Schema.NullOr(Schema.String) },
    success: Schema.Array(RunView),
  }),
  // The same run, again, whenever it changes — and current when the stream opens, so a
  // client that was away reads where the work is rather than what it missed.
  Rpc.make("watch", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunView),
    stream: true,
  }),
  /** Registers what current files now allow and hands over what is outstanding. */
  Rpc.make("recover", { success: Registrations }),
  /** One command Collie may run for a run, granted or, with no command, withdrawn. */
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
  /** A human's own words to the agent this run has, through the one sender. */
  Rpc.make("steer", {
    payload: {
      runId: Schema.String,
      text: Schema.String,
      request: Schema.String,
      step: Schema.optional(Schema.String),
      /** A role (`builder`, `reviewer`, `planner`), an agent or an operation. */
      to: Schema.optional(Schema.String),
      operation: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
      mode: Schema.optional(Schema.Literals(["boundary", "now", "interrupt"])),
      attachments: Schema.optional(Attachments),
    },
    success: Steered,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
  /** A Run as `run show` prints it: the read model, its agents, what became of it, its children. */
  Rpc.make("shown", { payload: { runId: Schema.String }, success: Schema.NullOr(RunShown) }),
  /** Pairs this Machine with the installation asking, over the SSH login that asked. */
  Rpc.make("invite", {
    payload: { for: Schema.String, name: Schema.String, address: Schema.NullOr(Schema.String) },
    success: Invited,
    error: HostRefused,
  }),
  /** Keeps a pairing this Machine made with a peer it dials. */
  Rpc.make("pair", { payload: { peer: Peer }, success: Schema.Void, error: HostRefused }),
  /** The peer asking has forgotten this Machine, so this one forgets it too. */
  Rpc.make("forget", { success: Schema.Void, error: HostRefused }),
  Rpc.make("peers", { success: Schema.Array(PeerView) }),
  /** Ends the backoff of this Machine's link to the one it dials by that name. */
  Rpc.make("wake", { payload: { machine: Schema.String } }),
  Rpc.make("agentRun", {
    payload: { agent: Schema.String },
    success: Schema.NullOr(Schema.String),
  }),
);

/** Everything this build serves; a client of another build uses `FrontDoorRpcs` alone. */
const AllRpcs = HostRpcs.merge(FrontDoorRpcs);

/** How long an RPC may take to answer before the host log says so. */
const SLOW_RPC_MS = 2_000;

/** Logs an RPC slow to answer. A stream is meant to stay open, so it is never timed. */
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
              if (took > SLOW_RPC_MS)
                yield* Effect.logWarning(`the ${rpc._tag} RPC took ${took} ms to answer`);
            }),
          ),
        );
      }),
);

export type HostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof AllRpcs>,
  RpcClientError.RpcClientError
>;

const serialization = RpcSerialization.layerNdjson;

/** What each connection declared, which every operation it asks is recorded under. */
// ponytail: one entry per connection, never removed; prune on disconnect if hosts live for months.
type Declared = Map<
  number,
  { readonly frontDoor: FrontDoor; readonly from?: Where | undefined; readonly voice?: Voice }
>;

/** What an operation on this connection is recorded as: `cli` where it declared nothing. */
const stampIn = (declared: Declared, client: { readonly id: number }) => {
  const channel = declared.get(client.id);
  return { origin: channel?.frontDoor ?? ("cli" as const), from: channel?.from };
};

/**
 * The handlers, and with them the registry: built in this layer's scope, which is the
 * host's. A client's connection is a scope of its own under it, so a client that goes
 * takes nothing with it — not a registration, not an execution, not another client.
 */
/** `<version>+<sha>` where the host runs a development checkout; nothing for a release. */
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
      const bun = yield* Effect.context<BunServices>();
      const pid = yield* currentPid;
      const recordingLinks = yield* Semaphore.make(1);
      // The installation this host belongs to, which the client that started it named.
      const env = yield* currentEnv.pipe(Effect.orDie);
      const catalogue = (project: string) =>
        discover(searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project }));

      const record = <A, E, R>(runId: string, read: Effect.Effect<A, E, R>) =>
        registry.view(runId).pipe(
          Effect.flatMap((view): Effect.Effect<A, E | HostRefused, R> =>
            view === null ? Effect.fail(new HostRefused({ reason: `No Run "${runId}".` })) : read,
          ),
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
                : (yield* peersOf(dir)).find((one) => one.installation === sender.installation);
            if (peer === undefined || sender?.installation !== notice.machine.installation)
              return yield* new HostRefused({
                reason: "only a paired Machine can send a Run link notice",
              });
            if (notice.requestedBy.machine.installation !== installation)
              return yield* new HostRefused({
                reason: "the requesting Run belongs to another Machine",
              });
            const runId = notice.requestedBy.run;
            if ((yield* registry.view(runId)) === null)
              return yield* new HostRefused({ reason: `No Run "${runId}".` });
            const launch = (yield* readLaunches(dir, runId)).findLast(
              (one) => one.agent === notice.requestedBy.agent,
            );
            if (launch === undefined)
              return yield* new HostRefused({
                reason: "the requesting agent was not launched by that Run",
              });
            return yield* recordingLinks.withPermits(1)(
              once(
                runDir(dir, runId),
                {
                  operation: "run-link",
                  request,
                  ...actor,
                  asked: Schema.encodeSync(RunLinkNotice)(notice),
                  result: Schema.Boolean,
                },
                Effect.gen(function* () {
                  const prior = (yield* readRunLinks(runDir(dir, runId))).find(
                    (one) =>
                      one.run === notice.run &&
                      one.machine.installation === notice.machine.installation,
                  );
                  yield* recordRunLink(runDir(dir, runId), {
                    ...notice,
                    machine: { ...notice.machine, name: peer.name },
                    step: prior?.step ?? launch.step?.step ?? null,
                  }).pipe(Effect.orDie);
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
              // Without the revision: that is how this host decides a reload, not a caller.
              entries: found.entries.map(
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
        runMetrics: ({ runId }) => record(runId, readMetrics(evidenceDir(dir, runId))),
        runCards: ({ runId }) => record(runId, readCards(runDir(dir, runId))),
        runDrift: ({ runId }) => record(runId, readDrift(runDir(dir, runId))),
        runIntent: ({ runId }) => record(runId, readIntent(runDir(dir, runId))),
        runDispositions: ({ runId }) => record(runId, readDispositions(runDir(dir, runId))),
        runOutcomes: ({ runId }) => record(runId, outcomeRecordsOf(dir, runId)),
        runOutputs: ({ runId }) => record(runId, outputsOf(dir, runId)),
        runChecks: ({ runId }) =>
          Effect.gen(function* () {
            const views = yield* registry.views(null);
            const runs = views.map((view) => factsOfView(dir, view));
            const run = runs.find((one) => one.id === runId);
            if (run === undefined) return yield* new HostRefused({ reason: `No Run "${runId}".` });
            return {
              running: yield* runningCheck(
                run,
                runs,
                yield* markersOf(runs),
                yield* Clock.currentTimeMillis,
              ),
              done: yield* donePasses(run),
            };
          }),
        checkLog: ({ runId }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const views = yield* registry.views(null);
              const runs = views.map((view) => factsOfView(dir, view));
              const run = runs.find((one) => one.id === runId);
              if (run === undefined)
                return yield* new HostRefused({ reason: `No Run "${runId}".` });
              const running = yield* runningCheck(
                run,
                runs,
                yield* markersOf(runs),
                yield* Clock.currentTimeMillis,
              );
              if (running?.log == null) return Stream.make({ _tag: "Ended" as const, check: null });
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
            if ((yield* registry.view(runId)) === null) return null;
            return (yield* deliveriesOf(dir, runId)).map((one) => one.delivery);
          }),
        runs: ({ task }) => registry.views(task),
        watch: ({ runId }) => registry.watch(runId),
        recover: () => registry.recover,
        shown: ({ runId }) =>
          Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) return null;
            const all = yield* registry.views(null);
            const hosted = yield* Effect.context<HostServices>();
            return {
              view,
              agents: yield* runAgents(dir, runId),
              disposition: latest(
                yield* readDispositions(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
              ),
              children: all.filter((one) => one.parent === runId),
              startedBy: startedBy(
                yield* readAudit(runDir(dir, runId)).pipe(Effect.orElseSucceed(() => [])),
                { id: runId, parent: view.parent },
              ),
              handoffs: (yield* handoffsIn(runDir(dir, runId))).map((file) => ({
                path: `${handoffsDir(runDir(dir, runId))}/${file.name}`,
                bytes: file.bytes,
              })),
              memory: yield* Effect.map(memoryWaitOf(runDir(dir, runId)), (wait) =>
                wait === null ? null : waitLine(wait),
              ),
              flow: yield* taskFlowOf(
                {
                  env,
                  runs: all.map((one) => factsOfView(env.stateDir, one)),
                  alive: (yield* liveHerds(new Herdr(env), env).pipe(Effect.flatMap(agentsIn)))
                    .alive,
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
        agentRun: ({ agent }) =>
          everyRegistered(dir).pipe(
            Effect.map(
              (entries) => entries.findLast((entry) => entry.agent === agent)?.runId ?? null,
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
          // Files go only into a Run this host has.
          const known =
            (attachments ?? []).length === 0
              ? Effect.void
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
              if (attached !== undefined) asked.attachments = attached;
              // Only where given, so a request recorded before `to` existed still matches.
              if (to !== undefined) asked.to = to;
              if (step !== undefined) asked.step = step;
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
                    [text, ...copied.map((one) => attachedLine(`${into}/${one.name}`))]
                      .filter((line) => line !== "")
                      .join("\n"),
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
    }),
  );

/** What a steer's request has to ask again, as `AskedFor` is a start's. */
type SteerAsked = {
  step?: string;
  readonly text: string;
  to?: string;
  readonly operation: string | null;
  readonly agent: string | null;
  readonly mode: string | null;
  attachments?: ReadonlyArray<Attached>;
};

/**
 * What a request's attachments are recorded as: the name each is kept under in `into`
 * (an empty directory where null), and where it came from. Refused, naming the path, where
 * one cannot be attached.
 */
const attachedAs = (into: string | null, paths: ReadonlyArray<string> | undefined) =>
  Effect.gen(function* () {
    if (paths === undefined || paths.length === 0) return undefined;
    const refused = yield* attachmentRefusal(paths);
    if (refused !== null) return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${refused}` });
    return (yield* namesIn(into, paths)).map(({ name, from }) => ({ name, from }));
  }).pipe(
    Effect.mapError((cause) =>
      Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
    ),
  );

/** A steer that came to nothing, which is told to the caller but not kept as its request's answer. */
class SteerUnanswered extends Schema.TaggedError<SteerUnanswered>()("SteerUnanswered", {
  outcome: SteerOutcome,
}) {}

/** What `act` carries out with no proposal: what the human asks for by name, and chat's hold. */
const ACTED_KINDS = new Set<string>([...ASKED_KINDS, "hold"]);

/** An operation's result as the front doors print it: a failure carries its code. */
const outcomeOf = (result: OpResult): SteerOutcome =>
  result.ok
    ? { ok: true, code: null, human: result.human, data: fromText(toText(result.data)) }
    : {
        ok: false,
        code: result.error.code,
        human: result.error.message,
        data: fromText(toText(result.error.details ?? {})),
      };

/** Through JSON text, so a field left undefined is dropped rather than refused. */
const toText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromText = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

/** How often a board is built again with nothing written, so "silent for" stays true. */
const BOARD_TICK = "5 seconds";

/** This process's env, for the state directory it serves rather than the one it inherited. */
const servingEnv = (dir: string) =>
  currentEnv.pipe(
    Effect.orDie,
    Effect.map((env) => ({ ...env, stateDir: dir })),
  );

/** Every Run the host knows, and the board built from them, for this host's own env. */
/** The Runs and Task views a set of sweepers judges against. */
interface BoardSource<E, F> {
  readonly runs: Effect.Effect<ReadonlyArray<RunFacts>, E>;
  readonly views: (
    herds: Effect.Success<ReturnType<typeof liveHerds>>,
  ) => Effect.Effect<ReadonlyArray<TaskView>, F>;
}

const hostBoard = (dir: string) =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const checks = yield* CheckProcesses;
    const bun = yield* Effect.context<BunServices>();
    const hosted = yield* Effect.context<HostServices>();
    const env = yield* servingEnv(dir);
    const herdr = new Herdr(env);
    // Read as often as `herdChanges` reads them: each read is a herdr process, and a build
    // runs on every write the board reads under the state directory.
    const herdsNow = yield* Effect.cachedWithTTL(liveHerds(herdr, env), SESSIONS_EVERY);
    const runs = registry
      .views(null)
      .pipe(Effect.map((views) => views.map((view) => factsOfView(env.stateDir, view))));
    const idle: IdleSince = new Map();
    const finishedSince: FinishedSince = new Map();
    const boardOf = (facts: ReadonlyArray<RunFacts>, alive: ReadonlyArray<AgentInfo>) =>
      Effect.gen(function* () {
        return yield* buildBoard({
          env,
          runs: facts,
          alive,
          quietMs: (yield* loadDefaults(env.userDir)).boardQuietMs,
          offers: (runId) =>
            registry.offers(runId).pipe(
              Effect.provideContext(hosted),
              Effect.orElseSucceed(() => []),
            ),
        });
      }).pipe(Effect.provideContext(bun));
    /** The board, with the Runs it was built from. */
    const listingOf = (herds: typeof herdsNow) =>
      Effect.gen(function* () {
        const { alive, restored } = yield* Effect.flatMap(herds, agentsIn).pipe(
          Effect.provideContext(bun),
        );
        noteIdle(idle, [...alive, ...restored], yield* Clock.currentTimeMillis);
        const facts = yield* runs;
        return { runs: facts, views: yield* boardOf(facts, alive) };
      });
    const listing = listingOf(herdsNow);
    /** When each Task was first seen Finished, for as long as this host runs. */
    const seen = new Map<string, number>();
    const storage = yield* Effect.context<MessageStorage.MessageStorage>();
    /** Every kind of thing Collie cleans, judged against `board`'s Runs and Task views. */
    // Fresh, never the board's cached sessions: a session opened since would look gone.
    const sweepersOver = <E, F>(board: BoardSource<E, F>) =>
      Effect.gen(function* () {
        const herds = yield* liveHerds(herdr, env);
        const sessions = herds.map((session) => session.herdr);
        const build = board.views(herds);
        const all = yield* board.runs;
        const tasks = yield* listTasks(env.stateDir);
        return [
          // Before the worktrees: a checkout goes only once its Task's workspace has closed.
          taskWorkspacesSweeper({
            stateDir: env.stateDir,
            sessions: herds,
            tasks,
            // No board, no Task judged Finished, so nothing closed.
            views: yield* build.pipe(Effect.orElseSucceed(() => [])),
            runs: all,
            seen,
          }),
          idleAgentsSweeper({
            stateDir: env.stateDir,
            sessions: herds,
            runs: all,
            idle,
            finishedSince,
            // A config that cannot be read closes nothing.
            idleCloseMs: yield* loadDefaults(env.userDir).pipe(
              Effect.map((defaults) => defaults.idleCloseMs),
              Effect.orElseSucceed(() => 0),
            ),
          }),
          worktreesSweeper({
            herdr,
            sessions,
            stateDir: env.stateDir,
            runs: all,
            registered: yield* everyRegistered(env.stateDir),
            cwd: env.cwd,
            settling: settlingOf({
              stateDir: env.stateDir,
              runs: all,
              tasks,
              sessions,
              protect: [env.pluginRoot],
            }),
          }),
          generationsSweeper(generationsDir()),
          stateSweeper(env.stateDir, new Set(all.map((run) => run.id))),
          uploadsSweeper(env.stateDir),
          compactionSweeper(env.stateDir, sessions),
          runnersSweeper(`${collieCache()}/runners`, BUILD),
          checksSweeper(checks),
          renovateClonesSweeper(env.stateDir, all),
          desktopSweeper(
            desktopRootOf(dataHomeOf(env.home, env.raw["XDG_DATA_HOME"])),
            `${env.raw["XDG_STATE_HOME"] || `${env.home}/.local/state`}/collie-desktop`,
            process.platform === "darwin"
              ? `${env.home}/Applications/collie-desktop.app/Contents/Resources/version.json`
              : `${desktopRootOf(dataHomeOf(env.home, env.raw["XDG_DATA_HOME"]))}/app/Resources/version.json`,
          ),
          // Last: a Task is kept while a workspace or a checkout of it is still there.
          retentionSweeper({
            stateDir: env.stateDir,
            sessions,
            // Every read or none: a Task judged without its Runs would look forgettable.
            facts: Effect.all({
              tasks: listTasks(env.stateDir),
              views: board.views(herds),
              runs: board.runs,
            }).pipe(
              Effect.orElseSucceed(() => ({ tasks: [], views: [], runs: [] })),
              Effect.provideContext(bun),
            ),
            retire: (ids) => registry.retire(ids).pipe(Effect.provideContext(storage)),
          }),
        ];
      });
    /** A sweep's sweepers, each judging against a board built as it judges. */
    const sweepers = sweepersOver({
      runs,
      views: (herds) => Effect.map(listingOf(Effect.succeed(herds)), (built) => built.views),
    });
    /** The host's own stop, audited as the host's and asked once per Run. */
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
      sweepers,
      sweepersOver,
      record: registry.mergeRequest,
      stop,
    };
  });

/** The board built once for this host's clients and side jobs, from when the host starts. */
class SharedBoard extends Context.Service<
  SharedBoard,
  Omit<Effect.Success<ReturnType<typeof hostBoard>>, "listing"> & {
    /** Whatever may have moved the board. */
    readonly changed: Stream.Stream<void>;
    readonly boards: Stream.Stream<{
      readonly runs: ReadonlyArray<RunFacts>;
      readonly views: ReadonlyArray<TaskView>;
    }>;
    /** A listing's sweepers, judging against the latest board built. */
    readonly listed: Effect.Success<ReturnType<typeof hostBoard>>["sweepers"];
  }
>()("collie/SharedBoard") {}

/** What the host writes for itself, by its path under the state directory, which no build reads. */
const isBookkeeping = ({ _tag, path }: FileSystem.WatchEvent) => {
  const [top, , below] = path.split("/");
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.endsWith(".lock") || name.endsWith(".tmp") || top === "ssh") return true;
  if (/^host\.(log|out)(\.\d+)?$|^host\.db-(wal|journal)$/.test(path)) return true;
  if (top === "compaction") return name !== QUESTIONS;
  // The board reads only these directories' mtime, which a file growing leaves alone.
  return (
    _tag === "Update" &&
    ((top === "runs" && below === "handoffs") || (top === "evidence" && below === "verify"))
  );
};

const watched = (dir: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return fs.watch(dir, { recursive: true }).pipe(Stream.catch(() => Stream.empty));
    }),
  );

/** Each write under the state directory that may move the board, by its path inside it. */
export const boardWrites = (dir: string) =>
  watched(dir).pipe(
    Stream.filter((event) => !isBookkeeping(event)),
    Stream.map((event) => event.path),
  );

/** What a Run's open drawer lists and the board ignores: its handoffs' and evidence's sizes. */
export const drawerWrites = (dir: string, runId: string) =>
  Stream.merge(
    watched(runDir(dir, runId)).pipe(Stream.filter((event) => event.path.startsWith("handoffs/"))),
    watched(evidenceDir(dir, runId)),
  ).pipe(Stream.debounce("200 millis"));

/**
 * A write under the state directory, by this host or anyone else, to a file the board reads,
 * or a Run recorded from any door, is a reason to build again.
 */
const sharedBoardLayer = (dir: string) =>
  Layer.effect(SharedBoard)(
    Effect.gen(function* () {
      const store = yield* Store;
      const { listing, ...board } = yield* hostBoard(dir);
      // Debounced apart from the tick, so a burst of writes cannot hold the tick back.
      // Shared, so every subscriber rides one recursive watch: setting one up walks the tree.
      const changed = yield* Stream.mergeAll(
        [
          boardWrites(dir).pipe(
            Stream.debounce("200 millis"),
            Stream.map(() => undefined),
          ),
          Stream.tick(BOARD_TICK),
          herdChanges(board.herdr, board.env).pipe(
            Stream.provideContext(board.bun),
            Stream.catch(() => Stream.empty),
          ),
          store.changes.pipe(Stream.map(() => undefined)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.share({ capacity: 1, strategy: "sliding" }));
      const { boards, latest } = yield* shareBoard({ build: listing, changed });
      const listed = board.sweepersOver({
        runs: Effect.map(latest, (built) => built.runs),
        views: () => Effect.map(latest, (built) => built.views),
      });
      return { ...board, changed, boards, listed };
    }),
  );

/** The merge watch, News, the cleanup sweep and the Home's tokens, for as long as this host runs. */
const sideJobsLayer = (panels: MrPanels) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { env, herdr, bun, boards, sweepers, record, stop } = yield* SharedBoard;
      const board = Stream.runHead(boards).pipe(
        Effect.flatMap((latest) =>
          latest._tag === "Some" ? Effect.succeed(latest.value) : Effect.never,
        ),
      );
      yield* Effect.forkScoped(
        sideJobs({ env, herdr, board, panels, record, stop, sweepers }).pipe(
          Effect.provideContext(bun),
        ),
      );
    }),
  );

/** Each agent's question no step is reading, put on its Run whenever anything may have moved. */
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

/** How many sweeps a front door asked for that a host keeps a record of. */
const CLEANUP_TRAIL = 50;

/** How many of the settings operations a host keeps a record of. */
const SETTINGS_TRAIL = 50;
const DEFINITIONS_TRAIL = 50;
/** How many usage reads the host keeps a record of: Desktop asks every minute. */
const USAGE_TRAIL = 200;
/** How many of the chat's writes to files the host keeps a record of. */
const FILES_TRAIL = 1000;
/** How many uploads the host keeps a record of. */
const UPLOADS_TRAIL = 1000;
const Written = Schema.Struct({ path: Schema.String, bytes: Schema.Int });
const Edited = Schema.Struct({ path: Schema.String, replaced: Schema.Int });

/** A Herd's key names one directory under the state directory, and nothing above it. */
const isHerdName = (herd: string) => herd !== "." && herd !== ".." && /^[^/\\]+$/.test(herd);

/** The board, built here for every front door. */
const frontDoorHandlers = (
  dir: string,
  installation: string,
  development: Development,
  panels: MrPanels,
  declared: Declared,
  stamp: string,
) =>
  FrontDoorRpcs.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registry = yield* Registry;
      const hosted = yield* Effect.context<HostServices>();
      const reliance = yield* Reliance;
      const { env, herdr, bun, sweepers, listed, changed, ...shared } = yield* SharedBoard;
      const collecting = yield* Collecting;
      const forgeHttp = yield* ForgeHttp;
      const boards = shared.boards.pipe(Stream.map((built) => built.views));
      const usage = yield* Usage;
      const schedules = yield* Schedules;
      // Trimming rewrites the trail through one temporary file, so one read records at a time.
      const recordingUsage = yield* Semaphore.make(1);
      const recordingShell = yield* Semaphore.make(1);
      // Two doors acknowledging at once still leave one seen line.
      const seeing = yield* Semaphore.make(1);
      // Every drawer on a finished Run shares one read of its plan until a file of it changes.
      // ponytail: kept for the host's life; evict by age if a host lives for months.
      const plans: PlanCache = new Map();
      const stampOf = (client: { readonly id: number }) => stampIn(declared, client);
      const doorOf = (client: { readonly id: number }) => stampOf(client).origin;
      /** Who asks on a channel: its front door, and a chat's voice. */
      const askerOf = (client: { readonly id: number }): Asker => ({
        origin: doorOf(client),
        ...declared.get(client.id)?.voice,
      });
      /** What a channel's operations are recorded as: who asks, and where a bridge said it came from. */
      const whoOf = (client: { readonly id: number }) => ({
        ...askerOf(client),
        ...stampOf(client),
      });
      /** An agent settled while Collie waits on its Output is told its verify ended, or it would wait forever. */
      const toldVerifyEnded = (
        client: { readonly id: number },
        verified: import("./verify-model").Verification,
      ) => {
        const asker = whoOf(client);
        const { run, agent } = asker.from ?? {};
        if (asker.origin !== "agent" || run === undefined || agent === undefined)
          return Effect.void;
        return Effect.gen(function* () {
          if (!(yield* collecting.has(run, agent))) return;
          if (!isSettled(yield* herdr.agentStatus(agent).pipe(Effect.provideContext(bun)))) return;
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
      /** Each carry-out still running, so a retry of its confirm answers what it came to. */
      type Carried = Exit.Exit<Effect.Success<Carrying>, Effect.Error<Carrying>>;
      const carrying = new Map<string, Deferred.Deferred<Carried>>();
      const carryingKey = (proposal: string, request: string) =>
        JSON.stringify([proposal, request]);
      const carriedBy = (proposal: string, request: string) => {
        const running = carrying.get(carryingKey(proposal, request));
        return running === undefined ? null : Effect.flatten(Deferred.await(running));
      };
      // ponytail: one entry per connection, never removed, as `declared`.
      const sessions = new Map<number, string>();
      /** The serving env in the herdr session the asking channel declared, where it named one. */
      const askerEnv = (client: { readonly id: number }) => {
        const session = sessions.get(client.id);
        const rooted = { ...env, hostStamp: stamp, asker: whoOf(client) };
        return session === undefined ? rooted : { ...rooted, socketPath: session };
      };
      const trail = (runId: string) => runDir(env.stateDir, runId);
      /** The Herd of the session the asker runs in, where it names none. */
      const askersHerd = (client: { readonly id: number }) =>
        herdOf(askerEnv(client).socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
      /** An operation that is idempotent by itself, recorded the first time it does anything. */
      // ponytail: a host that dies between acting and recording leaves that one unrecorded.
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
      /** A new Run's attachments, refused before anything is claimed, as its audit line asks them. */
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
        registry
          .view(runId)
          .pipe(
            Effect.flatMap((view) =>
              view === null
                ? Effect.fail(new HostRefused({ reason: `no Run ${runId}` }))
                : Effect.succeed(view),
            ),
          );
      const auditedControl =
        (
          runId: string,
          operation: string,
          request: string,
          who: Asker & { readonly from?: Where | undefined },
          reason?: string,
        ) =>
        <E>(act: Effect.Effect<typeof Controlled.Type, E, HostServices>) =>
          Effect.andThen(
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
      /** A file operation's failure as the host's refusal, in its own words. */
      const refusedPlainly = <A, E, R extends BunServices>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) =>
            Schema.is(RequestConflict)(cause) || Schema.is(HostRefused)(cause)
              ? cause
              : new HostRefused({ reason: reason(cause) }),
          ),
          Effect.provideContext(bun),
        );
      /** A write to a file, once per request, recorded in the host's own trail. */
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
      /** Only the refusals a front door can act on keep their shape; anything else is said in a sentence. */
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
      /**
       * A yes or a no, given once per request. The journal records who gave it; a request it
       * already holds gets back what it did then, handed the journal's lines rather than null.
       */
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
          const file = yield* journalOf(env.stateDir, proposal);
          if (file === null)
            return yield* new ProposalRefused({
              refused: "not_found",
              detail: `no proposal "${proposal}"`,
            });
          const lines = yield* readProposals(file);
          const found = lines.find(
            (line): line is ProposalRecord => line.kind === "proposal" && line.id === proposal,
          );
          if (found?.content_hash !== hash)
            return yield* new ProposalRefused({
              refused: "hash_mismatch",
              detail: `"${proposal}" is ${found?.content_hash}, not ${hash}`,
            });
          const prior = answeredBy(lines, request);
          if (prior === undefined) return yield* act(file, null);
          if (prior.kind !== kind || prior.id !== proposal)
            return yield* new RequestConflict({
              request,
              reason: `request "${request}" already ${prior.kind} ${prior.id}`,
            });
          return yield* act(file, lines);
        }).pipe(plainly);
      /** A Run picked up again: what current files allow is registered, then its stop cleared. */
      const takeUp = (runId: string) => registry.resume(runId);
      return FrontDoorRpcs.of({
        declare: ({ frontDoor, session, from, stamp: stamped, ...voice }, { client }) => {
          // Which Machine a channel came from is said by this host's own link, never by the channel.
          if (from?.machine !== undefined && stamped !== stamp)
            return Effect.fail(
              new HostRefused({ reason: "a channel cannot say which Machine it came from" }),
            );
          if (frontDoor === "host" && stamped !== stamp)
            return Effect.fail(new HostRefused({ reason: "only a host's own link is host" }));
          const already = declared.get(client.id);
          if (frontDoor === "schedule")
            return Effect.fail(
              new HostRefused({ reason: "only the host starts a Run as a Schedule" }),
            );
          if (already !== undefined && already.frontDoor !== frontDoor) {
            return Effect.fail(
              new HostRefused({ reason: `this channel is already ${already.frontDoor}` }),
            );
          }
          return Effect.gen(function* () {
            let where = from;
            if (frontDoor === "agent" && from?.machine === undefined) {
              const entry = (yield* everyRegistered(dir)).findLast(
                (one) => one.agent === from?.agent,
              );
              if (entry === undefined || (from?.run !== undefined && from.run !== entry.runId))
                return yield* new HostRefused({
                  reason: "this agent's Run could not be named from its registration",
                });
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
            if (session !== undefined && session !== null) sessions.set(client.id, session);
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
                    : registry.resolve({ project: placed.project, id }).pipe(
                        Effect.flatMap((generation) =>
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
                            )
                              return;
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
          return fresh(
            () => runId,
            { operation: "answer", request, ...whoOf(client), result: Answered },
            registry
              .answer({ runId, decision, value, request, by: whoOf(client) })
              .pipe(Effect.map(saying(removed))),
          );
        },
        control: ({ runId, control, set, request, reason, before }, { client }) =>
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
          auditedControl(runId, "resume", request, whoOf(client))(takeUp(runId)),
        offers: ({ runId }) => registry.offers(runId),
        workflows: ({ project }) =>
          discover(searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project })).pipe(
            Effect.map(({ entries }) =>
              entries.map(({ id, title, description, inputs }) => ({
                id,
                title,
                description,
                inputs: inputs.map(({ name, required, schema }) => ({ name, required, schema })),
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
              yield* child.unref;
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
        setSettings: ({ settings, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const who = whoOf(client);
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
                  yield* nowIso(),
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
              return taken;
            }),
          ),
        sharedDefinitions: (_, { client }) =>
          Effect.gen(function* () {
            const held = yield* sharedDefinitions(env.userDir, yield* nowIso());
            const trail = (yield* Path.Path).join(env.stateDir, "definitions");
            yield* recordAudit(trail, {
              operation: "definitions",
              request: yield* (yield* Crypto.Crypto).randomUUIDv4,
              ...whoOf(client),
              result: Schema.Number,
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
                  yield* nowIso(),
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
              return held;
            }),
          ),
        usage: (_, { client }) =>
          plainly(
            Effect.gen(function* () {
              const readings = yield* usage.readings;
              const trail = (yield* Path.Path).join(env.stateDir, "usage");
              const request = yield* (yield* Crypto.Crypto).randomUUIDv4;
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
        invoke: ({ runId, offer, input: given, request, attachments }, { client }) => {
          const { value: input, removed } = scrubJson(given);
          return attachedFor(attachments, (asked) =>
            fresh(
              () => runId,
              { operation: "invoke", request, ...whoOf(client), asked, result: Started },
              registry
                .invoke({ runId, offer, input, request, attachments })
                .pipe(Effect.map(saying(removed))),
            ),
          );
        },
        upload: (part, { client }) =>
          refusedPlainly(
            Effect.gen(function* () {
              const got = yield* receive(env.stateDir, part);
              // Logged once a file arrives, or is answered from what this host already held.
              if (got.path !== null && (got.complete || part.offset === 0))
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
              return { path: got.path };
            }),
          ),
        readFile: ({ path, offset, length }) =>
          readPart(path, offset, length).pipe(Effect.provideContext(bun)),
        glob: ({ pattern, path }) => refusedPlainly(globFiles(pattern, path ?? env.home)),
        grep: ({ path, ...asked }) =>
          refusedPlainly(grepFiles({ ...asked, path: path ?? env.home })),
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
                    // The same request twice at once: the second waits for the first.
                    const running = carriedBy(proposal, request);
                    if (running !== null) return yield* running;
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
            if (Option.isNone(decoded))
              return outcomeOf(err("invalid_input", `${refusedAction(actions)}.`));
            if (herd !== null && !isHerdName(herd))
              return outcomeOf(err("invalid_input", `"${herd}" is not a Herd.`));
            const key = herd ?? (yield* askersHerd(client));
            if (key === null)
              return outcomeOf(err("invalid_state", "No Herd to keep the request in."));
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
              // A refusal is not kept against its request, so it can be asked again corrected.
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
        act: ({ actions: given, request }, { client }) => {
          const scrubbed = given.map((one) => scrubJson(one));
          const actions = scrubbed.map((one) => one.value);
          return plainly(
            Schema.decodeUnknownEffect(Schema.Array(ActionSchema))(actions).pipe(
              Effect.mapError(
                () => new HostRefused({ reason: `${REFUSED_INPUT}: ${refusedAction(actions)}` }),
              ),
              Effect.flatMap((decoded) => {
                const proposed = decoded.filter((action) => !ACTED_KINDS.has(action.kind));
                return proposed.length > 0
                  ? Effect.fail(
                      new HostRefused({
                        reason: `${REFUSED_INPUT}: ${[...new Set(proposed.map((a) => a.kind))].join(", ")} is carried out through propose, so it is on the record as asked for`,
                      }),
                    )
                  : carryOutAsked(askerEnv(client), decoded, {
                      ...whoOf(client),
                      requestId: request,
                    }).pipe(
                      Effect.map((results) =>
                        results.map((result, index) => {
                          const notice = removedNotice(scrubbed[index]?.removed ?? []);
                          return notice === null
                            ? result
                            : { ...result, note: [result.note, notice].filter(Boolean).join("; ") };
                        }),
                      ),
                    );
              }),
            ),
          );
        },
        reconcile: ({ proposal, index, as, request }, { client }) =>
          plainly(
            Effect.gen(function* () {
              const file = yield* journalOf(env.stateDir, proposal);
              if (file === null)
                return yield* new ProposalRefused({
                  refused: "not_found",
                  detail: `no proposal "${proposal}"`,
                });
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
                  if (done.refused !== null)
                    return yield* new ProposalRefused({
                      refused: done.refused,
                      detail: done.detail,
                    });
                  return { proposal };
                }),
              );
            }),
          ),
        verify: ({ runId, name, executable, argv, cwd, expect }, { client }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const view = yield* known(runId);
              const { collect, insideRun } = yield* Effect.promise(() => import("./verify"));
              const { noteVerification } = yield* Effect.promise(() => import("./metrics"));
              const where = cwd ?? view.cwd;
              if (!(yield* insideRun(where, { cwd: view.cwd, worktree: null })))
                return yield* new HostRefused({
                  reason: `${REFUSED_INPUT}: "${where}" is not inside run ${runId}; a verification names the tree it ran on.`,
                });
              const check = yield* reliance.relied(runId, { executable, argv, cwd: where });
              if (check !== null) {
                const { record } = check;
                if (record === null)
                  return yield* new HostRefused({
                    reason: `invalid_state: "${check.check}" is one of this Run's Checks and has no record on this tree; Collie's gate runs it itself, on the final tree.`,
                  });
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
              return Stream.callback<typeof import("./verify-model").VerifyEvent.Type, HostRefused>(
                (queue) =>
                  Effect.gen(function* () {
                    const echo = (stream: "stdout" | "stderr") => (text: string) =>
                      Queue.offer(queue, { _tag: "Output", stream, text }).pipe(Effect.asVoid);
                    const from = whoOf(client).from;
                    const step =
                      from?.run === runId
                        ? (yield* readLaunches(env.stateDir, runId)).findLast(
                            (one) => one.agent === from.agent,
                          )?.step
                        : undefined;
                    const fs = yield* FileSystem.FileSystem;
                    const stopped = fs
                      .exists(controlPath(env.stateDir, STOP, runId))
                      .pipe(Effect.orElseSucceed(() => false));
                    const memory = yield* waitForMemory({
                      env,
                      stateDir: env.stateDir,
                      runId,
                      what: `collie verify "${name}"`,
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
                    const started = (yield* nowIso()).replace(/[:.]/g, "-");
                    const log = `${evidenceDir(env.stateDir, runId)}/verify/${started}-${name.replace(/[^\w.-]/g, "_")}.log`;
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
                        },
                        {
                          stdout: echo("stdout"),
                          stderr: echo("stderr"),
                          said: (line) =>
                            echo("stderr")(`${line}\n`).pipe(
                              Effect.andThen(appendLog(runDir(env.stateDir, runId), line)),
                              Effect.ignore,
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
                      // Ending the race ends the command's process group with its scope.
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
                if (view === null) return yield* new HostRefused({ reason: `No Run "${runId}".` });
                if (change.kind === "set-outcome") {
                  const asked = change.outcome;
                  if (asked !== null && !REQUESTABLE.includes(asked))
                    return yield* new HostRefused({
                      reason: `${REFUSED_INPUT}: "${asked}" is not an outcome; a Run is held to one of ${REQUESTABLE.join(", ")}`,
                    });
                  const fixed = Option.getOrNull(
                    yield* registry
                      .resolve({ project: view.project, id: view.workflow })
                      .pipe(Effect.option),
                  )?.fixedOutcome;
                  if (fixed !== null && fixed !== undefined)
                    return yield* new HostRefused({
                      reason: `${REFUSED_INPUT}: "${view.workflow}" always proves ${fixed}`,
                    });
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
                const updated = yield* withDirLock(
                  runDir(env.stateDir, runId),
                  Effect.gen(function* () {
                    const current = yield* readIntent(runDir(env.stateDir, runId));
                    if (current === null) return null;
                    if (expected !== undefined && current.version !== expected)
                      return yield* new HostRefused({
                        reason: `the Intent is v${current.version}, not v${expected}`,
                      });
                    const recorded =
                      change.kind === "verification"
                        ? (yield* readAudit(trail(runId))).find((one) => one.request === request)
                        : undefined;
                    const amendedBy = recorded?.actor ?? by;
                    if (
                      change.kind === "verification" &&
                      current.history.some((one) => one.by === actorName(amendedBy))
                    )
                      return current;
                    const wanted =
                      change.kind === "verification"
                        ? verificationGrant(current, change.name, change.command)
                        : change;
                    const amended = amend(
                      current,
                      wanted,
                      actorName(amendedBy),
                      yield* nowIso(),
                      voiceOf(amendedBy),
                    );
                    if (amended !== current)
                      yield* writeIntentHeld(runDir(env.stateDir, runId), amended);
                    return amended;
                  }),
                ).pipe(Effect.result);
                if (updated._tag === "Failure") {
                  if (approved === undefined)
                    return yield* new HostRefused({
                      reason: Schema.is(HostRefused)(updated.failure)
                        ? updated.failure.reason
                        : reason(updated.failure),
                    });
                  return {
                    version: null,
                    propagated: [],
                    approved,
                    warning: `The grant holds, but intent show will not list it: ${reason(updated.failure)}`,
                  };
                }
                const next = updated.success;
                if (next === null && change.kind !== "verification")
                  return yield* new HostRefused({
                    reason: `Run "${runId}" has no Intent to amend.`,
                  });
                const propagated: string[] = [];
                if (spread && next !== null)
                  for (const child of (yield* registry.views(null)).filter(
                    (view) =>
                      view.parent === runId &&
                      view.status.status !== "complete" &&
                      view.status.status !== "failed",
                  )) {
                    const note = yield* withDirLock(
                      runDir(env.stateDir, child.runId),
                      Effect.gen(function* () {
                        const current = yield* readIntent(runDir(env.stateDir, child.runId)).pipe(
                          Effect.orElseSucceed(() => null),
                        );
                        if (current === null) return null;
                        const carried = propagateIntent(next, current);
                        yield* writeIntentHeld(runDir(env.stateDir, child.runId), carried.intent);
                        return `  ${child.runId}: propagated${carried.conflicts.length ? ` (${carried.conflicts.join("; ")})` : ""}`;
                      }),
                    ).pipe(Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })));
                    if (note !== null) propagated.push(note);
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
                const found = (yield* deliveriesOf(env.stateDir, runId)).find(
                  (entry) => entry.delivery.id === delivery,
                );
                if (!found)
                  return yield* new HostRefused({
                    reason: `${REFUSED_INPUT}: no delivery "${delivery}" for this Run`,
                  });
                const settled = reconcileDelivery(
                  yield* readLedger(found.file),
                  delivery,
                  as,
                  actorName({ ...whoOf(client), requestId: request }),
                  yield* nowIso(),
                );
                if ("error" in settled)
                  return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${settled.error}` });
                yield* appendLine(found.file, settled);
                return fromText(toText(settled));
              }),
            ),
          ),
        news: ({ herd, conversation, as, request, keys }, { client }) =>
          plainly(
            Effect.gen(function* () {
              if (herd !== null && !isHerdName(herd))
                return yield* new HostRefused({
                  reason: `${REFUSED_INPUT}: "${herd}" is not a Herd`,
                });
              const key = herd ?? (yield* askersHerd(client));
              if (key === null)
                return yield* new HostRefused({
                  reason: "invalid_state: no Herd to read News for",
                });
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
                    for (const item of batch.items)
                      yield* settleNews(file, item.key, as, conversation);
                    return batch;
                  }
                  const batch = pendingNews(lines, conversation, Infinity);
                  for (const item of batch.items)
                    if (keys.includes(item.key))
                      yield* settleNews(file, item.key, as, conversation);
                  return batch;
                }),
              );
              yield* trimAudit(trail, NEWS_TRAIL).pipe(Effect.orDie);
              return batch;
            }),
          ),
        dispose: ({ runId, kind, ref, note, request }, { client }) =>
          known(runId).pipe(
            Effect.andThen(
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
                  const line = {
                    at: yield* nowIso(),
                    by: actorName({ ...whoOf(client), requestId: request }),
                    kind,
                    ref,
                    note,
                  };
                  yield* recordDisposition(trail(runId), line);
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
                    if (first !== undefined) return first;
                    const line = {
                      at: yield* nowIso(),
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
              const view = yield* known(runId);
              const task = view.task === null ? null : yield* readTask(env.stateDir, view.task);
              const agents = (yield* everyRegistered(env.stateDir))
                .filter((entry) => entry.runId === runId)
                .map((entry) => entry.agent)
                .filter((name) => agent === undefined || name === agent)
                .reverse();
              const sessions = (yield* liveHerds(herdr, env)).toSorted(
                (a, b) => Number(b.herd === task?.herd) - Number(a.herd === task?.herd),
              );
              return yield* once(
                trail(runId),
                {
                  operation: "focus",
                  request,
                  ...whoOf(client),
                  asked: agent === undefined ? {} : { agent },
                  result: PaneAt,
                },
                focusPane(
                  sessions,
                  agents,
                  view.workspace ?? task?.workspace ?? null,
                  task?.herd,
                ).pipe(
                  Effect.flatMap((at) =>
                    at === null
                      ? Effect.fail(
                          new HostRefused({
                            reason: `${runId} has no pane or workspace herdr still has`,
                          }),
                        )
                      : Effect.succeed(at),
                  ),
                ),
              );
            }),
          ),
        steerAbout: ({ runId, text: given, from, dryRun, request }, { client }) => {
          const { text, removed } = scrub(given);
          return Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null)
              return { ok: false, code: "run_not_found", human: `No Run "${runId}".`, data: {} };
            const task = view.task === null ? null : yield* readTask(env.stateDir, view.task);
            // Only an answer is kept against its request: a failure is retried under the same one.
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
                const deps = yield* evaluationDeps({ ...asker, herdKey: task?.herd ?? undefined });
                const said = yield* steer(asker, deps, {
                  text,
                  target: runId,
                  from,
                  dryRun,
                  requestId: request,
                  ...voiceOf(askerOf(client)),
                  origin: doorOf(client),
                });
                if (!said.ok)
                  return yield* new SteerUnanswered({
                    outcome: {
                      ok: false,
                      code: said.error.code,
                      human: said.error.message,
                      data: fromText(toText(said.error.details)),
                    },
                  });
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
                if (!settled(factsOfView(env.stateDir, view)))
                  return yield* new HostRefused({
                    reason: "a follow-up is a child of a finished run, and this one is still going",
                  });
                const offered = (yield* registry.offers(runId)).find(
                  (one) => one.kind === "follow-up",
                );
                if (offered === undefined)
                  return yield* new HostRefused({
                    reason: `${runId} declares no follow-up, so there is nothing to carry on with`,
                  });
                const into = followUpField(offered.arguments);
                if ("refused" in into)
                  return yield* new HostRefused({
                    reason: `${runId}'s follow-up "${offered.id}" ${into.refused}`,
                  });
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
            Effect.flatMap(({ answerRead }) => answerRead(askerEnv(client), tool, input)),
            Effect.provideContext(bun),
          ),
        progress: ({ runId }) =>
          Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) return null;
            const board = Option.getOrElse(yield* Stream.runHead(boards), () => []);
            const card = board.find((one) => one.runs.includes(runId));
            const mr = card?.run === runId ? card.mr : null;
            const forged =
              mr === null ? undefined : (yield* readForge(env.stateDir)).get(mrLabel(mr));
            return {
              ready: readinessOfRun(
                runId,
                card,
                view.status.status === "complete" || view.status.status === "failed",
              ),
              ci: forged?.checks ?? null,
              steps: yield* operationsOf(env.stateDir, runId),
            };
          }).pipe(Effect.provideContext(bun)),
        runDetail: ({ runId, tail, pages, refreshMr }) => {
          let fresh = refreshMr;
          const detail = Effect.gen(function* () {
            const view = yield* registry.view(runId);
            if (view === null) return null;
            const run = factsOfView(env.stateDir, view);
            const target = mrOf(run);
            const mr =
              target === null
                ? null
                : yield* watchedMr({
                    panels,
                    target,
                    cwd: env.cwd,
                    run: shell,
                    now: yield* Clock.currentTimeMillis,
                    fresh,
                  });
            fresh = false;
            // Every Run, because another built from the same plan may have finished its tickets.
            const runs = (yield* registry.views(null)).map((one) => factsOfView(env.stateDir, one));
            const hosted = yield* Effect.context<HostServices>();
            const flow = yield* taskFlowOf(
              {
                env,
                runs,
                alive: (yield* liveHerds(herdr, env).pipe(Effect.flatMap(agentsIn))).alive,
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
          const own = drawerWrites(env.stateDir, runId).pipe(Stream.provideContext(bun));
          return followDetail(detail, Stream.merge(changed, own)).pipe(Stream.orDie);
        },
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
                    herds: sessions.flatMap(({ herd, name }) =>
                      herd === null ? [] : [name === undefined ? { id: herd } : { id: herd, name }],
                    ),
                  },
                  boards,
                }),
              ),
              Effect.provideContext(bun),
            ),
          ).pipe(Stream.orDie),
      });
    }),
  );

/** The state directory's own id, made the first time a host owns it and kept from then on. */
const installationOf = Effect.fn("Host.installationOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = `${dir}/installation`;
  const known = (yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))).trim();
  if (known !== "") return known;
  const made = yield* (yield* Crypto.Crypto).randomUUIDv4;
  // Renamed into place, so a host that dies mid-write leaves no half an id.
  yield* fs.writeFileString(`${file}.new`, `${made}\n`);
  yield* fs.rename(`${file}.new`, file);
  return made;
});

/** On the Run of a check a host left: its marker gone where that names it, and a line in its log. */
const onLeftoversRun = (dir: string) => (leftover: Leftover, outcome: LeftoverEnd, line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = runDir(dir, leftover.run);
    if (!(yield* fs.exists(at).pipe(Effect.orElseSucceed(() => false)))) return;
    const marker = yield* verifyingIn(at);
    // A marker started after the check is a later check's.
    if (
      outcome !== "still running" &&
      marker !== null &&
      marker.name === leftover.name &&
      marker.pass === leftover.pass &&
      epochMs(marker.started) <= leftover.started
    )
      yield* fs.remove(`${at}/${VERIFYING_FILE}`, { force: true }).pipe(Effect.ignore);
    yield* appendLog(at, line).pipe(Effect.ignore);
  });

/**
 * One host, for as long as it owns this directory. It runs until it is interrupted:
 * every resource it holds — the socket, the registrations, the SQLite client and the
 * lock — is released by the scope it was built in.
 *
 * Losing the lock is not a failure. It means a host is already here, which is what the
 * caller wanted; the client that started this one connects to that host instead.
 */
export const serve = (named: string): Effect.Effect<void, never, BunServices | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(named, { recursive: true });
    // Resolved where it was named, before the chdir below moves where that is.
    const dir = yield* fs.realPath(named);
    // Whatever it was started in may be deleted under it, as a Desktop update does its app folder.
    yield* Effect.sync(() => {
      process.chdir(dir);
      leaveLauncher();
    });
    const lock = lockOf(dir);
    yield* ensureLockDir(lock);
    // `withLock` breaks a claim whose holder is gone before its last attempt, so a host
    // that crashed leaves nothing for a human to clear.
    return yield* withLock(
      lock,
      Effect.void,
      Effect.gen(function* () {
        // No process can carry an id this host has yet to make.
        const fresh = !(yield* fs.exists(`${dir}/installation`));
        const installation = yield* installationOf(dir);
        yield* markSeenSince(dir, yield* nowIso());
        const checks = yield* hostCheckProcesses({
          dir,
          installation,
          onRun: onLeftoversRun(dir),
          sweep: false,
        });
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
        const stop = yield* boundedStop(lock, checks);
        yield* Effect.logInfo(`collie ${BUILD} host started, pid ${process.pid}`);
        yield* Effect.forkScoped(
          rotateInPlace(outputOf(dir)).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
        );
        yield* Effect.race(own(dir, checks, sweep), orphaned(dir).pipe(Effect.flatMap(stop)));
      }).pipe(Effect.provide(Logger.layer([hostLogger(logOf(dir))], { mergeWithExisting: true }))),
      0,
    );
  }).pipe(Effect.orDie);

/** How long a host told to stop waits for running steps before it exits anyway. */
const stopGrace = Config.Duration("COLLIE_HOST_STOP_GRACE").pipe(
  Config.withDefault(Duration.seconds(5)),
  Effect.orDie,
);
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;
/** Long enough for the log's next flush, which an exit does not wait for. */
const LOG_FLUSH = "200 millis";

/** Any end of a host gives the shutdown the grace, then exits however far it got (ADR-0014). */
const boundedStop = (lock: string, checks: CheckProcessesApi) =>
  Effect.gen(function* () {
    const grace = yield* stopGrace;
    const stopping = yield* Deferred.make<string>();
    // In the outer scope, which closes only once the shutdown it bounds has finished.
    yield* Deferred.await(stopping).pipe(
      Effect.flatMap(Effect.logInfo),
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
      // Let go of here rather than left for the next host to judge stale.
      Effect.andThen(releaseOwnLock(lock)),
      Effect.ignore,
      Effect.andThen(Effect.sync(() => process.exit(1))),
      Effect.forkScoped,
    );
    const signalled = () => Deferred.doneUnsafe(stopping, Effect.succeed("asked to stop"));
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        for (const signal of STOP_SIGNALS) process.once(signal, signalled);
      }),
      () =>
        Effect.sync(() => {
          for (const signal of STOP_SIGNALS) process.off(signal, signalled);
        }),
    );
    return (why: string) => Deferred.succeed(stopping, why).pipe(Effect.asVoid);
  });

/**
 * Resolves, with why, once nothing is left for this host to serve: its lock is gone with the
 * state directory it was in, or the process named in `COLLIE_HOST_WATCH_PID` — whatever it
 * was started to live no longer than, a test's own process — has gone. A host is otherwise
 * meant to outlive the client that started it, so nothing else ends it but a stop.
 *
 * The lock rather than the directory: a host still starting binds its socket in the
 * directory, which makes one again at that path when the old one was just removed.
 */
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
        return "its lock is gone; stopping";
      }
      if (Option.isSome(watched) && !alive(watched.value)) {
        return "the process it watches has exited; stopping";
      }
    }
  });

/**
 * Which module this project runs for this id, as the search path answers it. The registry
 * is given this rather than reaching for discovery itself, so a parent starting a child
 * selects in the parent's own project exactly as a start from a front door does.
 */
const locateIn =
  (install: { readonly pluginRoot: string; readonly userDir: string }): Locate =>
  ({ project, id }) =>
    discover(searchPath({ ...install, project })).pipe(
      Effect.flatMap((found) => {
        const entry = found.entries.find((one) => one.id === id);
        if (entry !== undefined) {
          return Effect.succeed({ entry: entry.path, revision: entry.revision });
        }
        // A file the search path refuses is refused here by name: what it was written to
        // override is not what the author asked to run.
        const problem = found.problems.find((one) => one.id === id);
        return new HostRefused({
          reason:
            problem === undefined
              ? `no workflow "${id}" is saved for ${project}`
              : `${problem.path}: ${problem.message}`,
        });
      }),
    );

const isCrashPoint = Schema.is(Schema.Literals(["admitted", "executed", "answered", "reported"]));

/** Where a test has this host kill itself mid-start; unset for every other host. */
const crashPoint = Config.option(Config.String("COLLIE_HOST_CRASH_AT")).pipe(
  Effect.map((set) => Option.filter(set, isCrashPoint).pipe(Option.getOrUndefined)),
  Effect.orDie,
);

/**
 * Whether a test has this host take a seconds field in a Schedule's cron, and read the
 * engine's storage each second so such an occurrence is not late; unset everywhere else.
 */
const scheduleSeconds = Config.option(Config.String("COLLIE_HOST_SCHEDULE_SECONDS")).pipe(
  Effect.map((set) => Option.getOrUndefined(set) === "1"),
  Effect.orDie,
);

const own = (dir: string, checks: CheckProcessesApi, onceAnswering: Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = yield* currentEnv.pipe(Effect.orDie);
    const crashAt = yield* crashPoint;
    const seconds = yield* scheduleSeconds;
    const bun = yield* Effect.context<BunServices>();
    const herdr = new Herdr(env);
    // Under the lock, so anything at this path belongs to a host that is gone: a unix
    // socket cannot be bound while its file is there, and a dead host's is still there.
    yield* fs.remove(socketOf(dir), { force: true }).pipe(Effect.orDie);
    const pid = yield* currentPid;
    const record = (herd: string | null) =>
      fs.writeFileString(
        recordOf(dir),
        encodeRecord({ pid, build: BUILD, root: env.pluginRoot, herd }),
      );
    const herdSocket = env.socketPath ?? (yield* serverSocket(herdr));
    yield* record(herdSocket).pipe(Effect.orDie);
    if (herdSocket === null) yield* Effect.logWarning(HERDLESS);
    const locate = serverSocket(herdr).pipe(
      Effect.tap((found) => (found === null ? Effect.void : record(found).pipe(Effect.ignore))),
    );
    const installation = yield* installationOf(dir).pipe(Effect.orDie);
    const installed = yield* installedRelease(env.pluginRoot, env.collieDir, BUILD);
    const development: Development = installed.release ? {} : { development: installed.build };
    // One reader of this Machine's usage, so every door and every choice of agent paces as one.
    const usage = yield* Usage;
    const panels: MrPanels = new Map();
    const declared: Declared = new Map();
    const stamp = yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
    const peers = yield* startPeers({
      dir,
      userDir: env.userDir,
      build: BUILD,
      ...development,
      connect: (peer) => connectPeer(dir, peer.name, { as: "host", client: machineName(), stamp }),
      installation,
      stamp,
      socket: socketOf(dir),
      machines: herdr.machineList().pipe(
        Effect.map((machines): ReadonlyArray<SshMachine> => machines),
        Effect.orElseSucceed(() => null),
        Effect.provideContext(bun),
      ),
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
    return yield* Layer.launch(
      RpcServer.layer(AllRpcs.middleware(SlowRpcs)).pipe(
        Layer.provide(
          Layer.mergeAll(
            handlers(dir, installation, development, declared, peers),
            frontDoorHandlers(dir, installation, development, panels, declared, stamp),
            sideJobsLayer(panels),
            questionsLayer,
            slowRpcsLayer,
            Layer.effectDiscard(
              Effect.gen(function* () {
                const { reportsLayer } = yield* Effect.promise(() => import("./reports"));
                yield* Layer.build(reportsLayer({ env, installation, stamp, crashAt }));
              }),
            ),
          ).pipe(
            Layer.provide(sharedBoardLayer(dir)),
            Layer.provide(
              Layer.mergeAll(
                schedulesLayer({ dir, env: { ...env, stateDir: dir }, installation, seconds }).pipe(
                  Layer.provideMerge(
                    registryLayer(dir, {
                      locate: locateIn(env),
                      userDir: env.userDir,
                      crashAt,
                      namesTasks: true,
                      placing: { herdr, env: { ...env, stateDir: dir } },
                    }),
                  ),
                ),
                Layer.succeed(Usage, usage),
              ),
            ),
          ),
        ),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(serialization),
        Layer.provide(BunSocketServer.layer({ path: socketOf(dir) })),
        Layer.provide(
          foundationLayer({
            dir,
            userDir: env.userDir,
            toast: (title, body, sound) =>
              herdr.notify(title, body, sound).pipe(Effect.provideContext(bun), Effect.ignore),
            herd: { socketPath: herdSocket, pluginRoot: env.pluginRoot, locate },
            readings: usage.readings,
            messagePoll: seconds ? "1 second" : undefined,
          }).pipe(Layer.provideMerge(Layer.succeed(CheckProcesses, checks))),
        ),
        Layer.provide(yield* configuredAgents(dir, usage.readings)),
        Layer.provide(forgeHttpLayer),
        Layer.tap(() => Effect.forkScoped(onceAnswering)),
      ),
    );
  }).pipe(Effect.provide(usageLayer), Effect.orDie);

/**
 * A client of the host that owns `dir`, starting one if nothing is there. Every client
 * gets the same host, and the first of them pays for it.
 *
 * `build` is what this client is. A host older than it is replaced: stopped and started
 * again as this build, which recovers what the old one left, so an upgrade can never
 * leave the two apart. A host newer than it is reported rather than talked to — the client is what is
 * stale, and it must not take the host back down to its own build.
 */
export const connect = (
  dir: string,
  options?: {
    readonly build?: string;
    /** More of the environment a host started from here is given, over this process's own. */
    readonly hostEnv?: Readonly<Record<string, string>>;
  },
): Effect.Effect<
  HostClient,
  HostUnavailable | HostVersionMismatch,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const build = options?.build ?? BUILD;
    const hostEnv = options?.hostEnv ?? {};
    let who = yield* ensureRunning(dir, hostEnv, build);
    // Only a newer copy of the same installation upgrades the host; a dev checkout is not one.
    const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
    const ours = who.root === undefined || sameInstallation(who.root, install);
    const replaced = ours && newer(build, who.build);
    if (replaced) {
      yield* stopOwner(dir, who.pid);
      who = yield* ensureRunning(dir, hostEnv, build);
    }
    if (who.build !== build) {
      return yield* new HostVersionMismatch({
        dir,
        host: who.build,
        client: build,
        pid: who.pid,
        restart: ours
          ? `the host for ${dir} is collie ${who.build} and this is ${build}: run \`collie host restart\` and run this again`
          : `the host for ${dir} serves ${who.root} and this is collie ${build} from ${install}: point HERDR_PLUGIN_STATE_DIR at a directory of its own, or run \`collie host restart\` and run this again`,
      });
    }
    // What the old host was doing is the new one's startup recovery, not this client's wait.
    return yield* open(dir);
  });

/** A host as a restart names it; `build` is null for one that owned the directory but did not answer. */
export interface HostSeen {
  readonly pid: number;
  readonly build: string | null;
}

/**
 * Replaces whatever host owns `dir` with this install's, by the same stop and start a newer
 * client uses: the new host recovers what the old one left, as on any start (ADR-0015).
 */
export const restartHost = Effect.fn("Host.restart")(function* (
  dir: string,
  options?: { readonly build?: string; readonly hostEnv?: Readonly<Record<string, string>> },
) {
  const owner = yield* liveOwner(dir);
  let before: HostSeen | null = null;
  if (owner !== null) {
    const answered = yield* ask(dir).pipe(Effect.option);
    before = {
      pid: owner.pid,
      build: Option.match(answered, { onNone: () => null, onSome: (who) => who.build }),
    };
    yield* stopOwner(dir, owner.pid);
  }
  const who = yield* ensureRunning(dir, options?.hostEnv ?? {}, options?.build ?? BUILD);
  return { before, after: { pid: who.pid, build: who.build } };
});

/** What a restart did, in the sentence every door says it with. */
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

/** What a stopping host is given beyond its grace, and a killed one to be gone. */
const STOP_SLACK = Duration.seconds(5);

/**
 * Stops the host at `pid` and waits for it to let go of the directory, by the clock rather
 * than by a count of polls so that load cannot stretch it. One that is still there after
 * its stop grace is killed: its work is durable, and the next host recovers it.
 */
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
  if (yield* goneWithin(Duration.sum(yield* stopGrace, STOP_SLACK))) return;
  yield* signalProcess(pid, "SIGKILL");
  if (yield* goneWithin(STOP_SLACK)) return;
  return yield* unavailable(dir, `pid ${pid} owns the directory and did not stop`);
});

/** One connection, in the caller's scope: theirs to keep, and theirs to close. */
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

/**
 * The public door of the host already answering at `socket`. Nothing is started or stopped
 * from here, so a client on another Machine can never reach for a process of its own.
 */
export const frontDoor = (socket: string) => openGroup(socket, FrontDoorRpcs);

/**
 * A connection through this Machine's relay to a peer, opened as the front door its
 * header names, once the relay says the peer answered.
 */
export const peerChannel = (stateDir: string, name: string, header: RelayHeader) =>
  Effect.acquireRelease(
    Effect.callback<NetSocket, HostUnavailable | MachineUnreachable>((resume) => {
      const path = relayOf(stateDir, name);
      const conn = createConnection(path);
      let seen = Buffer.alloc(0);
      const take = (chunk: Buffer) => {
        seen = Buffer.concat([seen, chunk]);
        const end = seen.indexOf(10);
        if (end === -1) return;
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
        if (rest.length > 0) conn.unshift(rest);
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

const encodeHeader = Schema.encodeSync(RelayHeaderJson);

/**
 * A client of a peer's host, over this Machine's relay to it. It is asked who it is and
 * never started or stopped from here (ADR-0057 D6): another build is refused, naming both.
 */
export const connectPeer = (
  stateDir: string,
  name: string,
  header: RelayHeader,
  options?: { readonly build?: string },
): Effect.Effect<
  HostClient,
  HostUnavailable | HostVersionMismatch | MachineUnreachable,
  Scope.Scope
> => {
  const build = options?.build ?? BUILD;
  let mismatch: HostVersionMismatch | undefined;
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
    if (who.build !== build && header.as !== "host")
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
    return client;
  }).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => {
        if (cause instanceof HostVersionMismatch) mismatch = cause;
      }),
    ),
    Effect.retry({
      while: () =>
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

export const HERDLESS = "this host has no Herd: judgements will be skipped";

/**
 * The Herd the live host of `dir` works for, by its herdr socket, or null for one with none.
 * Undefined where no host is running, or one too old to say.
 */
export const herdOfHost = Effect.fn("Host.herdOfHost")(function* (dir: string) {
  const owner = yield* liveOwner(dir);
  if (owner === null) return undefined;
  const recorded = yield* (yield* FileSystem.FileSystem)
    .readFileString(recordOf(dir))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostRecord)), Effect.option);
  return Option.isSome(recorded) && recorded.value.pid === owner.pid
    ? recorded.value.herd
    : undefined;
});

/** Which process owns this directory, or null when none does. */
export const ownerOf = (
  dir: string,
): Effect.Effect<LockHolder | null, never, FileSystem.FileSystem> => lockHolder(lockOf(dir));

/** The owner of this directory while it lives; a claim a dead host left is nobody's. */
const liveOwner = (dir: string) =>
  ownerOf(dir).pipe(
    Effect.flatMap((owner) =>
      owner === null
        ? Effect.succeed(null)
        : Effect.map(holderLives(owner), (lives) => (lives ? owner : null)),
    ),
  );

/** How long a client waits for a host to answer before it says why none does. */
const HOST_START_TIMEOUT = "30 seconds";
/** A host that takes longer than this to say who it is cannot serve anything anyway. */
const ASK_TIMEOUT = "5 seconds";
/** A peer is asked once its relay has tried each way to it. */
const REACH_TIMEOUT = Duration.sum(
  Duration.fromInputUnsafe(LADDER_BOUND),
  Duration.fromInputUnsafe(ASK_TIMEOUT),
);

/**
 * The owner of `dir` when it does not answer and recorded itself as an older build of this
 * installation: a client that cannot ask it can still replace it.
 */
const olderSilentOwner = Effect.fn("Host.olderSilentOwner")(function* (dir: string, build: string) {
  const owner = yield* liveOwner(dir);
  if (owner === null) return null;
  const fs = yield* FileSystem.FileSystem;
  const recorded = yield* fs
    .readFileString(recordOf(dir))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostRecord)), Effect.option);
  if (Option.isNone(recorded) || recorded.value.pid !== owner.pid) return null;
  const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
  return sameInstallation(recorded.value.root, install) && newer(build, recorded.value.build)
    ? owner.pid
    : null;
});

/**
 * Whether a host serving `served` is this installation's: the same root, or the clone install
 * whose release this client was placed inside.
 * ponytail: the `/release` case goes once no host still serves a clone install.
 */
const sameInstallation = (served: string, install: string) =>
  served === install || install === `${served}/release`;

/**
 * A host answering at this directory, started here if there was none, and asked who it
 * is. Several clients may arrive at once and all start one; the lock decides which of
 * those keeps running, so what they converge on is one owner rather than one starter.
 *
 * Asking is the whole probe: a socket that opens proves a file, and only an answer
 * proves a host.
 */
const ensureRunning = Effect.fn("Host.ensureRunning")(function* (
  dir: string,
  hostEnv: Readonly<Record<string, string>>,
  build: string,
) {
  const first = yield* ask(dir).pipe(Effect.result);
  if (first._tag === "Success") return first.success;
  const silent = yield* olderSilentOwner(dir, build);
  if (silent !== null) yield* stopOwner(dir, silent);
  const started = Effect.scoped(
    Effect.gen(function* () {
      const host = yield* spawnHost(dir, hostEnv);
      // The host this started has ended and nothing owns the directory: no answer is
      // coming, so it is said now rather than after every retry. A host that lost the
      // race to another starter ends too, but then the winner owns the lock.
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
    // The owner it lost to has gone since, so nothing is starting.
    Effect.retry({ times: 2, while: () => Effect.map(liveOwner(dir), (owner) => owner === null) }),
    Effect.timeoutOrElse({ duration: HOST_START_TIMEOUT, orElse: () => diagnose(dir) }),
    Effect.catch(() => diagnose(dir)),
  );
});

/** One question, and hang up: the connection a client keeps is opened once it is theirs. */
const ask = (dir: string) =>
  Effect.scoped(open(dir).pipe(Effect.flatMap((client) => client.identity()))).pipe(
    Effect.timeoutOrElse({
      duration: ASK_TIMEOUT,
      orElse: () => unavailable(dir, `no answer on ${socketOf(dir)} within ${ASK_TIMEOUT}`),
    }),
  );

/** Why nothing answered, said with what can be seen from here. */
const diagnose = Effect.fn("Host.diagnose")(function* (dir: string) {
  const owner = yield* liveOwner(dir);
  return yield* unavailable(
    dir,
    owner === null
      ? "no host started, and nothing owns the directory"
      : `pid ${owner.pid} owns the directory and is not answering on ${socketOf(dir)}`,
  );
});

/**
 * Starts a host and leaves. Detached and unreferenced, because the point of the host is
 * that it outlives whoever needed it: a CLI command that exits, a board that is closed,
 * a chat turn that ends. There is no terminal it belongs to, so its stdout and stderr are
 * appended to `host.out` by a shell that then becomes the host, keeping its pid.
 */
const spawnHost = Effect.fn("Host.spawn")(function* (
  named: string,
  hostEnv: Readonly<Record<string, string>>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const command = yield* hostCommand;
  // Which installation's and user's workflows this host serves, decided by the client that
  // needed it rather than guessed from wherever the host process happens to start.
  const env = yield* currentEnv.pipe(Effect.orDie);
  const { pluginRoot, userDir } = env;
  return yield* Effect.gen(function* () {
    yield* fs.makeDirectory(named, { recursive: true });
    // The host starts in it, so a relative one would name somewhere else from there.
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
          // A client started by Desktop may carry its launcher's LD_PRELOAD.
          // oxlint-disable-next-line effecttsgo/process-env
          env: withoutLauncher({
            ...process.env,
            ...(env.socketPath !== null && { HERDR_SOCKET_PATH: env.socketPath }),
            ...hostEnv,
            HERDR_PLUGIN_ROOT: pluginRoot,
            COLLIE_USER_DIR: userDir,
          }),
          extendEnv: false,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    );
    // Unreferenced before the caller's scope closes, or the spawner's finalizer kills the
    // host it has just started: it leaves a child alone only once it is unreferenced.
    yield* Effect.asVoid(handle.unref);
    return handle;
  }).pipe(Effect.catch((cause) => unavailable(named, String(cause))));
});

const CommandJson = Schema.fromJsonString(Schema.Array(Schema.String));

/**
 * How to start another copy of this program. The compiled binary is its own executable;
 * running from source it is Bun and the entry it was started with. `COLLIE_HOST` names
 * one path or a JSON array of them, the way `COLLIE_DRIVER` does, for a caller whose own
 * entry is not Collie's — a test suite, above all.
 */
const hostCommand: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
  const override = yield* Config.option(Config.String("COLLIE_HOST"));
  if (override._tag === "Some") {
    const value = override.value;
    if (!value.trimStart().startsWith("[")) return [value];
    return yield* Schema.decodeUnknownEffect(CommandJson)(value).pipe(
      Effect.orElseSucceed(() => [value]),
    );
  }
  // A standalone executable's entry lives in the binary itself, under `/$bunfs`; there
  // is no file to pass, and passing that path would be read as a subcommand.
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}).pipe(Effect.orDie);
