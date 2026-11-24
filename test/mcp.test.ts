import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option, Order, Schema, flow, Result } from "effect";
import type { JsonObject } from "../src/schema";
import { rebuiltAnswer } from "../src/mcp";
import { connect } from "../src/host";
import { readAudit, recordAudit } from "../src/audit";
import { recordsAt } from "./support/records";
import { recordsReadLayer } from "../src/records";
import { runDir } from "../src/engine";
import { until } from "./support/host";
import { openServer } from "./support/mcp";
import { twoMachines } from "./support/peers";
import { TOOLS } from "../src/tools";
import { runEffect } from "./support/effect";
import { launchOf, registeredAt } from "./support/records";

const encodeValue = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

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

test("collie_submit decodes an agent's Output as the file does, and writes only an accepted one, once", () =>
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
            COLLIE_OUTPUT_SUBMIT: "tool",
          });
          const submit = (output: JsonObject) =>
            server.request("tools/call", { name: "collie_submit", arguments: { output } });

          const missing = yield* until(
            () => submit({}),
            (answer) => !Str.includes("No step of")(encodeValue(answer.result)),
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
          const host = yield* connect(first.world.state);
          const asked = (view: { readonly waiting?: ReadonlyArray<{ answer: unknown }> } | null) =>
            Arr.filter(view?.waiting ?? [], (one) => one.answer === null);
          yield* until(
            () => host.run({ runId }),
            (view) => asked(view).length > 0,
          );
          expect(yield* fs.readFileString(launch!.output)).toBe(encodeValue({ verdict: "done" }));
          const written = (yield* fs.stat(launch!.output)).ino;

          expect((yield* submit({ verdict: "done" })).result).toMatchObject({
            content: [{ type: "text", text: "accepted" }],
          });
          expect((yield* fs.stat(launch!.output)).ino).toEqual(written);
          expect((yield* submit({ verdict: "changed" })).result).toMatchObject({
            content: [{ type: "text", text: expect.stringContaining("already collected") }],
          });
          expect(yield* fs.readFileString(launch!.output)).toBe(encodeValue({ verdict: "done" }));
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

test("a tool whose answer dies says what broke and under which request, not a bare Internal error", () =>
  runEffect(
    twoMachines(
      "collie-mcp-defect-",
      (first) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${first.world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, encodeValue([{ verdict: "done" }]));
          const started = yield* first.cli(["run", "start", "attended", "--input", "work=MCP"]);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const launch = yield* until(
            () => launchOf(first.world.state, runId, "build"),
            (one) => one !== undefined,
          );
          const herds = yield* fs.readDirectory(`${first.world.state}/herd`);
          yield* recordAudit(`${first.world.state}/herd/${herds[0]!}`, {
            operation: "propose",
            request: "defect-1",
            origin: "desktop",
            result: Schema.String,
            value: "",
          }).pipe(Effect.provide(recordsAt(first.world.state)));
          const server = yield* openServer({
            ...first.env,
            COLLIE_RUN: runId,
            COLLIE_AGENT: launch!.agent,
          });
          const answered = yield* server.request("tools/call", {
            name: "collie_propose",
            arguments: {
              request_id: "defect-1",
              interpretation: "the heal found a constraint worth keeping",
              actions: [
                {
                  kind: "update_intent",
                  run: runId,
                  change: "add-constraint",
                  patch: "keep the picker behind a flag",
                  base_version: 1,
                },
              ],
            },
          });
          expect(answered.error).toBeUndefined();
          const text = encodeValue(answered.result);
          expect(text).toContain("Collie could not answer");
          expect(text).toContain("Expected object");
          expect(text).toContain("defect-1");
          yield* server.child.kill({ killSignal: "SIGINT" });
          expect(Number(yield* server.child.exitCode.pipe(Effect.timeout("5 seconds")))).toBe(130);
          expect(yield* Fiber.join(server.diagnostics)).toContain(
            "collie tool collie_propose died",
          );
        }),
      ["attended.workflow.ts"],
    ),
  ));
