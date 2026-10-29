// This Machine's peers (ADR-0057): the pairing each side keeps, the listener a peer that
// dials in reaches, and one relay socket per peer that speaks what `host.sock` speaks.
// Every client reaches another Machine by opening `relayOf(stateDir, name)`, and nothing
// above that path knows there is a WebSocket behind it.

import { createServer, isIP, type Server, type Socket } from "node:net";
// effect/crypto has no X.509 certificate inspection.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { X509Certificate } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import type { ServerWebSocket } from "bun";
import {
  Clock,
  Config,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Schedule,
  Schema,
  Semaphore,
  Path,
  type Scope,
  Stream,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  FrontDoor,
  HostRefused,
  type BoardSnapshot,
  type RequestConflict,
  type SharedSettings,
  type ShellResult,
  type ShellRequest,
} from "./board-model";
import { channelInto } from "./channel";
import { openPeer, REACH_BOUND, type Way } from "./peer-transport";
import {
  closeConnections,
  resolvedHost,
  ride,
  SOCKET_PATH_MAX,
  sshConnection,
  type SshMachine,
} from "./ssh-connection";
import { quoted, remoteCollie } from "./ssh-argv";
import { shell } from "./mr";
import {
  backoff,
  Invited,
  MachineUnreachable,
  PEER_PORT,
  PeersFile,
  RelayHeaderJson,
  Waits,
  AgentAddress,
  AgentAddressJson,
  type HerdrMachine,
  Peer,
  type PeerView,
} from "./peers-model";
import { reason } from "./naming";
import { sharedSettings, takeShared } from "./config";
import { byKey, latestEdits, takeFrom } from "./flock-settings";
import type { SharedDefinition } from "./definitions-model";
import { byPath, landed, sharedDefinitions, takeDefinitions } from "./shared-definitions";
import { nowIso } from "./time";
import { RELEASE_TAG } from "./release";
import type { HostUnavailable, HostVersionMismatch } from "./host";
import type * as RpcClientError from "effect/rpc/RpcClientError";

export const relayOf = (stateDir: string, name: string) => `${stateDir}/peers/${name}.sock`;
const fileOf = (stateDir: string) => `${stateDir}/peers.json`;
export const certOf = (stateDir: string) => `${stateDir}/peer-cert.pem`;
export const keyOf = (stateDir: string) => `${stateDir}/peer-key.pem`;
const listenerCertOf = (stateDir: string) => `${stateDir}/peer-listener-cert.pem`;

/** This Machine as a peer names it, where nothing better is known. */
export const machineName = () => hostname();

export const runShell = Effect.fn("Peers.shell")(
  function* (script: string, stdin?: string) {
    const login = yield* Config.String("SHELL").pipe(Config.withDefault("/bin/sh"));
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(login, ["-lc", script], {
        stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        forceKillAfter: "1 second",
      }),
    );
    let bytes = 0;
    const text = (stream: typeof child.stdout) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runFoldEffect(
          () => "",
          (all, chunk) => {
            bytes += Buffer.byteLength(chunk);
            return bytes > 1_048_576
              ? Effect.fail(new Error("the shell produced more than 1 MiB of output"))
              : Effect.succeed(all + chunk);
          },
        ),
      );
    const [code, stdout, stderr] = yield* Effect.all(
      [child.exitCode, text(child.stdout), text(child.stderr)],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout, stderr };
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () =>
          Effect.fail(new HostRefused({ reason: "the shell did not finish within 10 minutes" })),
      }),
    ),
);

const decodePeers = Schema.decodeUnknownEffect(PeersFile);
const encodePeers = Schema.encodeSync(PeersFile);

/** Every pairing this Machine keeps; none where it has never paired. */
export const peersOf = (stateDir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(fileOf(stateDir))),
    Effect.flatMap(decodePeers),
    Effect.orElseSucceed((): ReadonlyArray<Peer> => []),
  );

const writePeers = Effect.fn("Peers.write")(function* (
  stateDir: string,
  peers: ReadonlyArray<Peer>,
) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = `${fileOf(stateDir)}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, `${encodePeers(peers)}\n`, { mode: 0o600 });
  yield* fs.chmod(tmp, 0o600);
  yield* fs.rename(tmp, fileOf(stateDir));
});

const samePeer = Schema.toEquivalence(Peer);

const port = Config.Int("COLLIE_PEER_PORT").pipe(Config.withDefault(PEER_PORT), Effect.orDie);
const bindHost = Config.String("COLLIE_PEER_HOST").pipe(
  Config.withDefault("0.0.0.0"),
  Effect.orDie,
);

/** Whether a secret is this one, without saying how much of it matched. */
const sameSecret = (given: string, kept: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(kept);
  if (a.length !== b.length) return false;
  let differ = 0;
  for (let at = 0; at < a.length; at++) differ |= a[at]! ^ b[at]!;
  return differ === 0;
};

/** The names and addresses this Machine may be dialled by, and the one the asker will use. */
const namesFor = (address: string | null) => {
  const ips = Object.values(networkInterfaces())
    .flat()
    .flatMap((one) => (one === undefined ? [] : [one.address]));
  const names = [hostname(), "localhost", ...(address === null ? [] : [address])];
  const ip = /^[\d.]+$|:/;
  return [...new Set([...names, ...ips, "127.0.0.1"])].map((one) =>
    ip.test(one) ? `IP:${one}` : `DNS:${one}`,
  );
};

/** This Machine's certificate, made once with `openssl`. */
export const certificateFor = Effect.fn("Peers.certificateFor")(function* (
  stateDir: string,
  address: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const kept = yield* fs.readFileString(certOf(stateDir)).pipe(Effect.option);
  if (Option.isSome(kept)) return kept.value;
  const made = yield* shell(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      keyOf(stateDir),
      "-out",
      certOf(stateDir),
      "-days",
      "3650",
      "-subj",
      "/CN=collie",
      "-addext",
      `subjectAltName=${namesFor(address).join(",")}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    stateDir,
  );
  if (made.code !== 0)
    return yield* new HostRefused({
      reason: `openssl could not make this Machine's certificate: ${(made.stderr ?? "").trim() || `exit ${made.code}`}`,
    });
  yield* fs.chmod(keyOf(stateDir), 0o600);
  yield* fs.chmod(certOf(stateDir), 0o600);
  return yield* fs.readFileString(certOf(stateDir));
});

