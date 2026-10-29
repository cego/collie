#!/usr/bin/env bun
// The fake herdr and fake forge as executables: a process started for every call, which
// hands its argv, working directory and environment to the test process on COLLIE_FAKE_SOCKET and prints the
// answer it gets back. Load only the codecs and configuration this startup path uses.

// BunSocket exposes WebSocket, while this protocol needs a Unix socket's write-half close.
// oxlint-disable-next-line effecttsgo/node-builtin-import
import { connect } from "node:net";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const path = Effect.runSync(Config.String("COLLIE_FAKE_SOCKET").pipe(Config.withDefault("")));
const CallJson = Schema.fromJsonString(
  Schema.Struct({
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    env: Schema.Record(Schema.String, Schema.String),
  }),
);
const AnswerJson = Schema.fromJsonString(
  Schema.Struct({
    code: Schema.Finite,
    stdout: Schema.String,
    stderr: Schema.String,
  }),
);
let reply = "";

const fail = (why: string) => {
  Effect.runSync(
    Console.error(`fake ${process.argv[2] ?? ""}: no test process answers on ${path}: ${why}`),
  );
  process.exitCode = 70;
};

const socket = connect(path);
socket.setEncoding("utf8");
socket.on("connect", () => {
  const call = Result.getOrThrow(
    Schema.encodeUnknownResult(CallJson)({
      argv: Arr.drop(process.argv, 2),
      cwd: process.cwd(),
      // Replay the caller's exact environment; Config provides named settings, not this record.
      // oxlint-disable-next-line effecttsgo/process-env
      env: process.env,
    }),
  );
  socket.end(`${call}\n`);
});
socket.on("data", (chunk) => {
  reply += chunk;
});
socket.on("error", (error: NodeJS.ErrnoException) => fail(error.code ?? error.message));
socket.on("close", (hadError) => {
  if (hadError) return;
  const decoded = Schema.decodeOption(AnswerJson)(reply);
  if (Option.isNone(decoded)) return fail("it closed without an answer");
  const answer = decoded.value;
  process.stderr.write(answer.stderr);
  process.stdout.write(answer.stdout);
  process.exitCode = answer.code;
});
