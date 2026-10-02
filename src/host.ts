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

import * as BunSocket from "@effect/platform-bun/BunSocket";
import type { BunServices } from "@effect/platform-bun/BunServices";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import {
  Clock,
  Config,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schedule,
  Schema,
  Scope,
  Stream,
  Struct,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import manifest from "../herdr-plugin.toml";
import {
  EntryError,
  OfferView,
  REFUSED_INPUT,
  Registrations,
  RunStatus,
  RunView,
  Steered,
  foundationLayer,
  registryLayer,
  Registry,
  runDir,
  type HostServices,
  type Locate,
} from "./engine";
import { configuredAgents } from "./agents";
import { Catalogue, discover, searchPath } from "./discovery";
import { sideJobs } from "./side-jobs";
import { once, recordAudit } from "./audit";
import { currentEnv } from "./env";
import { installation as installedRelease } from "./release";
import { Herdr, type AgentInfo } from "./herdr";
import { buildBoard, mrOf } from "./board";
import { watchedMr, type MrPanels } from "./merges";
import { shell } from "./mr";
import { fetchRef, followDetail } from "./run-detail";
import { buildRunDetail } from "./views";
import {
  Answered,
  ASKED_KINDS,
  Controlled,
  Disposition,
  EVIDENCE_GATE,
  FrontDoorRpcs,
  HostRefused,
  PROTOCOL,
  ProposalRefused,
  RUN_FILE_BYTES,
  RequestConflict,
  Started,
  SteerOutcome,
  type FrontDoor,
  type PlanPanel,
} from "./board-model";
import { boardMessages } from "./board-stream";
import { recordDisposition } from "./disposition";
import { ActionSchema, evaluationDeps } from "./evaluator";
import { err, request, steer, type OpResult } from "./operations";
import { REJECTED } from "./envelope";
import {
  appendLine,
  deliveriesOf,
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
  type Actor,
  type ProposalRecord,
} from "./proposals";
import { carryOut, carryOutAsked, followUpField } from "./run-actions";
import { nothingApproved } from "./outcome";
import { approvedFrom, VerifySpecSchema, type VerifySpec } from "./verify-spec";
import { readTask } from "./task";
import { nowIso } from "./time";
import { reason } from "./naming";
import { loadDefaults } from "./config";
import { factsOfView, settled } from "./runs";
import { aliveIn, herdChanges, liveHerds } from "./herds";
import { currentPid, ensureLockDir, lockHolder, withLock, type LockHolder } from "./lock";

/** What a host says it is. A client that is not this stops rather than guessing. */
export const BUILD: string = manifest.version;

const socketOf = (dir: string) => `${dir}/host.sock`;
const lockOf = (dir: string) => `${dir}/host.lock`;

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

const Loaded = Schema.Struct({
  id: Schema.String,
  registration: Schema.String,
  title: Schema.String,
});

/**
 * What a client may ask of a host. Both ends read these declarations, so a request is a
 * value with a schema at each hop rather than a shape one side remembers.
 */
export const HostRpcs = RpcGroup.make(
  Rpc.make("identity", { success: Identity }),
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
  // What a finished Run offers to do next. Through the host because only it holds the
  // module that declared them: an offer is decided by the author's own code against the
  // facts as they are now, never by a card's memory of it.
  Rpc.make("offers", {
    payload: { runId: Schema.String },
    success: Schema.Array(OfferView),
    error: HostRefused,
  }),
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
      operation: Schema.optional(Schema.String),
      agent: Schema.optional(Schema.String),
      mode: Schema.optional(Schema.Literals(["boundary", "now", "interrupt"])),
    },
    success: Steered,
    error: Schema.Union([HostRefused, RequestConflict]),
  }),
);

/** Everything this build serves; a client of another build uses `FrontDoorRpcs` alone. */
const AllRpcs = HostRpcs.merge(FrontDoorRpcs);

export type HostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof AllRpcs>,
  RpcClientError.RpcClientError
>;

const serialization = RpcSerialization.layerNdjson;

