import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  Cause,
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
import manifest from "../herdr-plugin.toml";
import type { JsonObject } from "../src/schema";
import { rebuiltAnswer } from "../src/mcp";
import { connect } from "../src/host";
import { everyRegistered } from "../src/registry";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { until } from "./support/host";
import { twoMachines } from "./support/peers";
import { TOOLS } from "../src/tools";
import { runEffect, suiteEnv } from "./support/effect";

const encodeValue = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const root = new URL("../", import.meta.url).pathname;
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

const openServer = Effect.fn("McpTest.open")(function* (
  launchEnv: Readonly<Record<string, string>> = {},
) {
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
            tools: Arr.map(TOOLS, (tool) => ({
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

test("a rebuilt binary that warns on stderr still answers", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-rebuilt-" });
      const binary = `${dir}/collie`;
      yield* fs.writeFileString(
        binary,
        `#!/bin/sh\necho "warning: something the binary wants said" >&2\necho '{"ok":true,"data":{"text":"the answer"}}'\n`,
        { mode: 0o755 },
      );

      expect(yield* rebuiltAnswer(binary, dir, "collie_herd", {})).toBe("the answer");
    }).pipe(Effect.scoped),
  ));

test(
  "a Run agent's stdio MCP records the launched address and refuses a forged sender",
  () =>
    runEffect(
      twoMachines(
        "collie-mcp-agent-",
        (first) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = `${first.world.home}/outputs.json`;
            yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
            const started = yield* first.cli(["run", "start", "attended", "--input", "work=MCP"], {
              FAKE_HERDR_OUTPUTS: outputs,
            });
            const { runId } = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ runId: Schema.String }),
            )(started.envelope.data).pipe(Effect.orDie);
            const host = yield* connect(first.world.state);
            yield* until(
              () => host.run({ runId }),
              (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
            );
            const agent = Option.getOrUndefined(
              Arr.findFirst(
                yield* everyRegistered(first.world.state),
                (one) => one.runId === runId,
              ),
            )!;
            const server = yield* openServer({
              ...first.env,
              COLLIE_RUN: runId,
              COLLIE_AGENT: agent.agent,
            });
            const actions = [
              {
                kind: "deliver",
                run: runId,
                agent: agent.agent,
                text: "MCP words",
                mode: "boundary",
              },
            ];
            const forged = yield* server.request("tools/call", {
              name: "collie_do",
              arguments: { sender: "somebody else", actions },
            });
            expect(encodeValue(forged)).toContain("refus");
            const before = Arr.filter(
              yield* readAudit(runDir(first.world.state, runId)),
              (one) => one.operation === "deliver",
            ).length;
            const answer = yield* server.request("tools/call", {
              name: "collie_do",
              arguments: { actions },
            });
            expect(encodeValue(answer)).toContain("deliver: applied");
            const trail = Arr.filter(
              yield* readAudit(runDir(first.world.state, runId)),
              (one) => one.operation === "deliver",
            );
            expect(trail).toHaveLength(before + 1);
            expect(trail.at(-1)?.actor).toMatchObject({
              origin: "agent",
              from: {
                run: runId,
                agent: agent.agent,
                machine: { installation: expect.any(String) },
              },
            });
            yield* server.close;
          }),
        ["attended.workflow.ts"],
      ),
    ),
  180_000,
);
