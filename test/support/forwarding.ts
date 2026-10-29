// The test process's side of the fakes: one unix socket per test process, on which it answers
// every call a fake's forwarder (forwarder.ts) hands it, with the fake's own core.

import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { Cause, Effect, FileSystem, Result, Schema, Semaphore } from "effect";
import { CommandLine } from "effect/process";
import { MARKER } from "./sweep";

export interface Answer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Answers one call: its argv, the fake's name first, and the environment and directory it
 * was started in.
 */
export type Answerer = (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd: string,
) => Effect.Effect<Answer, unknown>;

/** How a shim starts the forwarder: what `bun run test` compiled of it, or else its source. */
export const forwarderCommand = (compiled = Bun.env.COLLIE_TEST_FAKE_HERDR ?? ""): string[] =>
  compiled === ""
    ? [process.execPath, new URL("./forwarder.ts", import.meta.url).pathname]
    : [compiled];

const Call = Schema.fromJsonString(
  Schema.Struct({
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
  }),
);

const ANSWERER = "COLLIE_FAKE_ANSWERER";
const answerers = new Map<string, Answerer>();

const answer = (request: string) =>
  Schema.decodeUnknownEffect(Call)(request).pipe(
    Effect.flatMap(({ argv, cwd, env }) => {
      const answerer = answerers.get(env[ANSWERER] ?? "");
      return answerer === undefined
        ? Effect.succeed({ code: 70, stdout: "", stderr: `no fake answers ${argv[0]}\n` })
        : answerer(argv, { ...env }, cwd);
    }),
    Effect.catchCause((cause) =>
      Effect.succeed({ code: 70, stdout: "", stderr: `${Cause.pretty(cause)}\n` }),
    ),
  );

const serve = (path: string) =>
  Effect.callback<Server, Error>((resume) => {
    const server = createServer({ allowHalfOpen: true }, (connection) => {
      let request = "";
      connection.setEncoding("utf8");
      connection.on("data", (chunk) => {
        request += chunk;
      });
      connection.on("end", () => {
        void Effect.runPromise(answer(request)).then((reply) =>
          connection.end(JSON.stringify(reply)),
        );
      });
      connection.on("error", () => {});
    });
    server.unref();
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(path, () => resume(Effect.succeed(server)));
  });

let listening: { readonly path: string; readonly server: Server } | null = null;
const once = Semaphore.makeUnsafe(1);

/**
 * Inside the file's root, under its home, which the preload neither sweeps nor counts as left.
 * A new one once that root is gone, as it is between `--rerun-each` runs.
 */
const socket = once.withPermits(1)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (listening !== null && (yield* fs.exists(listening.path))) return listening.path;
    listening?.server.close();
    // The preload's, whatever Config provider a test runs this under.
    const root = Bun.env[MARKER];
    const at = `${root === undefined ? tmpdir() : `${root}/home`}/fake.sock`;
    yield* fs.remove(at, { force: true });
    listening = { path: at, server: yield* serve(at) };
    return at;
  }).pipe(Effect.orDie),
);

/**
 * A shim's command line: `compiled` (or the forwarder's source) with `args` and the shim's
 * own, its calls answered here by `answerer`. Listens first, so the
 * shim's first call is answered.
 */
export const forwarding = Effect.fn("forwarding")(function* (
  compiled: string,
  args: ReadonlyArray<string>,
  answerer: Answerer,
) {
  const id = String(answerers.size);
  answerers.set(id, answerer);
  const at = yield* socket;
  const command = Result.getOrThrow(CommandLine.join([...forwarderCommand(compiled), ...args]));
  return `COLLIE_FAKE_SOCKET=${Result.getOrThrow(CommandLine.quote(at))} ${ANSWERER}=${id} exec ${command} "$@"`;
});
