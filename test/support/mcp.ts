import { expect } from "bun:test";
import type { Cause } from "effect";
import {
  Config,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Queue,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../../package.json";
import type { JsonObject } from "../../src/schema";
import { suiteEnv } from "./effect";

const root = new URL("../../", import.meta.url).pathname;

const encode = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.JsonObject)),
  Result.getOrThrow,
);
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
      result: Schema.optionalKey(Schema.JsonObject),
      error: Schema.optionalKey(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
    }),
  ),
);

export const openServer = Effect.fn("McpTest.open")(function* (
  launchEnv: Readonly<Record<string, string>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-mcp-" });
  const input = yield* Queue.unbounded<string, Cause.Done>();
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? binary.value : (Bun.argv[0] ?? "bun");
  const args = Option.isSome(binary) ? ["mcp"] : [`${root}src/main.ts`, "mcp"];
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd: root,
      env: {
        HOME: dir,
        COLLIE_ROOT: root,
        COLLIE_USER_DIR: `${dir}/config`,
        COLLIE_STATE_DIR: `${dir}/state`,
        COLLIE_CWD: dir,
        ...(yield* suiteEnv),
        ...launchEnv,
      },
      extendEnv: false,
      stdin: Stream.fromQueue(input).pipe(Stream.encodeText),
      stdout: "pipe",
      stderr: "pipe",
      forceKillAfter: "1 second",
    }),
  );
  const replies = yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapEffect((line) => decode(line)),
    Stream.filter((reply) => reply.id !== undefined),
    Stream.toQueue({ capacity: 16 }),
  );
  const diagnostics = yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => text + chunk,
    ),
    Effect.forkScoped,
  );
  let id = 0;
  const request = Effect.fn("McpTest.request")(function* (method: string, params: JsonObject) {
    const requestId = ++id;
    yield* Queue.offer(input, `${encode({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    const reply = yield* Queue.take(replies).pipe(Effect.timeout("5 seconds"));
    expect(reply.id).toBe(requestId);
    return reply;
  });
  const protocolVersion = "2025-11-25";
  const initialized = yield* request("initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "collie-test", version: "1.0.0" },
  });
  expect(initialized).toMatchObject({
    result: {
      protocolVersion,
      serverInfo: { name: "collie", version: manifest.version },
      capabilities: { tools: {} },
    },
  });
  yield* Queue.offer(input, `${encode({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    request,
    child,
    diagnostics,
    close: Effect.gen(function* () {
      yield* Queue.end(input);
      expect(Number(yield* child.exitCode.pipe(Effect.timeout("5 seconds")))).toBe(0);
      expect(yield* Fiber.join(diagnostics)).toBe("");
    }),
  };
});
