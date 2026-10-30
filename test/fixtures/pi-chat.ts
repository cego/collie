import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { Effect, Schema, flow, Result } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { childEnv } from "../../desktop/src/bun/login-env";
import type { JsonObject } from "../../src/schema";
const emit = (record: JsonObject) =>
  process.stdout.write(
    `${flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow)(record)}\n`,
  );
const update = (type: string, extra: JsonObject = {}) =>
  emit({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...extra } });
const path = Bun.argv[Bun.argv.indexOf("builtin:mcp") + 2]!;
const extension = await Bun.file(path).text();
const server = /registerMcpServer\("([^"]+)"/.exec(extension)![1]!;
const namespace = `mcp__${pipe(server, Str.replaceAll("-", "_"))}__`;
const argument = (flag: string) =>
  Bun.argv.includes(flag) ? Bun.argv[Bun.argv.indexOf(flag) + 1] : undefined;
const savedPath = `${argument("--session-dir")}/fixture-${argument("--session-id")}.json`;
const selection = Schema.Struct({ model: Schema.String, thinking: Schema.String });
const saved = (await Bun.file(savedPath).exists())
  ? flow(
      Schema.decodeResult(Schema.fromJsonString(selection)),
      Result.getOrThrow,
    )(await Bun.file(savedPath).text())
  : undefined;
const settingsPath = `${childEnv().PI_CODING_AGENT_DIR ?? process.cwd()}/settings.json`;
const settings = (await Bun.file(settingsPath).exists())
  ? flow(
      Schema.decodeResult(
        Schema.fromJsonString(
          Schema.Struct({
            defaultProvider: Schema.optionalKey(Schema.String),
            defaultModel: Schema.optionalKey(Schema.String),
            defaultThinkingLevel: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      Result.getOrThrow,
    )(await Bun.file(settingsPath).text())
  : {};
const model =
  argument("--model") ??
  saved?.model ??
  `${settings.defaultProvider ?? "auto"}/${settings.defaultModel ?? "default"}`;
const thinking =
  argument("--thinking") ?? saved?.thinking ?? settings.defaultThinkingLevel ?? "medium";
let input = "";
for await (const chunk of Bun.stdin.stream()) {
  input += new TextDecoder().decode(chunk);
  let at: number;
  while ((at = Option.getOrElse(pipe(input, Str.indexOf("\n")), () => -1)) >= 0) {
    const command = flow(
      Schema.decodeResult(
        Schema.fromJsonString(
          Schema.Struct({
            type: Schema.String,
            message: Schema.optionalKey(Schema.String),
            images: Schema.optionalKey(Schema.Array(Schema.Json)),
          }),
        ),
      ),
      Result.getOrThrow,
    )(pipe(input, Str.slice(0, at)));
    input = pipe(input, Str.slice(at + 1));
    if (command.type === "abort") {
      emit({ type: "agent_settled", aborted: true });
      continue;
    }
    if (command.type !== "prompt") continue;
    if (
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(command.message), (present) =>
          pipe(present, Str.startsWith("question")),
        ),
      )
    ) {
      const questions = {
        questions: [
          { question: "Where?", header: "Place", options: [{ label: "Here" }], multiSelect: false },
        ],
      };
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: { role: "assistant" } });
      update("toolcall_start", { id: "question-click", toolName: `${namespace}AskUserQuestion` });
      update("toolcall_end", {
        toolCall: {
          id: "question-click",
          name: `${namespace}AskUserQuestion`,
          arguments: questions,
        },
      });
      emit({
        type: "tool_execution_start",
        toolCallId: "question-click",
        toolName: `${namespace}AskUserQuestion`,
        args: questions,
      });
      const url = /url: "([^"]+)"/.exec(extension)![1]!;
      const client = new Client({ name: "pi-script", version: "1" });
      // The scripted child, like Pi, keeps reading abort while an MCP call is pending.
      void client
        .connect(
          new StreamableHTTPClientTransport(new URL(url), {
            requestInit: {
              headers: { Authorization: `Bearer ${childEnv().COLLIE_CHAT_MCP_TOKEN}` },
            },
          }),
        )
        .then(() => client.callTool({ name: "AskUserQuestion", arguments: questions }))
        .then((result) => {
          emit({
            type: "tool_execution_end",
            toolCallId: "question-click",
            result: {
              content: flow(
                Schema.decodeUnknownResult(Schema.Json),
                Result.getOrThrow,
              )(result.content),
            },
          });
          emit({ type: "agent_settled", aborted: false });
        })
        .finally(() => client.close());
      continue;
    }
    if (
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(command.message), (present_) =>
          pipe(present_, Str.startsWith("inspect")),
        ),
      )
    ) {
      const promptFile = (name: string) =>
        Effect.runPromise(
          Effect.gen(function* () {
            const local = Bun.file(`${process.cwd()}/.pi/${name}`);
            const global = Bun.file(`${childEnv().PI_CODING_AGENT_DIR}/${name}`);
            if (yield* Effect.promise(() => local.exists()))
              return yield* Effect.promise(() => local.text());
            if (yield* Effect.promise(() => global.exists()))
              return yield* Effect.promise(() => global.text());
            return "";
          }),
        );
      await Bun.write(
        savedPath,
        flow(
          Schema.encodeResult(Schema.fromJsonString(selection)),
          Result.getOrThrow,
        )({ model, thinking }),
      );
      const details = {
        args: Bun.argv.slice(2),
        cwd: process.cwd(),
        hasToken: Boolean(childEnv().COLLIE_CHAT_MCP_TOKEN),
        extension,
        model,
        thinking,
        systemPrompt: Arr.join(
          [
            argument("--system-prompt") ?? (await promptFile("SYSTEM.md")),
            argument("--append-system-prompt") ?? (await promptFile("APPEND_SYSTEM.md")),
          ],
          "\n",
        ),
        prompt: command,
      };
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: { role: "assistant" } });
      update("text_start");
      update("text_delta", { delta: JSON.stringify(details) });
      update("text_end");
      emit({ type: "agent_settled", aborted: false });
      continue;
    }
    if (
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(command.message), (present__) =>
          pipe(present__, Str.startsWith("error")),
        ),
      )
    ) {
      emit({ type: "agent_start" });
      emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Model is not available on this provider",
        },
      });
      emit({ type: "agent_settled", aborted: false });
      continue;
    }
    emit({ type: "agent_start" });
    if (
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(command.message), (present___) =>
          pipe(present___, Str.startsWith("hold")),
        ),
      )
    )
      continue;
    emit({ type: "message_start", message: { role: "assistant" } });
    update("thinking_start");
    update("thinking_delta", { delta: "Considering" });
    update("thinking_end");
    update("text_start");
    update("text_delta", { delta: "Hello\u2028world\u2029!" });
    update("text_end");
    update("toolcall_start", { id: "herd", toolName: `${namespace}collie_herd` });
    update("toolcall_end", {
      toolCall: { id: "herd", name: `${namespace}collie_herd`, arguments: {} },
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "herd",
      toolName: `${namespace}collie_herd`,
      args: {},
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "herd",
      toolName: `${namespace}collie_herd`,
      result: { content: [{ type: "text", text: "No Herds" }] },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 12, output: 7, cacheRead: 4 },
        stopReason: "stop",
      },
    });
    emit({ type: "agent_end", messages: [], willRetry: false });
    update("text_start");
    update("text_delta", { delta: "After agent_end" });
    update("text_end");
    emit({ type: "agent_settled", aborted: false });
  }
}
