// The fake `ssh` every test shares (`fake-ssh-main.ts`), and the network fault a blocked
// port is: a resetter that drops each connection at its first bytes, as Cloudflare WARP
// resets the TLS ClientHello on a peer's port.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Effect, FileSystem, Result, Schema, type Scope, flow } from "effect";
import { CommandLine } from "effect/process";
import { SOCKET_BASE } from "./sweep";
import { fixtureBinary } from "./bin";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

/**
 * A directory for the scope, short enough for a control socket under it to bind: macOS's
 * `TMPDIR` alone is 49 bytes. Named as the suite's roots are, so a killed suite's is swept.
 */
export const socketDir = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeTempDirectoryScoped({
        directory: SOCKET_BASE,
        prefix: `collie-test-${process.pid}-${prefix}`,
      }),
    ),
    Effect.orDie,
  );

/** A fake `ssh` written to `bin`, and what a test does to it. */
export interface FakeSsh {
  /** Every call, one line each: `master`, `mux <verb>`, `ride` or `login`. */
  readonly log: string;
  /** The log's lines now. */
  readonly calls: Effect.Effect<ReadonlyArray<string>>;
  /** Where a forward to the far `127.0.0.1:<far>` really goes. */
  readonly maps: (ports: Readonly<Record<number, number>>) => Effect.Effect<void>;
  /** Whether a master the fake opens waits forever on its login. */
  readonly hangs: (hanging: boolean) => Effect.Effect<void>;
  /** Ends every master, as a sleep or a dropped network does, logging nothing. */
  readonly drop: Effect.Effect<void>;
  /** Whether a master ends just before a session rides it. */
  readonly dropsBeforeRide: (dropping: boolean) => Effect.Effect<void>;
}

const Bound = Schema.Struct({ port: Schema.Finite });

/** The port a server listens on. */
export const portOf = (server: Server) => {
  const address = server.address();
  return Schema.is(Bound)(address) ? address.port : 0;
};

/** A port of 127.0.0.1 nothing listens on now. */
export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = portOf(server);
    server.close(() => resume(Effect.succeed(port)));
  });
});

/** A request on a master's control path, as `fake-ssh-main.ts` reads one. */
const tell = (path: string, op: string) =>
  Effect.callback<void>((resume) => {
    const conn = createConnection(path);
    conn.once("connect", () => conn.write(`${encode({ op })}\n`));
    conn.resume();
    conn.once("error", () => resume(Effect.void));
    conn.once("close", () => resume(Effect.void));
  });

/**
 * Writes `bin` as a fake `ssh` keeping its state in `dir`. A session runs with `env` where
 * one is given, as a login on the far Machine would.
 */
export const writeFakeSsh = Effect.fn("FakeSsh.write")(function* (
  bin: string,
  dir: string,
  env: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const log = `${dir}/ssh-calls.log`;
  const quote = (word: string) => Result.getOrThrow(CommandLine.quote(word));
  const executable = yield* fixtureBinary("ssh");
  yield* fs.writeFileString(
    bin,
    `#!/bin/sh\nFAKE_SSH_LOG=${quote(log)} FAKE_SSH_DIR=${quote(dir)} FAKE_SSH_ENV=${quote(encode(env))} exec ${quote(executable)} "$@"\n`,
    { mode: 0o755 },
  );
  yield* fs.writeFileString(log, "");
  const drop = fs.readFileString(`${dir}/masters`).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((paths) =>
      Effect.forEach(
        Arr.filter(Str.split(paths, "\n"), (path) => path !== ""),
        (path) => tell(path, "drop"),
        { discard: true },
      ),
    ),
  );
  yield* Effect.addFinalizer(() => drop);
  const flag = (name: string) => (on: boolean) =>
    (on
      ? fs.writeFileString(`${dir}/${name}`, "")
      : fs.remove(`${dir}/${name}`, { force: true })
    ).pipe(Effect.orDie);
  const fake: FakeSsh = {
    log,
    calls: fs.readFileString(log).pipe(
      Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
      Effect.orDie,
    ),
    maps: (ports) => fs.writeFileString(`${dir}/ports.json`, encode(ports)).pipe(Effect.orDie),
    hangs: flag("master-hangs"),
    drop,
    dropsBeforeRide: flag("drops-before-ride"),
  };
  return fake;
});

/** A TCP server on `port` of 127.0.0.1 that destroys each connection at its first bytes. */
export const resetter = (port: number) => blocker(onLoopback(port), true);

/** A master's control socket at `path` that takes each request and never answers it. */
export const silentMaster = (path: string) =>
  blocker((server, listening) => server.listen(path, listening), false);

/** A TCP server on `port` of 127.0.0.1 that takes each connection and never answers. */
export const blackhole = (port: number) => blocker(onLoopback(port), false);

const onLoopback = (port: number) => (server: Server, listening: () => void) =>
  server.listen(port, "127.0.0.1", listening);

const blocker = (
  listen: (server: Server, listening: () => void) => void,
  resets: boolean,
): Effect.Effect<Server, never, Scope.Scope> => {
  const held = new Set<Socket>();
  return Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((conn) => {
        held.add(conn);
        conn.once("close", () => held.delete(conn));
        if (resets) conn.once("data", () => conn.destroy());
        conn.once("error", () => {});
      });
      listen(server, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        held.forEach((conn) => conn.destroy());
      }),
  );
};