/** The front door each connection declared, which every operation it asks is recorded under. */
// ponytail: one entry per connection, never removed; prune on disconnect if hosts live for months.
type Declared = Map<number, FrontDoor>;

/**
 * The handlers, and with them the registry: built in this layer's scope, which is the
 * host's. A client's connection is a scope of its own under it, so a client that goes
 * takes nothing with it — not a registration, not an execution, not another client.
 */
const handlers = (dir: string, installation: string, declared: Declared) =>
  HostRpcs.toLayer(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const bun = yield* Effect.context<BunServices>();
      const pid = yield* currentPid;
      // The installation this host belongs to, which the client that started it named.
      const env = yield* currentEnv.pipe(Effect.orDie);
      const catalogue = (project: string) =>
        discover(searchPath({ pluginRoot: env.pluginRoot, userDir: env.userDir, project }));

      // Checked when the host starts.
      const installed = yield* installedRelease(env.pluginRoot, BUILD);
      const development = installed.release ? {} : { development: installed.build };

      return HostRpcs.of({
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
        runs: ({ task }) => registry.views(task),
        watch: ({ runId }) => registry.watch(runId),
        recover: () => registry.recover,
        offers: ({ runId }) => registry.offers(runId),
        grant: ({ runId, name, command, request }, { client }) =>
          once(
            runDir(dir, runId),
            {
              operation: "grant",
              request,
              origin: declared.get(client.id) ?? "cli",
              asked: { name, command: fromText(toText(command)) },
              result: Schema.Array(VerifySpecSchema),
            },
            registry.grant({ runId, name, command }),
          ).pipe(Effect.provideContext(bun)),
        steer: ({ runId, text, request, operation, agent, mode }, { client }) =>
          once(
            runDir(dir, runId),
            {
              operation: "deliver",
              request,
              origin: declared.get(client.id) ?? "cli",
              asked: {
                text,
                operation: operation ?? null,
                agent: agent ?? null,
                mode: mode ?? null,
              },
              result: Steered,
            },
            registry.steer({ runId, text, request, operation, agent, mode }),
          ).pipe(Effect.provideContext(bun)),
      });
    }),
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
const hostBoard = (dir: string) =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const bun = yield* Effect.context<BunServices>();
    const hosted = yield* Effect.context<HostServices>();
    const env = yield* servingEnv(dir);
    const herdr = new Herdr(env);
    const runs = registry
      .views(null)
      .pipe(Effect.map((views) => views.map((view) => factsOfView(env.stateDir, view))));
    const boardOf = (alive: ReadonlyArray<AgentInfo>) =>
      Effect.gen(function* () {
        return yield* buildBoard({
          env,
          runs: yield* runs,
          alive,
          quietMs: (yield* loadDefaults(env.userDir)).boardQuietMs,
          offers: (runId) =>
            registry.offers(runId).pipe(
              Effect.provideContext(hosted),
              Effect.orElseSucceed(() => []),
            ),
        });
      }).pipe(Effect.provideContext(bun));
    const build = Effect.flatMap(
      Effect.flatMap(liveHerds(herdr, env), aliveIn).pipe(Effect.provideContext(bun)),
      boardOf,
    );
    // What ended and what it opened needs no herdr: the merge watch asks nobody's panes.
    const unattended = boardOf([]);
    return { env, herdr, bun, runs, build, unattended };
  });

/** The merge watch, News and pruning, for as long as this host runs. */
const sideJobsLayer = (dir: string, panels: MrPanels) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { env, herdr, bun, runs, unattended } = yield* hostBoard(dir);
      yield* Effect.forkScoped(
        sideJobs({ env, herdr, runs, board: unattended, panels }).pipe(Effect.provideContext(bun)),
      );
    }),
  );

/**
 * The board, built here for every front door. Anything written under the state
 * directory, by this host or anyone else, is a reason to look again.
 */
