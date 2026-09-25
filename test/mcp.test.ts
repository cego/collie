import { expect, test } from "bun:test";
import { Cause, Config, Effect, Fiber, FileSystem, Option, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import manifest from "../herdr-plugin.toml";
import type { JsonObject } from "../src/schema";
import { TOOLS } from "../src/tools";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.JsonObject));
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      result: Schema.optionalKey(Schema.JsonObject),
      error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
    }),
  ),
);

const openServer = Effect.fn("McpTest.open")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-mcp-" });
  const input = yield* Queue.unbounded<string, Cause.Done>();
  // Exercise the same public contract against the compiled executable after a build.
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? binary.value : (Bun.argv[0] ?? "bun");
  const args = Option.isSome(binary) ? ["mcp"] : [`${root}src/main.ts`, "mcp"];
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, {
      cwd: root,
      env: {
        HOME: dir,
        HERDR_PLUGIN_ROOT: root,
        COLLIE_USER_DIR: `${dir}/config`,
        HERDR_PLUGIN_STATE_DIR: `${dir}/state`,
        HERDR_SOCKET_PATH: `${dir}/no-herdr.sock`,
        COLLIE_CWD: dir,
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
    close: Effect.gen(function* () {
      yield* Queue.end(input);
      expect(Number(yield* child.exitCode.pipe(Effect.timeout("5 seconds")))).toBe(0);
      expect(yield* Fiber.join(diagnostics)).toBe("");
    }),
  };
});

test(
  "stdio MCP preserves discovery, tool responses, errors, and shutdown",
  () =>
    runEffect(
      Effect.gen(function* () {
        const server = yield* openServer();
        const listed = yield* server.request("tools/list", {});
        expect(listed).toMatchObject({
          result: {
            tools: TOOLS.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.input,
              annotations: { readOnlyHint: tool.readOnly },
            })),
          },
        });
        const called = yield* server.request("tools/call", {
          name: "collie_run",
          arguments: { run: "missing-run" },
        });
        expect(called.result).toMatchObject({
          content: [
            { type: "text", text: 'No Run "missing-run". collie_herd lists the ones there are.' },
          ],
        });
        const invalid = yield* server.request("tools/call", {
          name: "collie_hold",
          arguments: { run: "missing-run", unexpected: true },
        });
        expect(invalid.result).toMatchObject({
          content: [{ type: "text", text: expect.stringContaining("Nothing was done.") }],
        });

        const malformed = yield* server.request("tools/call", {
          name: "collie_hold",
          arguments: [],
        });
        expect(malformed.error).toMatchObject({ code: -32602 });

        const unknown = yield* server.request("tools/call", {
          name: "not-a-collie-tool",
          arguments: {},
        });
        expect(unknown.error).toMatchObject({ code: -32602 });
        expect((yield* server.request("ping", {})).result).toEqual({});
        yield* server.close;
      }).pipe(Effect.scoped),
    ),
  15_000,
);

test("external interruption is not mistaken for clean MCP EOF", () =>
  runEffect(
    Effect.gen(function* () {
      const server = yield* openServer();
      yield* server.child.kill({ killSignal: "SIGINT" });
      expect(Number(yield* server.child.exitCode.pipe(Effect.timeout("5 seconds")))).toBe(130);
    }).pipe(Effect.scoped),
  ));
