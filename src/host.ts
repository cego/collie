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
  Effect,
  FileSystem,
  Layer,
  Option,
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
import { VerifySpecSchema } from "./verify-spec";
import { currentEnv } from "./env";
import { installation as installedRelease } from "./release";
import { Herdr } from "./herdr";
import { buildBoard, mrOf } from "./board";
import { watchedMr, type MrPanels } from "./merges";
import { shell } from "./mr";
import { fetchRef, followDetail } from "./run-detail";
import { buildRunDetail } from "./views";
import {
  Answered,
  Controlled,
  FrontDoorRpcs,
  HostRefused,
  PROTOCOL,
  Started,
  type FrontDoor,
  type PlanPanel,
} from "./board-model";
import { boardMessages } from "./board-stream";
import { loadDefaults } from "./config";
import { factsOfView } from "./runs";
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
    },
    success: Schema.Array(VerifySpecSchema),
    error: HostRefused,
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
    error: HostRefused,
  }),
);

/** Everything this build serves; a client of another build uses `FrontDoorRpcs` alone. */
const AllRpcs = HostRpcs.merge(FrontDoorRpcs);

export type HostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof AllRpcs>,
  RpcClientError.RpcClientError
>;

const serialization = RpcSerialization.layerNdjson;

/**
 * The handlers, and with them the registry: built in this layer's scope, which is the
 * host's. A client's connection is a scope of its own under it, so a client that goes
 * takes nothing with it — not a registration, not an execution, not another client.
 */
const handlers = (dir: string, installation: string) =>
  HostRpcs.toLayer(
    Effect.gen(function* () {
      const registry = yield* Registry;
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
        grant: ({ runId, name, command }) => registry.grant({ runId, name, command }),
        steer: ({ runId, text, request, operation, agent, mode }) =>
          registry.steer({ runId, text, request, operation, agent, mode }),
      });
    }),
  );

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
    const build = Effect.gen(function* () {
      const alive = yield* aliveIn(yield* liveHerds(herdr, env));
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
    return { env, herdr, bun, runs, build };
  });

/** The merge watch, News and pruning, for as long as this host runs. */
const sideJobsLayer = (dir: string, panels: MrPanels) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { env, herdr, bun, runs, build } = yield* hostBoard(dir);
      yield* Effect.forkScoped(
        sideJobs({ env, herdr, runs, board: build, panels }).pipe(Effect.provideContext(bun)),
      );
    }),
  );

/**
 * The board, built here for every front door. Anything written under the state
 * directory, by this host or anyone else, is a reason to look again.
 */
const frontDoorHandlers = (dir: string, installation: string, panels: MrPanels) =>
  FrontDoorRpcs.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const registry = yield* Registry;
      const hosted = yield* Effect.context<HostServices>();
      const { env, herdr, bun, build } = yield* hostBoard(dir);
      // ponytail: one entry per connection, never removed; prune on disconnect if hosts live for months.
      const declared = new Map<number, FrontDoor>();
      // A finished Run's plan cannot change, so every drawer on it shares one read.
      // ponytail: kept for the host's life; evict by age if a host lives for months.
      const plans = new Map<string, PlanPanel | null>();
      const doorOf = (client: { readonly id: number }) => declared.get(client.id) ?? "cli";
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
      const auditedControl =
        (runId: string, operation: string, request: string, origin: FrontDoor) =>
        <E>(act: Effect.Effect<typeof Controlled.Type, E, HostServices>) =>
          once(trail(runId), { operation, request, origin, result: Controlled }, act).pipe(
            Effect.provideContext(hosted),
          );
      // Debounced apart from the tick, so a burst of writes cannot hold the tick back.
      const changed = Stream.mergeAll(
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
      );
      return FrontDoorRpcs.of({
        declare: ({ frontDoor }, { client }) => {
          const already = declared.get(client.id);
          if (already !== undefined && already !== frontDoor) {
            return Effect.fail(new HostRefused({ reason: `this channel is already ${already}` }));
          }
          return Effect.sync(() => {
            declared.set(client.id, frontDoor);
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
          fresh(
            () => runId,
            { operation: "answer", request, origin: doorOf(client), result: Answered },
            registry.answer({ runId, decision, value, request }),
          ),
        control: ({ runId, control, set, request }, { client }) =>
          auditedControl(
            runId,
            `${set ? "" : "un"}${control}`,
            request,
            doorOf(client),
          )(registry.control({ runId, control, set })),
        resume: ({ runId, request }, { client }) =>
          auditedControl(
            runId,
            "resume",
            request,
            doorOf(client),
          )(
            registry.recover.pipe(
              Effect.andThen(registry.control({ runId, control: "stop", set: false })),
            ),
          ),
        invoke: ({ runId, offer, input, request }, { client }) =>
          fresh(
            () => runId,
            { operation: "invoke", request, origin: doorOf(client), result: Started },
            registry.invoke({ runId, offer, input, request }),
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
        runFile: ({ runId, ref }) =>
          registry.view(runId).pipe(
            Effect.flatMap((view) =>
              view === null
                ? Effect.fail(new HostRefused({ reason: `no Run ${runId}` }))
                : fetchRef(factsOfView(env.stateDir, view), ref),
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
    return yield* Layer.launch(
      RpcServer.layer(AllRpcs).pipe(
        Layer.provide(
          Layer.mergeAll(
            handlers(dir, installation),
            frontDoorHandlers(dir, installation, panels),
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