const frontDoorHandlers = (
  dir: string,
  installation: string,
  panels: MrPanels,
  declared: Declared,
) =>
  FrontDoorRpcs.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registry = yield* Registry;
      const hosted = yield* Effect.context<HostServices>();
      const { env, herdr, bun, build } = yield* hostBoard(dir);
      // A finished Run's plan cannot change, so every drawer on it shares one read.
      // ponytail: kept for the host's life; evict by age if a host lives for months.
      const plans = new Map<string, PlanPanel | null>();
      const doorOf = (client: { readonly id: number }) => declared.get(client.id) ?? "cli";
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
        return session === undefined ? env : { ...env, socketPath: session };
      };
      const trail = (runId: string) => runDir(env.stateDir, runId);
      /** An operation that is idempotent by itself, recorded the first time it does anything. */
      // ponytail: a host that dies between acting and recording leaves that one unrecorded.
      const fresh = <A extends { readonly fresh: boolean }, I extends Schema.Json, E>(
        runId: (value: A) => string,
        line: {
          readonly operation: string;
          readonly request: string;
          readonly origin: FrontDoor;
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
        (runId: string, operation: string, request: string, origin: FrontDoor, reason?: string) =>
        <E>(act: Effect.Effect<typeof Controlled.Type, E, HostServices>) =>
          Effect.andThen(
            known(runId),
            once(
              trail(runId),
              {
                operation,
                request,
                origin,
                reason,
                asked: { reason: reason ?? null },
                result: Controlled,
              },
              act,
            ),
          ).pipe(Effect.provideContext(hosted));
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
      const takeUp = (runId: string) =>
        registry.recover.pipe(
          Effect.andThen(registry.control({ runId, control: "stop", set: false })),
        );
      /**
       * A gate answered: the checks named, or every one the checkout and config offer, are
       * granted as `set_verification` grants them, then the Run is taken up again.
       */
      const passGate = (runId: string, value: string, actor: Actor) =>
        Effect.gen(function* () {
          const run = factsOfView(env.stateDir, yield* known(runId));
          if (run.parked !== nothingApproved(runId))
            return yield* new HostRefused({
              reason: `${runId} is not holding at its evidence gate`,
            });
          if (value !== "approve" && !value.startsWith("approve:"))
            return yield* new HostRefused({
              reason: `${REFUSED_INPUT}: the gate is answered with approve or approve:<name>,<name>; with nothing approved no check could prove this Run, so it is not skipped`,
            });
          const offered = yield* approvedFrom({ cwd: run.cwd, userDir: env.userDir }).pipe(
            Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => []),
          );
          const named =
            value === "approve"
              ? null
              : value
                  .slice("approve:".length)
                  .split(",")
                  .map((one) => one.trim());
          const unknown = (named ?? []).filter(
            (name) => !offered.some((spec) => spec.name === name),
          );
          if (unknown.length > 0)
            return yield* new HostRefused({
              reason: `${REFUSED_INPUT}: the gate offers no check called ${unknown.join(", ")}`,
            });
          const chosen = offered.filter((spec) => named === null || named.includes(spec.name));
          if (chosen.length === 0)
            return yield* new HostRefused({
              reason: `${REFUSED_INPUT}: ${nothingApproved(runId)}`,
            });
          const granted = yield* carryOutAsked(
            env,
            chosen.map(({ name, ...command }) => ({
              kind: "set_verification" as const,
              run: runId,
              name,
              command,
            })),
            actor,
          );
          const failed = granted.find((one) => one.state !== "applied");
          if (failed !== undefined) return yield* new HostRefused({ reason: failed.note });
          yield* takeUp(runId);
          return { runId, decision: EVIDENCE_GATE, value, fresh: true };
        });
      // Debounced apart from the tick, so a burst of writes cannot hold the tick back.
      // Shared, so every subscriber rides one recursive watch: setting one up walks the tree.
      const changed = yield* Stream.mergeAll(
        [
          fs.watch(dir, { recursive: true }).pipe(
            Stream.catch(() => Stream.empty),
            Stream.debounce("200 millis"),
            Stream.map(() => undefined),
          ),
          Stream.tick(BOARD_TICK),
          herdChanges(herdr, env).pipe(
            Stream.provideContext(bun),
            Stream.catch(() => Stream.empty),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.share({ capacity: 1, strategy: "sliding" }));
      return FrontDoorRpcs.of({
        declare: ({ frontDoor, session }, { client }) => {
          const already = declared.get(client.id);
          if (already !== undefined && already !== frontDoor) {
            return Effect.fail(new HostRefused({ reason: `this channel is already ${already}` }));
          }
          return Effect.sync(() => {
            declared.set(client.id, frontDoor);
            if (session !== undefined && session !== null) sessions.set(client.id, session);
          });
        },
        start: (
          {
            project,
            id,
            request,
            input,
            text,
            inferred,
            root,
            options,
            task,
            taskLabel,
            parent,
            intent,
            verify,
          },
          { client },
        ) =>
          fresh(
            (started) => started.runId,
            { operation: "start", request, origin: doorOf(client), result: Started },
            registry.resolve({ project, id }).pipe(
              Effect.flatMap((generation) =>
                registry.start({
                  generation,
                  project,
                  request,
                  input,
                  text,
                  inferred,
                  root,
                  options,
                  task,
                  taskLabel,
                  parent,
                  intent,
                  verify,
                }),
              ),
            ),
          ),
        answer: ({ runId, decision, value, request }, { client }) =>
          decision === EVIDENCE_GATE
            ? once(
                trail(runId),
                {
                  operation: "answer",
                  request,
                  origin: doorOf(client),
                  asked: { value },
                  result: Answered,
                },
                passGate(runId, value, { origin: doorOf(client), requestId: request }),
              ).pipe(plainly)
            : fresh(
                () => runId,
                { operation: "answer", request, origin: doorOf(client), result: Answered },
                registry.answer({ runId, decision, value, request }),
              ),
        control: ({ runId, control, set, request, reason }, { client }) =>
          auditedControl(
            runId,
            `${set ? "" : "un"}${control}`,
            request,
            doorOf(client),
            reason,
          )(registry.control({ runId, control, set })),
        resume: ({ runId, request }, { client }) =>
          auditedControl(runId, "resume", request, doorOf(client))(takeUp(runId)),
        invoke: ({ runId, offer, input, request }, { client }) =>
          fresh(
            () => runId,
            { operation: "invoke", request, origin: doorOf(client), result: Started },
            registry.invoke({ runId, offer, input, request }),
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
                        origin: doorOf(client),
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
              ? decline(file, proposal, { origin: doorOf(client), requestId: request }).pipe(
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
        propose: ({ herd, interpretation, actions, request: requestId }, { client }) =>
          Effect.gen(function* () {
            const asker = askerEnv(client);
            const decoded = Schema.decodeUnknownOption(Schema.Array(ActionSchema))(actions);
            if (Option.isNone(decoded))
              return outcomeOf(
                err("invalid_input", "An action is not one of the kinds Collie takes."),
              );
            const key =
              herd ??
              (yield* herdOf(asker.socketPath).pipe(Effect.catch(() => Effect.succeed(null))));
            if (key === null)
              return outcomeOf(err("invalid_state", "No Herd to keep the request in."));
            const actor = { origin: doorOf(client), requestId };
            return yield* once(
              yield* herdDir(env.stateDir, key),
              {
                operation: "propose",
                request: requestId,
                origin: actor.origin,
                asked: { interpretation, actions },
                result: SteerOutcome,
              },
              // A refusal is not kept against its request, so it can be asked again corrected.
              request(asker, key, { interpretation, actions: decoded.value, actor }).pipe(
                Effect.flatMap((result) =>
                  !result.ok && REJECTED.includes(result.error.code)
                    ? Effect.fail(new SteerUnanswered({ outcome: outcomeOf(result) }))
                    : Effect.succeed(outcomeOf(result)),
                ),
              ),
            );
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(SteerUnanswered)(cause)
                  ? cause.outcome
                  : Schema.is(RequestConflict)(cause)
                    ? outcomeOf(err("invalid_input", cause.reason))
                    : outcomeOf(
                        err("operation_failed", `Collie could not do it: ${reason(cause)}.`),
                      ),
              ),
            ),
            Effect.provideContext(bun),
            Effect.provideContext(hosted),
          ),
        act: ({ actions, request }, { client }) =>
          plainly(
            Schema.decodeUnknownEffect(Schema.Array(ActionSchema))(actions).pipe(
              Effect.mapError(
                () =>
                  new HostRefused({
                    reason: `${REFUSED_INPUT}: an action is not one of the kinds Collie takes`,
                  }),
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
                      origin: doorOf(client),
                      requestId: request,
                    });
              }),
            ),
          ),
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
                  origin: doorOf(client),
                  asked: { proposal, index, as },
                  result: Schema.Struct({ proposal: Schema.String }),
                },
                Effect.gen(function* () {
                  const done = yield* reconcileStep(file, proposal, index, as, {
                    origin: doorOf(client),
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
        settleDelivery: ({ runId, delivery, as, request }, { client }) =>
          plainly(
            once(
              trail(runId),
              {
                operation: "settle-delivery",
                request,
                origin: doorOf(client),
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
                  actorName({ origin: doorOf(client), requestId: request }),
                  yield* nowIso(),
                );
                if ("error" in settled)
                  return yield* new HostRefused({ reason: `${REFUSED_INPUT}: ${settled.error}` });
                yield* appendLine(found.file, settled);
                return fromText(toText(settled));
              }),
            ),
          ),
        dispose: ({ runId, kind, ref, note, request }, { client }) =>
          known(runId).pipe(
            Effect.andThen(
              once(
                trail(runId),
                {
                  operation: "disposition",
                  request,
                  origin: doorOf(client),
                  asked: { kind, ref, note },
                  result: Disposition,
                },
                Effect.gen(function* () {
                  const line = {
                    at: yield* nowIso(),
                    by: actorName({ origin: doorOf(client), requestId: request }),
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
        steerAbout: ({ runId, text, from, dryRun, request }, { client }) =>
          Effect.gen(function* () {
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
                origin: doorOf(client),
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
                return {
                  ok: true,
                  code: null,
                  human: said.human,
                  data: fromText(toText(said.data)),
                };
              }),
            );
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed(
                Schema.is(SteerUnanswered)(cause)
                  ? cause.outcome
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
          ),
        followUp: ({ runId, text, request }, { client }) =>
          fresh(
            () => runId,
            { operation: "followup", request, origin: doorOf(client), result: Started },
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
              });
            }),
          ),
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
            return yield* buildRunDetail({ env, runId, runs: [run], mr, tail, pages, plans });
          }).pipe(Effect.provideContext(bun));
          return followDetail(detail, changed).pipe(Stream.orDie);
        },
        runFile: ({ runId, ref, offset, length }) =>
          registry.view(runId).pipe(
            Effect.flatMap((view) =>
              view === null
                ? Effect.fail(new HostRefused({ reason: `no Run ${runId}` }))
                : fetchRef(factsOfView(env.stateDir, view), ref, {
                    offset: offset ?? 0,
                    length: length ?? RUN_FILE_BYTES,
                  }),
            ),
            Effect.provideContext(bun),
          ),
        board: () =>
          Stream.unwrap(
            liveHerds(herdr, env).pipe(
              Effect.map((sessions) =>
                boardMessages({
                  head: {
                    installation,
                    build: BUILD,
                    protocol: PROTOCOL,
                    herds: sessions.flatMap(({ herd, name }) =>
                      herd === null ? [] : [name === undefined ? { id: herd } : { id: herd, name }],
                    ),
                  },
                  build,
                  changed,
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

/**
 * One host, for as long as it owns this directory. It runs until it is interrupted:
 * every resource it holds — the socket, the registrations, the SQLite client and the
 * lock — is released by the scope it was built in.
 *
 * Losing the lock is not a failure. It means a host is already here, which is what the
 * caller wanted; the client that started this one connects to that host instead.
 */
export const serve = (dir: string): Effect.Effect<void, never, BunServices | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    const lock = lockOf(dir);
    yield* ensureLockDir(lock);
    // `withLock` breaks a claim whose holder is gone before its last attempt, so a host
    // that crashed leaves nothing for a human to clear.
    return yield* withLock(lock, Effect.void, Effect.race(own(dir), orphaned(dir)), 0);
  }).pipe(Effect.orDie);

/**
 * Resolves once nothing is left for this host to serve: its lock is gone with the state
 * directory it was in, or the process named in `COLLIE_HOST_WATCH_PID` — whatever it was
 * started to live no longer than, a test's own process — has gone. A host is otherwise
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
      if (!(yield* fs.exists(lockOf(dir)).pipe(Effect.orElseSucceed(() => true)))) return;
      if (Option.isSome(watched) && !alive(watched.value)) return;
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

const isCrashPoint = Schema.is(Schema.Literals(["admitted", "executed", "answered"]));

/** Where a test has this host kill itself mid-start; unset for every other host. */
const crashPoint = Config.option(Config.String("COLLIE_HOST_CRASH_AT")).pipe(
  Effect.map((set) => Option.filter(set, isCrashPoint).pipe(Option.getOrUndefined)),
  Effect.orDie,
);

const own = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const env = yield* currentEnv.pipe(Effect.orDie);
    const crashAt = yield* crashPoint;
    const bun = yield* Effect.context<BunServices>();
    const herdr = new Herdr(env);
    // Under the lock, so anything at this path belongs to a host that is gone: a unix
    // socket cannot be bound while its file is there, and a dead host's is still there.
    yield* fs.remove(socketOf(dir), { force: true }).pipe(Effect.orDie);
    const installation = yield* installationOf(dir).pipe(Effect.orDie);
    const panels: MrPanels = new Map();
    const declared: Declared = new Map();
    return yield* Layer.launch(
      RpcServer.layer(AllRpcs).pipe(
        Layer.provide(
          Layer.mergeAll(
            handlers(dir, installation, declared),
            frontDoorHandlers(dir, installation, panels, declared),
            sideJobsLayer(dir, panels),
          ).pipe(
            Layer.provide(
              registryLayer(dir, {
                locate: locateIn(env),
                userDir: env.userDir,
                crashAt,
              }),
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
            herd: { socketPath: env.socketPath, pluginRoot: env.pluginRoot },
          }),
        ),
        Layer.provide(yield* configuredAgents(dir)),
      ),
    );
  }).pipe(Effect.orDie);

/**
 * A client of the host that owns `dir`, starting one if nothing is there. Every client
 * gets the same host, and the first of them pays for it.
 *
 * `build` is what this client is. A host older than it is replaced: stopped, started
 * again as this build, and asked to recover, so an upgrade can never leave the two
 * apart. A host newer than it is reported rather than talked to — the client is what is
 * stale, and it must not take the host back down to its own build.
 */
export const connect = (
  dir: string,
  options?: { readonly build?: string },
): Effect.Effect<
  HostClient,
  HostUnavailable | HostVersionMismatch,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const build = options?.build ?? BUILD;
    let who = yield* ensureRunning(dir);
    // Only a newer copy of the same installation upgrades the host; a dev checkout is not one.
    const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
    const ours = who.root === undefined || who.root === install;
    const replaced = ours && who.build !== build && Bun.semver.order(build, who.build) === 1;
    if (replaced) {
      yield* stopOwner(dir, who.pid);
      who = yield* ensureRunning(dir);
    }
    if (who.build !== build) {
      return yield* new HostVersionMismatch({
        dir,
        host: who.build,
        client: build,
        pid: who.pid,
        restart: ours
          ? `the host for ${dir} is collie ${who.build} and this is ${build}: stop it (pid ${who.pid}) and run this again`
          : `the host for ${dir} serves ${who.root} and this is collie ${build} from ${install}: point HERDR_PLUGIN_STATE_DIR at a directory of its own, or stop that host (pid ${who.pid}) and run this again`,
      });
    }
    const client = yield* open(dir);
    // The engine is durable, so what the old host was doing is picked up, not lost.
    if (replaced) {
      yield* client.recover().pipe(Effect.mapError((cause) => unavailable(dir, String(cause))));
    }
    return client;
  });

/** Stops the host at `pid` and waits for it to let go of the directory. */
const stopOwner = Effect.fn("Host.stopOwner")(function* (dir: string, pid: number) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone, which is what this is for.
  }
  yield* ownerOf(dir).pipe(
    Effect.filterOrFail(
      (owner) => owner?.pid !== pid,
      () => unavailable(dir, `pid ${pid} is an older host and did not stop`),
    ),
    Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
  );
});

