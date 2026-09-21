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
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { Config, Data, Effect, FileSystem, Layer, Path, Schedule, Schema, Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import manifest from "../herdr-plugin.toml";
import {
  HostRefused,
  NativeEntryError,
  Registrations,
  RunStatus,
  hostLayer,
  nativeHostLayer,
  registryLayer,
  Registry,
} from "./native";
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
});

const Loaded = Schema.Struct({
  id: Schema.String,
  registration: Schema.String,
  title: Schema.String,
});

const Started = Schema.Struct({ registration: Schema.String, execution: Schema.String });

/**
 * What a client may ask of a host. Both ends read these declarations, so a request is a
 * value with a schema at each hop rather than a shape one side remembers.
 */
export const HostRpcs = RpcGroup.make(
  Rpc.make("identity", { success: Identity }),
  Rpc.make("load", {
    payload: { entry: Schema.String },
    success: Loaded,
    error: NativeEntryError,
  }),
  Rpc.make("registrations", { success: Registrations }),
  Rpc.make("start", {
    payload: {
      id: Schema.String,
      runId: Schema.String,
      input: Schema.Record(Schema.String, Schema.Json),
    },
    success: Started,
    error: HostRefused,
  }),
  Rpc.make("status", {
    payload: { runId: Schema.String },
    success: RunStatus,
    error: HostRefused,
  }),
  Rpc.make("answer", {
    payload: { runId: Schema.String, decision: Schema.String, value: Schema.String },
    error: HostRefused,
  }),
);

export type HostClient = RpcClient.RpcClient<
  RpcGroup.Rpcs<typeof HostRpcs>,
  RpcClientError.RpcClientError
>;

const serialization = RpcSerialization.layerNdjson;

/**
 * The handlers, and with them the registry: built in this layer's scope, which is the
 * host's. A client's connection is a scope of its own under it, so a client that goes
 * takes nothing with it — not a registration, not an execution, not another client.
 */
const handlers = (dir: string) =>
  HostRpcs.toLayer(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const pid = yield* currentPid;
      return HostRpcs.of({
        identity: () => Effect.succeed({ build: BUILD, pid, dir }),
        load: ({ entry }) =>
          registry.load(entry).pipe(
            Effect.map((loaded) => ({
              id: loaded.id,
              registration: loaded.name,
              title: loaded.title,
            })),
          ),
        registrations: () => registry.registrations,
        start: ({ id, runId, input }) => registry.start({ id, runId, input }),
        status: ({ runId }) => registry.status(runId),
        answer: ({ runId, decision, value }) => registry.answer({ runId, decision, value }),
      });
    }),
  );

/**
 * One host, for as long as it owns this directory. It runs until it is interrupted:
 * every resource it holds — the socket, the registrations, the SQLite client and the
 * lock — is released by the scope it was built in.
 *
 * Losing the lock is not a failure. It means a host is already here, which is what the
 * caller wanted; the client that started this one connects to that host instead.
 */
export const serve = (
  dir: string,
): Effect.Effect<
  void,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dir, { recursive: true });
    const lock = lockOf(dir);
    yield* ensureLockDir(lock);
    // `withLock` breaks a claim whose holder is gone before its last attempt, so a host
    // that crashed leaves nothing for a human to clear.
    return yield* withLock(lock, Effect.void, own(dir), 0);
  }).pipe(Effect.orDie);

const own = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Under the lock, so anything at this path belongs to a host that is gone: a unix
    // socket cannot be bound while its file is there, and a dead host's is still there.
    yield* fs.remove(socketOf(dir), { force: true }).pipe(Effect.orDie);
    return yield* Layer.launch(
      RpcServer.layer(HostRpcs).pipe(
        Layer.provide(handlers(dir).pipe(Layer.provide(registryLayer(dir)))),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(serialization),
        Layer.provide(BunSocketServer.layer({ path: socketOf(dir) })),
        Layer.provide(hostLayer({ dir })),
        Layer.provide(nativeHostLayer(dir)),
      ),
    );
  }).pipe(Effect.orDie);

/**
 * A client of the host that owns `dir`, starting one if nothing is there. Every client
 * gets the same host, and the first of them pays for it.
 *
 * `build` is what this client is; a host that says it is something else is reported
 * rather than talked to.
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
    const who = yield* ensureRunning(dir);
    const build = options?.build ?? BUILD;
    if (who.build !== build) {
      return yield* new HostVersionMismatch({
        dir,
        host: who.build,
        client: build,
        pid: who.pid,
        restart: `the host for ${dir} is collie ${who.build} and this is ${build}: stop it (pid ${who.pid}) and run this again`,
      });
    }
    return yield* open(dir);
  });

/** One connection, in the caller's scope: theirs to keep, and theirs to close. */
const open = (dir: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(BunSocket.layerNet({ path: socketOf(dir) })),
        Layer.provide(serialization),
      ),
    );
    return yield* RpcClient.make(HostRpcs).pipe(Effect.provideContext(context));
  }).pipe(Effect.mapError((cause) => unavailable(dir, String(cause))));

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
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(command[0] ?? "collie", [...command.slice(1), "host", "--dir", dir], {
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