/** An address certificate signed by the original pin, keeping every previously invited alias. */
const listenerCertificateFor = Effect.fn("Peers.listenerCertificateFor")(function* (
  stateDir: string,
  address: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const current = yield* fs
    .readFileString(listenerCertOf(stateDir))
    .pipe(Effect.catch(() => fs.readFileString(certOf(stateDir))));
  const issued = new X509Certificate(current);
  if (
    address === null ||
    (isIP(address) ? issued.checkIP(address) : issued.checkHost(address)) !== undefined
  )
    return current;
  const present = (issued.subjectAltName ?? "")
    .split(", ")
    .map((name) => name.replace("IP Address:", "IP:"));
  const needed = namesFor(address);
  const csr = `${stateDir}/peer-listener.csr`;
  const extensions = `${stateDir}/peer-listener.ext`;
  const next = `${listenerCertOf(stateDir)}.next`;
  yield* fs.writeFileString(
    extensions,
    `subjectAltName=${[...new Set([...present, ...needed])].join(",")}\nbasicConstraints=critical,CA:FALSE\n`,
    { mode: 0o600 },
  );
  const commands = [
    ["req", "-new", "-key", keyOf(stateDir), "-out", csr, "-subj", "/CN=collie-listener"],
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      certOf(stateDir),
      "-CAkey",
      keyOf(stateDir),
      "-set_serial",
      `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex")}`,
      "-out",
      next,
      "-days",
      "3650",
      "-extfile",
      extensions,
    ],
  ];
  for (const args of commands) {
    const made = yield* shell("openssl", args, stateDir);
    if (made.code !== 0)
      return yield* new HostRefused({
        reason: `openssl could not sign this Machine's listener certificate: ${(made.stderr ?? "").trim() || `exit ${made.code}`}`,
      });
  }
  yield* fs.chmod(next, 0o600);
  yield* fs.rename(next, listenerCertOf(stateDir));
  yield* fs.remove(csr);
  yield* fs.remove(extensions);
  return yield* fs.readFileString(listenerCertOf(stateDir));
});

type PeerCallFailure = HostRefused | RequestConflict | RpcClientError.RpcClientError;
export interface PeerClient {
  readonly identity: () => Effect.Effect<
    Pick<BoardSnapshot, "build" | "development">,
    PeerCallFailure
  >;
  readonly shell: (asked: ShellRequest) => Effect.Effect<ShellResult, PeerCallFailure>;
  readonly refresh: (
    asked: Pick<ShellRequest, "request">,
  ) => Effect.Effect<boolean, PeerCallFailure>;
  readonly settings: () => Effect.Effect<SharedSettings, PeerCallFailure>;
  readonly setSettings: (
    asked: Pick<SharedSettings, "settings"> & Pick<ShellRequest, "request">,
  ) => Effect.Effect<SharedSettings, PeerCallFailure>;
  readonly sharedDefinitions: () => Effect.Effect<ReadonlyArray<SharedDefinition>, PeerCallFailure>;
  readonly setSharedDefinitions: (asked: {
    readonly definitions: ReadonlyArray<SharedDefinition>;
    readonly request: string;
  }) => Effect.Effect<ReadonlyArray<SharedDefinition>, PeerCallFailure>;
}

/** What a peer link reaches its own host with, which only it may declare `from.machine` with. */
export interface Link {
  readonly dir: string;
  readonly userDir: string;
  readonly build: string;
  readonly development?: string;
  readonly connect: (
    peer: Peer,
  ) => Effect.Effect<
    PeerClient,
    HostUnavailable | HostVersionMismatch | MachineUnreachable,
    Scope.Scope
  >;
  readonly installation: string;
  /** This host's own, which a front door cannot know. */
  readonly stamp: string;
  /** This host's socket, which a channel from a peer is declared on. */
  readonly socket: string;
  /** Tells a peer this Machine has forgotten it, over its relay. */
  readonly tell: (peer: Peer) => Effect.Effect<void>;
  /** herdr's machines, or null where herdr could not say. */
  readonly machines: Effect.Effect<ReadonlyArray<SshMachine> | null>;
}