/** One connection, in the caller's scope: theirs to keep, and theirs to close. */
const openGroup = <Rpcs extends Rpc.Any>(dir: string, group: RpcGroup.RpcGroup<Rpcs>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(BunSocket.layerNet({ path: socketOf(dir) })),
        Layer.provide(serialization),
      ),
    );
    return yield* RpcClient.make(group).pipe(Effect.provideContext(context));
  }).pipe(Effect.mapError((cause) => unavailable(dir, String(cause))));

const open = (dir: string) => openGroup(dir, AllRpcs);

/**
 * The public door of the host already answering at `dir`. Nothing is started or stopped
 * from here, so a client on another Machine can never reach for a process of its own.
 */
export const frontDoor = (dir: string) => openGroup(dir, FrontDoorRpcs);

const unavailable = (dir: string, reason: string) => new HostUnavailable({ dir, reason });

/** Which process owns this directory, or null when none does. */
export const ownerOf = (
  dir: string,
): Effect.Effect<LockHolder | null, never, FileSystem.FileSystem> => lockHolder(lockOf(dir));

/**
 * A host answering at this directory, started here if there was none, and asked who it
 * is. Several clients may arrive at once and all start one; the lock decides which of
 * those keeps running, so what they converge on is one owner rather than one starter.
 *
 * Asking is the whole probe: a socket that opens proves a file, and only an answer
 * proves a host.
 */
