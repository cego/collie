import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { Effect, FileSystem, Result, Schema, flow } from "effect";
import { CommandLine } from "effect/process";
import { SOCKET_BASE } from "./sweep";
import { fixtureBinary } from "./bin";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

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

export interface FakeSsh {
  readonly log: string;
  readonly calls: Effect.Effect<ReadonlyArray<string>>;
  readonly maps: (ports: Readonly<Record<number, number>>) => Effect.Effect<void>;
  readonly hangs: (hanging: boolean) => Effect.Effect<void>;
  readonly drop: Effect.Effect<void>;
  readonly dropsBeforeRide: (dropping: boolean) => Effect.Effect<void>;
  readonly configuredForwards: (configured: boolean) => Effect.Effect<void>;
}

const Bound = Schema.Struct({ port: Schema.Finite });

export const portOf = (server: Server) => {
  const address = server.address();
  return Schema.is(Bound)(address) ? address.port : 0;
};

export const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const port = portOf(server);
    server.close(() => resume(Effect.succeed(port)));
  });
});

const tell = (path: string, op: string) =>
  Effect.callback<void>((resume) => {
    const conn = createConnection(path);
    conn.once("connect", () => conn.write(`${encode({ op })}\n`));
    conn.resume();
    conn.once("error", () => resume(Effect.void));
    conn.once("close", () => resume(Effect.void));
  });

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
    configuredForwards: flag("configured-forwards"),
  };
  return fake;
});

export const resetter = (port: number) => blocker(onLoopback(port), true);

export const silentMaster = (path: string) =>
  blocker((server, listening) => server.listen(path, listening), false);

export const blackhole = (port: number) => blocker(onLoopback(port), false);

const onLoopback = (port: number) => (server: Server, listening: () => void) =>
  server.listen(port, "127.0.0.1", listening);

const blocker = (listen: (server: Server, listening: () => void) => void, resets: boolean) => {
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