export const levelPeer = Effect.fn("Peers.level")(function* (link: Link, peer: Peer) {
  const door = yield* link.connect(peer);
  const who = yield* door.identity();
  if (
    link.development !== undefined ||
    !RELEASE_TAG.test(link.build) ||
    who.development !== undefined ||
    !RELEASE_TAG.test(who.build) ||
    Bun.semver.order(link.build, who.build) <= 0
  )
    return who.development ?? who.build;
  yield* Effect.logInfo(`bringing ${peer.name} from ${who.build} to ${link.build}`);
  const result = yield* door.shell({
    script: `collie --json upgrade --to ${quoted(link.build)}`,
    request: `level:${link.installation}:${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`,
  });
  if (result.code !== 0)
    return yield* new HostRefused({
      reason: `upgrade to ${link.build} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    });
  yield* door.refresh({
    request: `refresh:${link.installation}:${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`,
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const after = yield* link.connect(peer);
      const now = yield* after.identity();
      if (now.build !== link.build)
        return yield* new HostRefused({
          reason: `${peer.name} still runs ${now.build} after upgrading to ${link.build}`,
        });
      return now.build;
    }),
  ).pipe(
    Effect.retry({ schedule: Schedule.spaced("500 millis") }),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () =>
        Effect.fail(
          new HostRefused({
            reason: `${peer.name} did not replace its host after upgrading to ${link.build}`,
          }),
        ),
    }),
  );
}, Effect.scoped);

/** What this host's peers module answers. */
export interface Peers {
  readonly invite: (asker: {
    readonly installation: string;
    readonly name: string;
    readonly address: string | null;
  }) => Effect.Effect<Invited, HostRefused>;
  readonly add: (peer: Peer) => Effect.Effect<void, HostRefused>;
  readonly forget: (installation: string) => Effect.Effect<void>;
  readonly list: Effect.Effect<ReadonlyArray<PeerView>>;
  /** Ends the backoff of the link to the peer this Machine dials by that name. */
  readonly wake: (name: string) => Effect.Effect<void>;
}

/** One line answering a relay connection's header: open, or why not. */
export const RelayAnswer = Schema.Struct({
  ok: Schema.Boolean,
  refused: Schema.optionalKey(Schema.String),
  unreachable: Schema.optionalKey(Schema.String),
  waits: Schema.optionalKey(Waits),
});
export type RelayAnswer = typeof RelayAnswer.Type;
const encodeAnswer = Schema.encodeSync(Schema.fromJsonString(RelayAnswer));
export const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(RelayAnswer));

/** Reads a connection's first line, handing on whatever followed it. */
const firstLine = (conn: Socket, then: (line: string, rest: Buffer) => void) => {
  let seen = Buffer.alloc(0);
  const take = (chunk: Buffer) => {
    seen = Buffer.concat([seen, chunk]);
    const end = seen.indexOf(10);
    if (end === -1) {
      if (seen.length > 64 * 1024) conn.destroy();
      return;
    }
    conn.off("data", take);
    conn.pause();
    then(seen.subarray(0, end).toString("utf8"), seen.subarray(end + 1));
  };
  conn.on("data", take);
};

/** How long a dial-back ticket can be used for. */
const TICKET_LIFE_MS = 10_000;
/** How often a listener says it is still there over each control link. */
const BEAT = "15 seconds";
/** A control link heard nothing from for this long is down. */
const SILENCE_MS = 15_000;

/** What a listener sends over a control link: a dial-back asked for, or that it is there. */
const ControlMessage = Schema.Union([
  Schema.Struct({
    dial: Schema.String,
    as: FrontDoor,
    client: Schema.String,
    sender: Schema.optionalKey(AgentAddress),
  }),
  Schema.Struct({ beat: Schema.Literal(true) }),
]);
const ControlJson = Schema.fromJsonString(ControlMessage);
const encodeControl = Schema.encodeSync(ControlJson);
const decodeControl = Schema.decodeUnknownOption(ControlJson);
const BEAT_MESSAGE = encodeControl({ beat: true });

/** The far end of a channel to a peer, however it was opened. */
interface Far {
  readonly send: (chunk: Uint8Array) => void;
  readonly close: () => void;
  readonly listen: (deliver: (chunk: Uint8Array) => void, done: () => void) => void;
}

/** What arrives on a WebSocket, held until someone listens. */
const held = () => {
  const queued: Array<Uint8Array> = [];
  let deliver: (chunk: Uint8Array) => void = (chunk) => void queued.push(chunk);
  let done = () => {};
  let gone = false;
  return {
    arrived: (chunk: Uint8Array) => deliver(chunk),
    hungUp: () => {
      gone = true;
      done();
    },
    listen: (to: (chunk: Uint8Array) => void, then: () => void) => {
      for (const chunk of queued.splice(0)) to(chunk);
      deliver = to;
      done = then;
      if (gone) then();
    },
  };
};

/** A peer's WebSocket on this Machine's listener; what it is for decides what each event does. */
interface Accepted {
  readonly peer: Peer;
  readonly opened: (ws: ServerWebSocket<Accepted>) => void;
  readonly arrived: (chunk: Uint8Array) => void;
  readonly hungUp: (ws: ServerWebSocket<Accepted>) => void;
}

interface Ticket {
  readonly installation: string;
  readonly at: number;
  readonly arrive: (far: Far) => void;
}

/** Where a peer stands now, as `collie machine list` says it. */
type Standing = Pick<
  PeerView,
  "state" | "since" | "failure" | "transport" | "direct" | "ssh" | "waits"
>;
const NO_WAY = { transport: null, direct: null, ssh: null, waits: null } as const;

/**
 * The peers module, for as long as the host's scope: the records, a relay socket for each
 * peer, the control link to each peer this Machine dials, and the listener while any peer
 * dials in.
 */
export const startPeers = Effect.fn("Peers.start")(function* (link: Link) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const clock = yield* Clock.Clock;
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | SecureRandom.SecureRandom
    | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Port 0 takes what is free once; every later opening, by any host of the directory,
  // binds that same port.
  const keptPort = `${link.dir}/peer-port`;
  let listenPort = yield* port;
  if (listenPort === 0)
    listenPort = Number(yield* fs.readFileString(keptPort).pipe(Effect.orElseSucceed(() => "0")));
  const listenHost = yield* bindHost;
  const startedAt = DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
  let peers = [...(yield* peersOf(link.dir))];
  const relays = new Map<string, Server>();
  /** The dialler of each peer this Machine keeps a control link to. */
  const diallers = new Map<string, Fiber.Fiber<never>>();
  /** The control link each peer that dials in holds open. */
  const controls = new Map<string, ServerWebSocket<Accepted>>();
  const tickets = new Map<string, Ticket>();
  const standings = new Map<string, Standing>();
  /** What ends the wait before each dialler's next attempt. */
  const wakers = new Map<string, Deferred.Deferred<void>>();
  const builds = new Map<string, string>();
  const syncing = yield* Semaphore.make(1);
  const pairing = yield* Semaphore.make(1);
  const connections = new Map<Socket, string>();
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let listening: string | null = null;
  let served: string | null = null;

  const stand = (installation: string, standing: Standing) =>
    void standings.set(installation, standing);

  const syncSettings = (peer: Peer) =>
    syncing
      .withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const door = yield* link.connect(peer);
            const mine = yield* sharedSettings(link.userDir);
            const theirs = yield* door.settings();
            const settings = Object.fromEntries(
              mine.settings
                .filter((one) => one.key !== "gitlab_host")
                .map(({ key, value, at }) => [
                  key,
                  { value, at, from: machineName(), differed: false },
                ]),
            );
            const merged = takeFrom({ settings, synced: [] }, peer.name, theirs.settings);
            const { take } = latestEdits(
              mine.settings,
              Object.entries(merged.flock.settings).map(([key, { value, at }]) => ({
                key,
                value,
                at,
              })),
              byKey,
            );
            if (take.length > 0) yield* takeShared(link.userDir, take, peer.name, yield* nowIso());
            if (merged.give.length > 0)
              yield* door.setSettings({
                settings: merged.give,
                request: `sync:${link.installation}:${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`,
              });
          }),
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`settings not synced with ${peer.name}: ${reason(cause)}`),
        ),
        Effect.provideContext(services),
      );

  /** Per peer, the edit of each path it is known to hold, so a watch gives it only newer ones. */
  const holds = new Map<string, Map<string, string>>();
  const unsynced = (peer: Peer, held: ReadonlyArray<SharedDefinition>) =>
    held.some((one) => holds.get(peer.installation)?.get(one.path) !== one.at);

  const syncDefinitions = (peer: Peer) =>
    syncing
      .withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            const door = yield* link.connect(peer);
            const mine = yield* sharedDefinitions(link.userDir, yield* nowIso());
            const { take, give } = latestEdits(mine, yield* door.sharedDefinitions(), byPath);
            const held =
              take.length > 0
                ? yield* takeDefinitions(link.userDir, take, peer.name, yield* nowIso())
                : mine;
            if (give.length > 0)
              yield* door.setSharedDefinitions({
                definitions: give,
                request: `sync:${link.installation}:${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`,
              });
            const known = holds.get(peer.installation) ?? new Map<string, string>();
            for (const one of landed([...mine, ...take], held)) known.set(one.path, one.at);
            holds.set(peer.installation, known);
          }),
        ),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`definitions not synced with ${peer.name}: ${reason(cause)}`),
        ),
        Effect.provideContext(services),
      );

  const level = (peer: Peer) =>
    levelPeer(link, peer).pipe(
      Effect.tap((build) => Effect.sync(() => builds.set(peer.installation, build))),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const failure = Schema.is(HostRefused)(cause) ? cause.reason : reason(cause);
          const standing = standings.get(peer.installation);
          if (standing !== undefined) stand(peer.installation, { ...standing, failure });
          yield* Effect.logWarning(`could not level ${peer.name}: ${failure}`);
        }),
      ),
      Effect.provideContext(services),
    );

  const onLink = (peer: Peer) =>
    void Effect.runFork(
      Effect.forkIn(
        reconcileMachines.pipe(
          Effect.andThen(() =>
            peers.some((one) => one.installation === peer.installation)
              ? level(peer).pipe(
                  Effect.andThen(syncSettings(peer)),
                  Effect.andThen(syncDefinitions(peer)),
                )
              : Effect.void,
          ),
        ),
        scope,
      ),
    );

  const keep = (next: ReadonlyArray<Peer>) =>
    Effect.gen(function* () {
      const previous = peers;
      yield* writePeers(link.dir, next);
      peers = [...next];
      for (const prior of previous)
        if (!peers.some((peer) => samePeer(peer, prior))) yield* drop(prior.installation);
      yield* settle;
    }).pipe(
      Effect.mapError((cause) => new HostRefused({ reason: reason(cause) })),
      Effect.provideContext(services),
    );

  const forget = (installation: string) =>
    Effect.suspend(() => keep(peers.filter((peer) => peer.installation !== installation))).pipe(
      pairing.withPermits(1),
      Effect.ignore,
    );
  const reconcileMachines = Effect.gen(function* () {
    const listed = yield* link.machines;
    if (listed !== null) {
      const labels = new Set(listed.map((machine) => machine.label));
      for (const peer of peers.filter((one) => one.dials === "out" && !labels.has(one.name))) {
        yield* link.tell(peer);
        yield* forget(peer.installation);
        yield* Effect.logInfo(`forgot ${peer.name}: herdr no longer lists it`);
      }
      for (const path of yield* closeConnections(link.dir, listed).pipe(
        Effect.provideContext(services),
      ))
        yield* Effect.logInfo(`closed the SSH connection at ${path}: herdr no longer names it`);
    }
  });

  const validateName = (name: string) =>
    Effect.gen(function* () {
      const path = relayOf(link.dir, name);
      if (Buffer.byteLength(path) > SOCKET_PATH_MAX)
        return yield* new HostRefused({
          reason: `${path} is longer than the ${SOCKET_PATH_MAX} bytes a unix socket path may be`,
        });
      if (/[/\\]/.test(name) || name === "" || name.startsWith("."))
        return yield* new HostRefused({ reason: `"${name}" cannot name a relay socket` });
    });

  /** The SSH connection herdr's machine by this peer's name has, or none where it lists none. */
  const connectionOf = (peer: Peer) =>
    Effect.gen(function* () {
      const machine = (yield* link.machines)?.find((one) => one.label === peer.name);
      if (machine === undefined) return null;
      return yield* sshConnection(link.dir, machine).pipe(
        Effect.tapError((refused) => Effect.logWarning(refused.reason)),
        Effect.orElseSucceed(() => null),
      );
    }).pipe(Effect.provideContext(services));

  /** The way a peer's live link went, which its channels take too; none while it is down. */
  const wayOf = (peer: Peer) => {
    const standing = standings.get(peer.installation);
    return standing?.state === "live" ? (standing.transport ?? undefined) : undefined;
  };

  /** A fresh `/channel` to a peer this Machine dials. */
  const dialOut = (peer: Peer, as: FrontDoor, client: string, sender?: AgentAddress) =>
    openPeer(
      peer,
      () =>
        `/channel?as=${encodeURIComponent(as)}&client=${encodeURIComponent(client)}${sender === undefined ? "" : `&sender=${encodeURIComponent(Schema.encodeSync(AgentAddressJson)(sender))}`}`,
      connectionOf(peer),
      wayOf(peer),
    );

  /** A peer that dials in, asked over its control link to dial back for this channel. */
  const dialBack = (peer: Peer, as: FrontDoor, client: string, sender?: AgentAddress) =>
    Effect.gen(function* () {
      const control = controls.get(peer.installation);
      if (control === undefined)
        return yield* new MachineUnreachable({
          machine: peer.name,
          seen: "no control link from it",
        });
      const now = clock.currentTimeMillisUnsafe();
      for (const [id, ticket] of tickets) if (now - ticket.at > TICKET_LIFE_MS) tickets.delete(id);
      const id = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
      let waiting = true;
      const far = yield* Effect.callback<Far>((resume) => {
        tickets.set(id, {
          installation: peer.installation,
          at: now,
          arrive: (far) => (waiting ? resume(Effect.succeed(far)) : far.close()),
        });
        control.send(
          encodeControl(
            sender === undefined ? { dial: id, as, client } : { dial: id, as, client, sender },
          ),
        );
      }).pipe(Effect.timeoutOption(REACH_BOUND));
      waiting = false;
      if (Option.isSome(far)) return far.value;
      return yield* new MachineUnreachable({
        machine: peer.name,
        seen: `no dial-back within ${REACH_BOUND}`,
      });
    });

  /** A relay connection, once its header is read, piped to the far end of a fresh channel. */
  const relayed = (peer: Peer, conn: Socket, line: string, rest: Uint8Array) =>
    Effect.gen(function* () {
      const answer = (said: RelayAnswer) => `${encodeAnswer(said)}\n`;
      const header = Schema.decodeUnknownOption(RelayHeaderJson)(line);
      if (Option.isNone(header))
        return conn.end(answer({ ok: false, refused: `"${line}" is not a relay header` }));
      const { as, client } = header.value;
      if (as === "host" && header.value.stamp !== link.stamp)
        return conn.end(answer({ ok: false, refused: "only this Machine's host speaks as host" }));
      const reach = peer.dials === "out" ? dialOut : dialBack;
      const far = yield* reach(peer, as, client, header.value.sender).pipe(Effect.result);
      if (far._tag === "Failure") {
        const { seen, waits } = far.failure;
        return conn.end(
          answer(
            waits === undefined
              ? { ok: false, unreachable: seen }
              : { ok: false, unreachable: seen, waits },
          ),
        );
      }
      const ws = far.success;
      conn.write(answer({ ok: true }));
      if (rest.length > 0) ws.send(rest);
      ws.listen(
        (chunk) => void conn.write(chunk),
        () => conn.end(),
      );
      conn.on("data", (chunk: Buffer) => ws.send(new Uint8Array(chunk)));
      conn.on("close", () => ws.close());
      conn.on("error", () => ws.close());
      conn.resume();
      yield* Effect.callback<void>((resume) => {
        if (conn.destroyed) resume(Effect.void);
        else conn.once("close", () => resume(Effect.void));
      });
    }).pipe(Effect.scoped);

  /** A channel from `peer` into this host, declared as coming from that Machine. */
  const intoHost = (peer: Peer, as: FrontDoor, client: string, far: Far, sender?: AgentAddress) =>
    channelInto(
      link.socket,
      {
        frontDoor: as,
        from: { machine: { installation: peer.installation, name: peer.name }, client, ...sender },
        stamp: link.stamp,
      },
      {
        write: far.send,
        end: (done) => {
          far.close();
          done();
        },
        read: far.listen,
      },
    );

  /** The dial-back a listener asked for: `/reverse` with its ticket, piped into this host. */
  const dialledBack = (
    peer: Peer,
    dial: string,
    as: FrontDoor,
    client: string,
    sender?: AgentAddress,
  ) =>
    openPeer(
      peer,
      () => `/reverse?ticket=${encodeURIComponent(dial)}`,
      connectionOf(peer),
      wayOf(peer),
    ).pipe(
      Effect.flatMap((far) =>
        intoHost(peer, as, client, far, sender).pipe(Effect.catch(() => Effect.sync(far.close))),
      ),
      Effect.ignore,
      Effect.scoped,
    );

  /** One control link to a peer this Machine dials, until it ends: whether it was up, and why it ended. */
  const controlLink = (peer: Peer) =>
    Effect.gen(function* () {
      const opened = yield* openPeer(
        peer,
        (way, direct) =>
          `/control?transport=${way}${direct === null ? "" : `&direct=${encodeURIComponent(direct)}`}`,
        connectionOf(peer),
      ).pipe(Effect.result);
      if (opened._tag === "Failure") {
        const { seen, direct, ssh, waits } = opened.failure;
        return {
          up: false,
          ended: {
            failure: seen,
            transport: null,
            direct: direct ?? null,
            ssh: ssh ?? null,
            waits: waits ?? null,
          },
        };
      }
      const ws = opened.success;
      const ended = yield* Deferred.make<string>();
      let heard = clock.currentTimeMillisUnsafe();
      stand(peer.installation, {
        state: "live",
        since: null,
        failure: null,
        ...NO_WAY,
        transport: ws.way,
        direct: ws.direct,
      });
      onLink(peer);
      ws.listen(
        (data) => {
          heard = clock.currentTimeMillisUnsafe();
          const said = decodeControl(new TextDecoder().decode(data));
          if (Option.isSome(said) && "dial" in said.value)
            void Effect.runFork(
              Effect.forkIn(
                dialledBack(
                  peer,
                  said.value.dial,
                  said.value.as,
                  said.value.client,
                  said.value.sender,
                ),
                scope,
              ),
            );
        },
        (reason) => Deferred.doneUnsafe(ended, Exit.succeed(reason || "the control link closed")),
      );
      const silent = Effect.sleep("5 seconds").pipe(
        Effect.andThen(Effect.sync(() => clock.currentTimeMillisUnsafe() - heard > SILENCE_MS)),
        Effect.repeat({ until: (quiet) => quiet }),
        Effect.as(`heard nothing for ${SILENCE_MS / 1000} seconds`),
      );
      const failure = yield* Effect.raceFirst(Deferred.await(ended), silent);
      return { up: true, ended: { failure, ...NO_WAY } };
    }).pipe(Effect.scoped);

  /** The control link to `peer`, kept open for as long as this host runs. */
  const dialling = (peer: Peer) =>
    Effect.gen(function* () {
      let failures = 0;
      stand(peer.installation, { state: "connecting", since: null, failure: null, ...NO_WAY });
      while (true) {
        const woken = yield* Deferred.make<void>();
        wakers.set(peer.installation, woken);
        const { up, ended } = yield* controlLink(peer);
        if (up) failures = 0;
        stand(peer.installation, { state: "connecting", since: null, ...ended });
        yield* Effect.raceFirst(Effect.sleep(backoff(failures)), Deferred.await(woken));
        failures++;
      }
    });

  const relayTo = (peer: Peer) => (conn: Socket) =>
    firstLine(
      conn,
      (line, rest) => void Effect.runFork(Effect.forkIn(relayed(peer, conn, line, rest), scope)),
    );

  const openRelay = (peer: Peer) =>
    Effect.gen(function* () {
      const path = relayOf(link.dir, peer.name);
      yield* fs.makeDirectory(`${link.dir}/peers`, { recursive: true });
      yield* fs.remove(path, { force: true });
      const server = createServer(relayTo(peer));
      server.on("connection", (conn) => {
        connections.set(conn, peer.installation);
        conn.once("close", () => connections.delete(conn));
      });
      yield* Effect.callback<void>((resume) => {
        server.once("error", () => resume(Effect.void));
        server.listen(path, () => resume(Effect.void));
      });
      relays.set(peer.installation, server);
    }).pipe(Effect.orDie);

  /** Everything kept for a peer this Machine no longer has. */
  const drop = (installation: string) =>
    Effect.gen(function* () {
      for (const [conn, owner] of connections) if (owner === installation) conn.destroy();
      const relay = relays.get(installation);
      relays.delete(installation);
      if (relay !== undefined)
        yield* Effect.callback<void>((resume) => {
          relay.close(() => resume(Effect.void));
        });
      const dialler = diallers.get(installation);
      diallers.delete(installation);
      if (dialler !== undefined) yield* Fiber.interrupt(dialler);
      controls.get(installation)?.close();
      controls.delete(installation);
      standings.delete(installation);
      builds.delete(installation);
    });

  /** Whom the listener lets in: the installation a bearer secret was minted for. */
  const bearerOf = (request: Request) => {
    const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (given === undefined) return undefined;
    return peers.find((peer) => peer.dials === "in" && sameSecret(given, peer.secret));
  };

  /** A `/channel` a peer opened, declared into this host. */
  const channelFrom = (
    peer: Peer,
    as: FrontDoor,
    client: string,
    sender?: AgentAddress,
  ): Accepted => {
    const inbox = held();
    return {
      peer,
      opened: (ws) =>
        void Effect.runFork(
          Effect.forkIn(
            intoHost(
              peer,
              as,
              client,
              {
                send: (chunk) => void ws.sendBinary(chunk),
                close: () => ws.close(),
                listen: inbox.listen,
              },
              sender,
            ).pipe(Effect.catch((refused) => Effect.sync(() => ws.close(1011, refused.reason)))),
            scope,
          ),
        ),
      arrived: inbox.arrived,
      hungUp: inbox.hungUp,
    };
  };

  /**
   * A peer's control link: the newest one an installation opens is the one kept, over the
   * transport its dialler declared.
   */
  const controlFrom = (peer: Peer, transport: Way, direct: string | null): Accepted => ({
    peer,
    opened: (ws) => {
      const older = controls.get(peer.installation);
      controls.set(peer.installation, ws);
      older?.close();
      stand(peer.installation, {
        state: "live",
        since: null,
        failure: null,
        ...NO_WAY,
        transport,
        direct: transport === "ssh" ? direct : null,
      });
      onLink(peer);
    },
    arrived: () => {},
    hungUp: (ws) => {
      if (controls.get(peer.installation) !== ws) return;
      controls.delete(peer.installation);
      stand(peer.installation, {
        state: "away",
        since: DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe())),
        failure: "its control link closed",
        ...NO_WAY,
      });
    },
  });

  /** The dial-back a ticket was minted for, handed to the relay connection waiting on it. */
  const reverseFrom = (peer: Peer, ticket: Ticket): Accepted => {
    const inbox = held();
    return {
      peer,
      opened: (ws) =>
        ticket.arrive({
          send: (chunk) => void ws.sendBinary(chunk),
          close: () => ws.close(),
          listen: inbox.listen,
        }),
      arrived: inbox.arrived,
      hungUp: inbox.hungUp,
    };
  };

  /** What a request to the listener is let in as, or the response refusing it. */
  const accept = (request: Request): Accepted | Response => {
    const url = new URL(request.url);
    const peer = bearerOf(request);
    if (peer === undefined) return new Response("not paired", { status: 401 });
    switch (url.pathname) {
      case "/channel": {
        const as = url.searchParams.get("as") ?? "";
        if (!Schema.is(FrontDoor)(as))
          return new Response(`"${as}" is not a front door`, { status: 400 });
        const encoded = url.searchParams.get("sender");
        const sender =
          encoded === null ? undefined : Schema.decodeUnknownOption(AgentAddressJson)(encoded);
        if (sender !== undefined && Option.isNone(sender))
          return new Response("invalid agent address", { status: 400 });
        return channelFrom(
          peer,
          as,
          url.searchParams.get("client") ?? peer.name,
          sender === undefined ? undefined : sender.value,
        );
      }
      case "/control":
        return controlFrom(
          peer,
          url.searchParams.get("transport") === "ssh" ? "ssh" : "direct",
          url.searchParams.get("direct"),
        );
      case "/reverse": {
        const id = url.searchParams.get("ticket") ?? "";
        const ticket = tickets.get(id);
        if (ticket === undefined) return new Response("no such ticket", { status: 403 });
        if (clock.currentTimeMillisUnsafe() - ticket.at > TICKET_LIFE_MS) {
          tickets.delete(id);
          return new Response("the ticket has expired", { status: 403 });
        }
        if (ticket.installation !== peer.installation)
          return new Response("the ticket was minted for another Machine", { status: 403 });
        tickets.delete(id);
        return reverseFrom(peer, ticket);
      }
      default:
        return new Response("not found", { status: 404 });
    }
  };

  const startListener = Effect.gen(function* () {
    const cert = yield* fs
      .readFileString(listenerCertOf(link.dir))
      .pipe(Effect.catch(() => fs.readFileString(certOf(link.dir))));
    const key = yield* fs.readFileString(keyOf(link.dir));
    served = cert;
    return yield* Effect.try({
      try: () =>
        Bun.serve<Accepted>({
          hostname: listenHost,
          port: listenPort,
          tls: { cert, key },
          fetch: (request, server) => {
            const accepted = accept(request);
            if (accepted instanceof Response) return accepted;
            return server.upgrade(request, { data: accepted })
              ? undefined
              : new Response("", { status: 400 });
          },
          websocket: {
            open: (ws) => ws.data.opened(ws),
            message: (ws, message) =>
              ws.data.arrived(Buffer.isBuffer(message) ? message : Buffer.from(message)),
            close: (ws) => ws.data.hungUp(ws),
          },
        }),
      catch: (cause) => new HostRefused({ reason: reason(cause) }),
    });
  });

  /** A relay and its link for every peer, and the listener while one dials in. */
  const settle: Effect.Effect<void> = Effect.gen(function* () {
    for (const installation of new Set([...relays.keys(), ...diallers.keys()]))
      if (!peers.some((peer) => peer.installation === installation)) yield* drop(installation);
    for (const peer of peers) {
      if (!relays.has(peer.installation)) yield* openRelay(peer);
      if (peer.dials === "out" && !diallers.has(peer.installation))
        diallers.set(peer.installation, yield* Effect.forkIn(dialling(peer), scope));
      if (peer.dials === "in" && !standings.has(peer.installation))
        stand(peer.installation, {
          state: "away",
          since: startedAt,
          failure: "no control link from it yet",
          ...NO_WAY,
        });
    }
    const wanted = peers.some((peer) => peer.dials === "in");
    if (wanted && listener === null) {
      const started = yield* startListener.pipe(Effect.result);
      if (started._tag === "Success") {
        listener = started.success;
        if (listenPort === 0 && listener.port !== undefined) {
          listenPort = listener.port;
          yield* fs.writeFileString(keptPort, String(listenPort)).pipe(Effect.ignore);
        }
        listening = null;
      } else {
        listening = `could not listen on port ${listenPort}: ${reason(started.failure)}`;
        yield* Effect.logWarning(listening);
      }
    }
    if (!wanted && listener !== null) {
      void listener.stop(true);
      listener = null;
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      void listener?.stop(true);
      for (const conn of connections.keys()) conn.destroy();
      for (const server of relays.values()) server.close();
    }),
  );
  yield* Effect.forkIn(
    Effect.sync(() => {
      for (const control of controls.values()) control.send(BEAT_MESSAGE);
    }).pipe(Effect.repeat(Schedule.spaced(BEAT))),
    scope,
  );
  yield* pairing.withPermits(1)(settle);
  yield* fs.makeDirectory(link.userDir, { recursive: true });
  yield* Effect.forkIn(
    fs.watch(link.userDir).pipe(
      Stream.filter(
        (event) => event.path.endsWith("config.json") || event.path.endsWith("settings-set.json"),
      ),
      Stream.runForEach(() =>
        Effect.forEach(
          peers.filter((peer) => standings.get(peer.installation)?.state === "live"),
          syncSettings,
          { discard: true },
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning(`could not watch shared settings: ${reason(cause)}`),
      ),
    ),
    scope,
  );
  const definitionKinds = ["workflows", "personas"];
  const syncHeldDefinitions = Effect.gen(function* () {
    const live = peers.filter((peer) => standings.get(peer.installation)?.state === "live");
    if (live.length === 0) return;
    const held = yield* sharedDefinitions(link.userDir, yield* nowIso());
    yield* Effect.forEach(
      live.filter((peer) => unsynced(peer, held)),
      syncDefinitions,
      { discard: true },
    );
  });
  yield* Effect.forkIn(
    Effect.gen(function* () {
      // ponytail: polled quietly while the user directory is gone, which only its owner makes.
      if (!(yield* fs.exists(link.userDir))) return yield* Effect.sleep("10 seconds");
      for (const kind of definitionKinds)
        if (!(yield* fs.exists(`${link.userDir}/${kind}`)))
          yield* fs.makeDirectory(`${link.userDir}/${kind}`);
      yield* Stream.mergeAll(
        [
          ...definitionKinds.map((kind) =>
            fs.watch(`${link.userDir}/${kind}`).pipe(Stream.as(false)),
          ),
          // A watch stays on the directory it was given, so one replaced is watched again.
          fs.watch(link.userDir).pipe(
            Stream.filter((event) => definitionKinds.includes(event.path)),
            Stream.as(true),
          ),
          // The catch-up starts behind the watches, so a save during it is still seen.
          Stream.make(false),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Stream.takeWhile((replaced) => !replaced),
        Stream.runForEach(() => syncHeldDefinitions),
      );
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`could not watch shared definitions: ${reason(cause)}`).pipe(
          Effect.andThen(Effect.sleep("10 seconds")),
        ),
      ),
      Effect.forever,
    ),
    scope,
  );

  yield* reconcileMachines;

  const peersModule: Peers = {
    invite: (asker) =>
      Effect.gen(function* () {
        yield* validateName(asker.name);
        const previous = peers.find((peer) => peer.installation === asker.installation);
        const certificate = yield* certificateFor(link.dir, asker.address).pipe(
          Effect.mapError((cause) =>
            Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
          ),
        );
        if (previous?.dials === "out")
          return {
            installation: link.installation,
            port: listenPort,
            certificate,
            secret: previous.secret,
            dials: "in",
          } satisfies Invited;
        const serving = yield* listenerCertificateFor(link.dir, asker.address).pipe(
          Effect.mapError((cause) =>
            Schema.is(HostRefused)(cause) ? cause : new HostRefused({ reason: reason(cause) }),
          ),
        );
        if (listener !== null && served !== serving) {
          void listener.stop(true);
          listener = null;
        }
        const secret =
          (previous?.dials === "in" ? previous.secret : undefined) ??
          Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
        const incoming: Peer = {
          installation: asker.installation,
          name: asker.name,
          dials: "in",
          secret,
        };
        yield* keep([
          ...peers.filter((peer) => peer.installation !== asker.installation),
          incoming,
        ]);
        if (listener === null && incoming.dials === "in")
          return yield* new HostRefused({ reason: listening ?? "the listener did not start" });
        return { installation: link.installation, port: listenPort, certificate, secret };
      }).pipe(pairing.withPermits(1), Effect.provideContext(services)),
    add: (peer) =>
      Effect.gen(function* () {
        yield* validateName(peer.name);
        const previous = peers.find((one) => one.installation === peer.installation);
        // Simultaneous opposite invitations agree that the higher installation dials.
        const paired =
          peer.dials === "out" &&
          previous?.dials === "in" &&
          (link.installation < peer.installation ||
            controls.has(peer.installation) ||
            standings.get(peer.installation)?.state === "live")
            ? { ...previous, name: peer.name }
            : peer;
        yield* keep([
          ...peers.filter(
            (one) => one.installation !== peer.installation && one.name !== peer.name,
          ),
          paired,
        ]);
      }).pipe(pairing.withPermits(1)),
    forget,
    list: reconcileMachines.pipe(
      Effect.andThen(pairing.withPermits(1)(settle)),
      Effect.andThen(() =>
        Effect.forEach(peers, (peer) =>
          Effect.gen(function* () {
            const standing = standings.get(peer.installation) ?? {
              state: "connecting",
              since: null,
              failure: null,
              ...NO_WAY,
            };
            const connection = peer.dials === "out" ? yield* connectionOf(peer) : undefined;
            return {
              installation: peer.installation,
              name: peer.name,
              dials: peer.dials,
              url: peer.url ?? null,
              build: builds.get(peer.installation) ?? null,
              ...standing,
              failure: peer.dials === "in" && listening !== null ? listening : standing.failure,
              connection:
                connection === undefined ? null : connection !== null && (yield* connection.check),
            } satisfies PeerView;
          }),
        ),
      ),
    ),
    wake: (name) =>
      Effect.sync(() => {
        const peer = peers.find((one) => one.name === name && one.dials === "out");
        const waker =
          peer === undefined || standings.get(peer.installation)?.state === "live"
            ? undefined
            : wakers.get(peer.installation);
        if (waker !== undefined) Deferred.doneUnsafe(waker, Exit.void);
      }),
  };
  return peersModule;
});

const decodeInvited = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), data: Invited })),
);
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);

/**
 * Pairs with a herdr machine through this computer's open SSH connection to it, and
 * answers the pairing for this Machine to keep. Only a front door that can show the login
 * opening that connection calls this; a connection that went is a failure, never a login.
 */
export const pairWith = Effect.fn("Peers.pairWith")(
  function* (
    machine: HerdrMachine,
    asker: {
      readonly installation: string;
      readonly name: string;
      /** The control path of the open connection the invite rides. */
      readonly control: string;
    },
  ) {
    const address = (yield* resolvedHost(machine.target)) ?? machine.target.replace(/^.*@/, "");
    const { stdout: said, said: ssh } = yield* ride(
      asker.control,
      machine.target,
      remoteCollie([
        "--json",
        "machine",
        "invite",
        "--for",
        asker.installation,
        "--name",
        asker.name,
        "--address",
        address,
      ]),
    );
    const last = said.trim().split("\n").at(-1) ?? "";
    const invited = decodeInvited(last);
    if (Option.isNone(invited))
      return yield* new HostRefused({
        reason: `${machine.label} did not pair: ${Option.match(decodeRefusal(last), {
          onNone: () =>
            last !== ""
              ? last
              : ssh === ""
                ? "its collie answered nothing over ssh"
                : `ssh said: ${ssh}`,
          onSome: (refused) => refused.error.message,
        })}`,
      });
    const { installation, port: at, certificate, secret, dials } = invited.value.data;
    const host = address.includes(":") ? `[${address}]` : address;
    const peer: Peer = {
      installation,
      name: machine.label,
      dials: dials ?? "out",
      url: `wss://${host}:${at}`,
      certificate,
      secret,
    };
    return peer;
  },
  (effect, machine) =>
    effect.pipe(
      Effect.timeoutOption("2 minutes"),
      Effect.flatMap((answer) =>
        Option.isSome(answer)
          ? Effect.succeed(answer.value)
          : Effect.fail(
              new HostRefused({
                reason: `${machine.label} did not pair: SSH login or SSO approval did not finish within two minutes.`,
              }),
            ),
      ),
    ),
);
