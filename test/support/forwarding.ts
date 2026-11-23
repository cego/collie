import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Cause, Effect, FileSystem, Result, Schema, Semaphore } from "effect";
import { CommandLine } from "effect/process";
import { MARKER } from "./sweep";
import { stringifyJson } from "../../src/json";

export interface Answer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Answerer<E> = (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  cwd: string,
) => Effect.Effect<Answer, E>;

export const forwarderCommand = (compiled: string) =>
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
const answerers = new Map<string, Answerer<never>>();

const failedAnswer = <E>(cause: Cause.Cause<E>) =>
  Effect.succeed({ code: 70, stdout: "", stderr: `${Cause.pretty(cause)}\n` });

const inFlight = new Set<Readonly<Record<string, string>>>();

// WARNING: An answer outlives its forwarder once the host has stopped, and still writes where it was asked to.
export const answering = (bindings: Readonly<Record<string, string>>) =>
  Arr.filter(Arr.fromIterable(inFlight), (env) =>
    Arr.every(Rec.toEntries(bindings), ([key, value]) => env[key] === value),
  ).length;

const answer = (request: string) =>
  Schema.decodeEffect(Call)(request).pipe(
    Effect.flatMap(({ argv, cwd, env }) => {
      const answerer = answerers.get(env[ANSWERER] ?? "");
      return answerer === undefined
        ? Effect.succeed({ code: 70, stdout: "", stderr: `no fake answers ${argv[0]}\n` })
        : Effect.sync(() => inFlight.add(env)).pipe(
            Effect.andThen(answerer(argv, { ...env }, cwd)),
            Effect.ensuring(Effect.sync(() => inFlight.delete(env))),
          );
    }),
    Effect.catchCause(failedAnswer),
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
          connection.end(stringifyJson(reply)),
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

// WARNING: Under the file's home, which the preload neither sweeps nor counts as left; a new one once the root is gone (--rerun-each).
const socket = once.withPermits(1)(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (listening !== null && (yield* fs.exists(listening.path))) {
      return listening.path;
    }
    listening?.server.close();
    // WARNING: Read from Bun.env, the preload's, whatever Config provider the test runs under.
    const root = Bun.env[MARKER];
    const at = `${root === undefined ? tmpdir() : `${root}/home`}/fake.sock`;
    yield* fs.remove(at, { force: true });
    listening = { path: at, server: yield* serve(at) };
    return at;
  }).pipe(Effect.orDie),
);

// WARNING: Listen before the shim starts, or its first call goes unanswered.
export const forwarding = Effect.fn("forwarding")(function* <E>(
  compiled: string,
  args: ReadonlyArray<string>,
  answerer: Answerer<E>,
) {
  const id = String(answerers.size);
  answerers.set(id, (argv, env, cwd) =>
    answerer(argv, env, cwd).pipe(Effect.catchCause(failedAnswer)),
  );
  const at = yield* socket;
  const command = Result.getOrThrow(CommandLine.join([...forwarderCommand(compiled), ...args]));
  return `COLLIE_FAKE_SOCKET=${Result.getOrThrow(CommandLine.quote(at))} ${ANSWERER}=${id} exec ${command} "$@"`;
});
