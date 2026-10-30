// How a Machine's shared SSH connection is opened, asked and ridden
// (ADR-draft-a-blocked-link-rides-the-machines-ssh-connection).

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Duration, Effect, FileSystem, Option, Schema, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HostRefused } from "./board-model";
import { withLock } from "./lock";
import { MachineUnreachable } from "./peers-model";
import { MUX_BOUND, muxArgv, riderArgv, type Verb } from "./ssh-argv";

/** A herdr machine as its SSH connection is named: its label and its target. */
export interface SshMachine {
  readonly label: string;
  readonly target: string;
}

/** The longest unix socket path macOS binds. */
export const SOCKET_PATH_MAX = 104;
/** What ssh appends to a control path while it binds it: a dot and 16 characters. */
const BIND_SUFFIX = 17;
const OPEN_BOUND = "2 minutes";

/** Where this computer's connection to `machine` is held: a changed target is another. */
export const controlPathOf = (stateDir: string, machine: SshMachine) =>
  `${stateDir}/ssh/${pipe_(
    new Bun.CryptoHasher("sha256").update(`${machine.label}\n${machine.target}`).digest("hex"),
    Str.slice(0, 16),
  )}`;

/** The control path, in a directory only this user reads, or why a socket cannot bind it. */
export const controlPath = Effect.fn("SshConnection.controlPath")(
  function* (stateDir: string, machine: SshMachine) {
    const path = controlPathOf(stateDir, machine);
    if (Buffer.byteLength(path) + BIND_SUFFIX > SOCKET_PATH_MAX)
      return yield* new HostRefused({
        reason: `${path} is too long for ssh to bind as a control socket within the ${SOCKET_PATH_MAX} bytes a unix socket path may be`,
      });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${stateDir}/ssh`, {
      recursive: true,
      mode: 0o700,
    });
    yield* fs.chmod(`${stateDir}/ssh`, 0o700);
    return path;
  },
  Effect.mapError((cause) =>
    cause._tag === "HostRefused" ? cause : new HostRefused({ reason: cause.message }),
  ),
);

/** What ssh said on stderr, and how it ended. */
const ran = (argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command, ...args] = argv;
    const child = yield* spawner.spawn(
      ChildProcess.make(command!, args, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const [code, stderr] = yield* Effect.all(
      [child.exitCode, child.stderr.pipe(Stream.decodeText(), Stream.mkString)],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stderr: Str.trim(stderr) };
  }).pipe(Effect.scoped);

/** A host's handle on a Machine's connection: it asks an open master, and never logs in. */
export interface SshConnection {
  readonly path: string;
  /** Whether a master answers on the control path. */
  readonly check: Effect.Effect<boolean>;
  /** Forwards this computer's `127.0.0.1:<local>` to the Machine's `127.0.0.1:<peer>` for the scope. */
  readonly forward: (local: number, peer: number) => Effect.Effect<void, HostRefused, Scope.Scope>;
  /** Ends the master, and removes its path where it had already gone. */
  readonly exit: Effect.Effect<void>;
}

const mux = (
  ssh: string,
  path: string,
  answerWithin: Duration.Input,
  verb: Verb,
  destination: string,
  ...forward: ReadonlyArray<string>
) =>
  ran(muxArgv(ssh, path, verb, destination, ...forward)).pipe(
    Effect.timeoutOption(answerWithin),
    Effect.map(
      Option.getOrElse(() => ({
        code: -1,
        stderr: `the SSH connection at ${path} did not answer ${verb} within ${Duration.format(Duration.fromInputUnsafe(answerWithin))}`,
      })),
    ),
    Effect.orElseSucceed(() => ({
      code: -1,
      stderr: `${ssh} could not be run`,
    })),
  );

const exitAt = (ssh: string, path: string, answerWithin: Duration.Input, destination: string) =>
  mux(ssh, path, answerWithin, "exit", destination).pipe(
    Effect.andThen(
      FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, { force: true }))),
    ),
    Effect.ignore,
  );

export const sshConnection = Effect.fn("SshConnection.handle")(function* (
  stateDir: string,
  machine: SshMachine,
  ssh = "ssh",
  answerWithin: Duration.Input = MUX_BOUND,
) {
  const path = yield* controlPath(stateDir, machine);
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >();
  const asked = (verb: "check" | "forward" | "cancel", ...forward: ReadonlyArray<string>) =>
    mux(ssh, path, answerWithin, verb, machine.target, ...forward).pipe(
      Effect.provideContext(services),
    );
  const connection: SshConnection = {
    path,
    check: asked("check").pipe(Effect.map(({ code }) => code === 0)),
    exit: exitAt(ssh, path, answerWithin, machine.label).pipe(Effect.provideContext(services)),
    forward: (local, peer) => {
      const spec = ["-L", `127.0.0.1:${local}:127.0.0.1:${peer}`];
      return Effect.acquireRelease(
        asked("forward", ...spec).pipe(
          Effect.flatMap(({ code, stderr }) =>
            code === 0
              ? Effect.void
              : Effect.fail(
                  new HostRefused({
                    reason: `the SSH connection did not forward port ${peer}: ${stderr || `exit ${code}`}`,
                  }),
                ),
          ),
        ),
        () => asked("cancel", ...spec),
      );
    },
  };
  return connection;
});

/**
 * Opens this computer's SSH connection to `machine`, unless one is open: the master is
 * ssh's own, kept by `ControlPersist` after this returns. What ssh says, such as an SSO
 * login's prompt, is handed to `said` as it comes.
 */
export const openConnection = Effect.fn("SshConnection.open")(function* (
  stateDir: string,
  machine: SshMachine,
  options: {
    readonly said: (text: string) => Effect.Effect<void>;
    readonly bound?: Duration.Input;
    readonly ssh?: string;
  },
) {
  const ssh = options.ssh ?? "ssh";
  const bound = Duration.fromInputUnsafe(options.bound ?? OPEN_BOUND);
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(bound);
  const left = Clock.currentTimeMillis.pipe(
    Effect.map((now) => Duration.millis(Math.max(0, deadline - now))),
  );
  const connection = yield* sshConnection(stateDir, machine, ssh);
  const { path } = connection;
  const checked = left.pipe(
    Effect.flatMap((within) => connection.check.pipe(Effect.timeoutOption(within))),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new MachineUnreachable({
              machine: machine.label,
              seen: `its SSH connection at ${path} did not answer within ${Duration.format(bound)}`,
            }),
          ),
      }),
    ),
  );
  if (yield* checked) return { path, opened: false };
  const contended = new MachineUnreachable({
    machine: machine.label,
    seen: `another opener held its SSH connection for longer than ${Duration.format(bound)}`,
  });
  // Another process opening it may be waiting on the same SSO login: wait for it, then look again.
  return yield* withLock(
    `${path}.lock`,
    contended,
    Effect.gen(function* () {
      if (yield* checked) return { path, opened: false };
      const within = yield* left;
      if (Duration.isZero(within)) return yield* contended;
      return yield* opened(connection, machine, ssh, within, options.said);
    }),
    yield* left,
  ).pipe(
    Effect.catchTag(["PlatformError", "SchemaError"], (cause) =>
      Effect.fail(new HostRefused({ reason: cause.message })),
    ),
  );
});

const opened = Effect.fnUntraced(function* (
  connection: SshConnection,
  machine: SshMachine,
  ssh: string,
  bound: Duration.Duration,
  said: (text: string) => Effect.Effect<void>,
) {
  const { path } = connection;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let last = "";
  const opening = Effect.gen(function* () {
    const master = yield* spawner.spawn(
      ChildProcess.make(
        ssh,
        [
          "-M",
          "-N",
          "-S",
          path,
          "-o",
          "ControlPersist=yes",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          "-o",
          "ConnectTimeout=15",
          machine.target,
        ],
        // Not its own process group, which a scope closing would end with the master in it.
        { stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: false },
      ),
    );
    yield* master.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Effect.suspend(() => {
          last = Str.split(Str.trim(text), "\n").at(-1) ?? last;
          return said(text);
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const code = Number(yield* master.exitCode);
    if (code !== 0) return yield* Effect.fail(`ssh exited ${code}`);
    if (!(yield* connection.check))
      return yield* Effect.fail("no master answered once ssh returned");
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => (Schema.is(Schema.String)(cause) ? cause : cause.message)),
  );
  const done = yield* opening.pipe(Effect.timeoutOption(bound), Effect.result);
  if (done._tag === "Success" && Option.isSome(done.success)) return { path, opened: true };
  const why =
    done._tag === "Failure" ? done.failure : `no SSH connection within ${Duration.format(bound)}`;
  return yield* new MachineUnreachable({
    machine: machine.label,
    seen: last === "" ? why : `${why}; ssh said: ${last}`,
  });
});

/**
 * Ends every connection held under `stateDir` but those of `kept`, answering the paths it
 * ended. A path no longer names its Machine, so each is told by a fixed destination.
 */
export const closeConnections = Effect.fn("SshConnection.closeOthers")(function* (
  stateDir: string,
  kept: ReadonlyArray<SshMachine>,
  ssh = "ssh",
) {
  const fs = yield* FileSystem.FileSystem;
  const keep = new Set(Arr.map(kept, (machine) => controlPathOf(stateDir, machine)));
  const held = Arr.filter(
    Arr.map(
      Arr.filter(
        yield* fs
          .readDirectory(`${stateDir}/ssh`)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
        (name) => /^[0-9a-f]{16}$/.test(name),
      ),
      (name) => `${stateDir}/ssh/${name}`,
    ),
    (path) => !keep.has(path),
  );
  yield* Effect.forEach(held, (path) => exitAt(ssh, path, MUX_BOUND, "collie"), {
    discard: true,
  });
  return held;
});

/** The host name ssh's own configuration resolves `target` to, or null where it says none. */
export const resolvedHost = (target: string, ssh = "ssh") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const said = yield* spawner.string(
      ChildProcess.make(ssh, ["-G", target], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    );
    return (
      Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(/^hostname (.+)$/m.exec(said)), (present) =>
          Option.map(Option.fromNullishOr(present[1]), (present_) => Str.trim(present_)),
        ),
      ) ?? null
    );
  }).pipe(Effect.orElseSucceed(() => null));

/**
 * Runs `remote` in a session riding the connection at `path`, answering what it printed
 * and the last thing ssh said.
 */
export const ride = (path: string, target: string, remote: string, ssh = "ssh") =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command, ...args] = riderArgv(path, target, remote, ssh);
    const child = yield* spawner.spawn(
      ChildProcess.make(command!, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
      }),
    );
    const [stdout, stderr] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, said: Str.split(Str.trim(stderr), "\n").at(-1) ?? "" };
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => ({
      stdout: "",
      said: `${ssh} could not be run`,
    })),
  );
