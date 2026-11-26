import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import type { Cause } from "effect";
import {
  Config,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Order,
  Queue,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import manifest from "../package.json";
import type { JsonObject } from "../src/schema";
import { RunRecords } from "../src/run-records";
import { acceptedName } from "../src/step-output";
import { recordsAt } from "./support/records";
import { rebuiltAnswer } from "../src/mcp";
import { connect } from "../src/host";
import { readAudit } from "../src/audit";
import { recordsReadLayer } from "../src/records";
import { runDir } from "../src/engine";
import { until } from "./support/host";
import { twoMachines } from "./support/peers";
import { TOOLS } from "../src/tools";
import { runEffect, suiteEnv } from "./support/effect";
import { launchOf, registeredAt } from "./support/records";

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
    close: Effect.gen(function* () {
      yield* Queue.end(input);
      expect(Number(yield* child.exitCode.pipe(Effect.timeout("5 seconds")))).toBe(0);
      expect(yield* Fiber.join(diagnostics)).toBe("");
    }),
  };
});

test("stdio MCP preserves discovery, tool responses, errors, and shutdown", () =>
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
      expect(malformed.error).toMatchObject({ code: -32_602 });

      const unknown = yield* server.request("tools/call", {
        name: "not-a-collie-tool",
        arguments: {},
      });
      expect(unknown.error).toMatchObject({ code: -32_602 });
      expect((yield* server.request("ping", {})).result).toEqual({});
      yield* server.close;
    }).pipe(Effect.scoped),
  ));

test("a Run agent's tool server lists collie_submit, and the Home chat's does not", () =>
  runEffect(
    Effect.gen(function* () {
      const chat = yield* openServer();
      expect(encodeValue((yield* chat.request("tools/list", {})).result)).not.toContain(
        `"collie_submit"`,
      );
      yield* chat.close;
      const agent = yield* openServer({ COLLIE_RUN: "r1", COLLIE_AGENT: "one" });
      expect(encodeValue((yield* agent.request("tools/list", {})).result)).toContain(
        `"collie_submit"`,
      );
      yield* agent.close;
      const reviewer = yield* openServer({
        COLLIE_RUN: "r1",
        COLLIE_AGENT: "one",
        COLLIE_TOOLS_ROLE: "reviewer",
      });
      const listed = encodeValue((yield* reviewer.request("tools/list", {})).result);
      expect(listed).toContain(`"collie_submit"`);
      expect(listed).not.toContain(`"collie_hold"`);
      yield* reviewer.close;
    }).pipe(Effect.scoped),
  ));

test("the Collie server started for a reviewer under role_tools: role lists and accepts only the reviewer's tools", () =>
  runEffect(
    Effect.gen(function* () {
      const server = yield* openServer({ COLLIE_TOOLS_ROLE: "reviewer" });
      const listed = yield* server.request("tools/list", {});
      const names = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
      )(listed.result);
      expect(
        Arr.sort(
          Arr.map(names.tools, (tool) => tool.name),
          Order.String,
        ),
      ).toEqual(["collie_artefacts", "collie_report", "collie_run"]);
      const offered = yield* server.request("tools/call", {
        name: "collie_run",
        arguments: { run: "missing-run" },
      });
      expect(offered.result).toMatchObject({
        content: [{ type: "text", text: expect.stringContaining("missing-run") }],
      });
      const unlisted = yield* server.request("tools/call", {
        name: "collie_hold",
        arguments: { run: "missing-run" },
      });
      expect(unlisted.result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(/^collie_hold is not among the reviewer's Collie tools/),
          },
        ],
      });
      yield* server.close;
    }).pipe(Effect.scoped),
  ));

test("collie_submit decodes an agent's Output as the file did, and records only an accepted one", () =>
  runEffect(
    twoMachines(
      "collie-mcp-submit-",
      (first) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${first.world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encodeValue([null]));
          const started = yield* first.cli(["run", "start", "attended", "--input", "work=MCP"], {
            FAKE_HERDR_OUTPUTS: outputs,
          });
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const launch = yield* until(
            () => launchOf(first.world.state, runId, "build"),
            (one) => one !== undefined,
          );
          const server = yield* openServer({
            ...first.env,
            COLLIE_RUN: runId,
            COLLIE_AGENT: launch!.agent,
          });
          const submit = (output: JsonObject) =>
            server.request("tools/call", { name: "collie_submit", arguments: { output } });

          const missing = yield* until(
            () => submit({}),
            (answer) => Str.includes("not usable")(encodeValue(answer.result)),
          );
          expect(missing.result).toMatchObject({
            content: [
              { type: "text", text: expect.stringContaining('Missing key\n  at ["verdict"]') },
            ],
          });
          expect(yield* fs.exists(launch!.output)).toBe(false);

          expect((yield* submit({ verdict: "done" })).result).toMatchObject({
            content: [{ type: "text", text: "accepted" }],
          });
          expect(yield* fs.exists(launch!.output)).toBe(false);
          const fact = (name: string) =>
            RunRecords.use((records) => records.fact(runId, name)).pipe(
              Effect.provide(recordsAt(first.world.state)),
            );
          const accepted = acceptedName(launch!.output);

          // WARNING: A submit that reaches no step is answered "submit it again", so the retry is the tool's own advice.
          yield* until(
            () => submit({ verdict: "done" }),
            (answer) => Str.includes("accepted")(encodeValue(answer.result)),
          );
          const held = yield* fact(accepted);
          expect(held).not.toBeNull();
          const retried = encodeValue((yield* submit({ verdict: "changed" })).result);
          expect(retried).not.toEqual(
            yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              content: [{ type: "text", text: "accepted" }],
            }),
          );
          expect(retried).toContain("differs");
          expect(yield* fact(accepted)).toEqual(held);
          expect(yield* fs.exists(launch!.output)).toBe(false);
          yield* server.close;
        }),
      ["attended.workflow.ts"],
    ),
  ));

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

test("a Run agent's stdio MCP records the launched address and refuses a forged sender", () =>
  runEffect(
    twoMachines(
      "collie-mcp-agent-",
      (first) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${first.world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
          const started = yield* first.cli(["run", "start", "attended", "--input", "work=MCP"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const host = yield* connect(first.world.state);
          yield* until(
            () => host.run({ runId }),
            (view) => Arr.some(view?.waiting ?? [], (one) => one.answer === null),
          );
          const agent = Option.getOrUndefined(
            Arr.findFirst(yield* registeredAt(first.world.state), (one) => one.runId === runId),
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
            yield* readAudit(runDir(first.world.state, runId)).pipe(
              Effect.provide(recordsReadLayer(first.world.state)),
            ),
            (one) => one.operation === "deliver",
          ).length;
          const answer = yield* server.request("tools/call", {
            name: "collie_do",
            arguments: { actions },
          });
          expect(encodeValue(answer)).toContain("deliver: applied");
          const trail = Arr.filter(
            yield* readAudit(runDir(first.world.state, runId)).pipe(
              Effect.provide(recordsReadLayer(first.world.state)),
            ),
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
  ));