const ensureRunning = Effect.fn("Host.ensureRunning")(function* (dir: string) {
  const first = yield* ask(dir).pipe(Effect.result);
  if (first._tag === "Success") return first.success;
  yield* spawnHost(dir);
  return yield* ask(dir).pipe(
    Effect.retry({ times: 100, schedule: Schedule.spaced("100 millis") }),
    Effect.catch(() => diagnose(dir)),
  );
});

/** One question, and hang up: the connection a client keeps is opened once it is theirs. */
const ask = (dir: string) =>
  Effect.scoped(open(dir).pipe(Effect.flatMap((client) => client.identity())));

/** Why nothing answered, said with what can be seen from here. */
const diagnose = Effect.fn("Host.diagnose")(function* (dir: string) {
  const owner = yield* ownerOf(dir);
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
 * a chat turn that ends. Its stdio is closed for the same reason — there is no terminal
 * it belongs to.
 */
const spawnHost = Effect.fn("Host.spawn")(function* (dir: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* hostCommand;
  // Which installation's workflows this host serves, decided by the client that needed
  // it rather than guessed from wherever the host process happens to start.
  const install = (yield* currentEnv.pipe(Effect.orDie)).pluginRoot;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command[0] ?? "collie", [...command.slice(1), "host", "--dir", dir], {
          env: { HERDR_PLUGIN_ROOT: install },
          extendEnv: true,
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      // Unreferenced before this scope closes, or the spawner's finalizer kills the host
      // it has just started: it leaves a child alone only once it is unreferenced.
      yield* Effect.asVoid(handle.unref);
    }),
  ).pipe(Effect.catch((cause) => unavailable(dir, String(cause))));
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
