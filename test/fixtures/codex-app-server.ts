/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- a stand-in process, outside Effect as Codex is. */

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { Schema, flow, Result } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { childEnv } from "../../desktop/src/bun/login-env";
import type { JsonObject } from "../../src/schema";

const Json = Schema.fromJsonString(Schema.Json);
const encode = flow(Schema.encodeResult(Json), Result.getOrThrow);
const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const decode = flow(Schema.decodeResult(Schema.fromJsonString(Message)), Result.getOrThrow);
const send = (message: JsonObject) => process.stdout.write(`${encode(message)}\n`);
const notify = (method: string, params: JsonObject) => send({ method, params });

const config = new Map<string, Schema.Json>();
for (const [at, arg] of Bun.argv.entries())
  if (Bun.argv[at - 1] === "-c") {
    const [key, ...value] = Str.split(arg, "=");
    config.set(key!, flow(Schema.decodeResult(Json), Result.getOrThrow)(Arr.join(value, "=")));
  }
const server = "collie_desktop";

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const Store = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      id: Schema.String,
      cwd: Schema.String,
      params: JsonObject,
      turns: Schema.Array(Schema.Struct({ id: Schema.String, items: Schema.Array(JsonObject) })),
      updatedAt: Schema.Finite,
    }),
  ),
);
interface Turn {
  readonly id: string;
  readonly items: Array<JsonObject>;
}
interface Thread {
  readonly id: string;
  readonly cwd: string;
  readonly params: JsonObject;
  readonly turns: Array<Turn>;
  updatedAt: number;
}
const storePath = `${process.cwd()}/fake-codex.json`;
const threads: Record<string, Thread> = Rec.map(
  (await Bun.file(storePath).exists())
    ? flow(Schema.decodeResult(Store), Result.getOrThrow)(await Bun.file(storePath).text())
    : {},
  (thread) => ({
    ...thread,
    turns: Arr.map(thread.turns, (turn) => ({ id: turn.id, items: [...turn.items] })),
  }),
);
const save = () =>
  Bun.write(storePath, flow(Schema.encodeResult(Store), Result.getOrThrow)(threads));

let loaded: Thread | undefined;
let running: { turn: Turn; release: () => void } | undefined;
const answers = new Map<string | number, (result: Schema.Json) => void>();
const ask = (method: string, params: JsonObject) =>
  new Promise<Schema.Json>((resolve) => {
    const id = `server-${answers.size + 1}`;
    answers.set(id, resolve);
    send({ id, method, params });
  });

const item = (turn: Turn, one: JsonObject, live = true) => {
  if (live) notify("item/started", { threadId: loaded!.id, turnId: turn.id, item: one });
  turn.items.push(one);
};
const completed = (turn: Turn, one: JsonObject) => {
  notify("item/completed", { threadId: loaded!.id, turnId: turn.id, item: one });
  const at = Arr.findFirstIndex(turn.items, (held) => held.id === one.id);
  if (at._tag === "Some") turn.items[at.value] = one;
  else turn.items.push(one);
};
const finish = async (turn: Turn, status: string, error: JsonObject | null = null) => {
  loaded!.updatedAt += 1;
  await save();
  running = undefined;
  notify("turn/completed", { threadId: loaded!.id, turn: { id: turn.id, status, error } });
};
const usage = (turn: Turn, input: number, cached: number, output: number) =>
  notify("thread/tokenUsage/updated", {
    threadId: loaded!.id,
    turnId: turn.id,
    tokenUsage: {
      last: {
        totalTokens: input + output,
        inputTokens: input,
        cachedInputTokens: cached,
        cacheWriteInputTokens: 0,
        outputTokens: output,
        reasoningOutputTokens: 0,
      },
    },
  });

const play = async (turn: Turn, params: JsonObject) => {
  const input = Arr.isArray(params.input) ? params.input : [];
  const first = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))(input[0]);
  const said = first._tag === "Some" ? first.value.text : "";
  item(turn, { type: "userMessage", id: `${turn.id}-user`, clientId: null, content: input }, false);
  notify("turn/started", { threadId: loaded!.id, turn: { id: turn.id, status: "inProgress" } });
  const reply = (id: string, text: string) => {
    notify("item/agentMessage/delta", {
      threadId: loaded!.id,
      turnId: turn.id,
      itemId: id,
      delta: text,
    });
    completed(turn, { type: "agentMessage", id, text });
  };
  if (pipe(said, Str.startsWith("inspect"))) {
    reply(
      `${turn.id}-inspect`,
      encode({
        args: Bun.argv.slice(2),
        cwd: process.cwd(),
        hasToken: childEnv().COLLIE_CHAT_MCP_TOKEN !== undefined,
        thread: loaded!.id,
        start: loaded!.params,
        turn: params,
      }),
    );
    return finish(turn, "completed");
  }
  if (pipe(said, Str.startsWith("question"))) {
    const questions = {
      questions: [{ question: "Where?", header: "Place", options: [{ label: "Here" }] }],
    };
    const call = {
      type: "mcpToolCall",
      id: `${turn.id}-ask`,
      server,
      tool: "AskUserQuestion",
      status: "inProgress",
      arguments: questions,
      result: null,
      error: null,
    };
    item(turn, call);
    const client = new Client({ name: "codex-stand-in", version: "1" });
    const url = config.get(`mcp_servers.${server}.url`);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(Str.isString(url) ? url : ""), {
        requestInit: { headers: { Authorization: `Bearer ${childEnv().COLLIE_CHAT_MCP_TOKEN}` } },
      }),
    );
    const result = await client.callTool({ name: "AskUserQuestion", arguments: questions });
    await client.close();
    completed(turn, {
      ...call,
      status: "completed",
      result: {
        content: flow(Schema.decodeUnknownResult(Schema.Json), Result.getOrThrow)(result.content),
        structuredContent: null,
        _meta: null,
      },
    });
    return finish(turn, "completed");
  }
  if (pipe(said, Str.startsWith("wait"))) {
    await new Promise<void>((release) => {
      running = { turn, release };
    });
    return finish(turn, "interrupted");
  }
  if (pipe(said, Str.startsWith("limit")))
    return finish(turn, "failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    });
  if (pipe(said, Str.startsWith("signed-out")))
    return finish(turn, "failed", { message: "Unauthorized", codexErrorInfo: "unauthorized" });
  if (pipe(said, Str.startsWith("crash"))) {
    process.stderr.write("codex: the model provider refused the connection\n");
    process.exit(3);
  }
  notify("item/reasoning/summaryTextDelta", {
    threadId: loaded!.id,
    turnId: turn.id,
    itemId: `${turn.id}-think`,
    delta: "Considering",
    summaryIndex: 0,
  });
  completed(turn, {
    type: "reasoning",
    id: `${turn.id}-think`,
    summary: ["Considering"],
    content: [],
  });
  for (const delta of ["Hel", "lo"])
    notify("item/agentMessage/delta", {
      threadId: loaded!.id,
      turnId: turn.id,
      itemId: `${turn.id}-text`,
      delta,
    });
  completed(turn, { type: "agentMessage", id: `${turn.id}-text`, text: "Hello" });
  await ask("item/tool/requestUserInput", {
    threadId: loaded!.id,
    turnId: turn.id,
    itemId: "x",
    questions: [],
  });
  const herd = {
    type: "mcpToolCall",
    id: `${turn.id}-herd`,
    server,
    tool: "collie_herd",
    status: "inProgress",
    arguments: {},
    result: null,
    error: null,
  };
  item(turn, herd);
  completed(turn, {
    ...herd,
    status: "completed",
    result: { content: [{ type: "text", text: "No Herds" }], structuredContent: null, _meta: null },
  });
  const shell = {
    type: "commandExecution",
    id: `${turn.id}-shell`,
    command: "ls",
    cwd: process.cwd(),
    status: "inProgress",
    aggregatedOutput: null,
  };
  item(turn, shell);
  completed(turn, { ...shell, status: "completed", aggregatedOutput: "notes.md\n" });
  usage(turn, 10, 4, 5);
  usage(turn, 6, 2, 2);
  return finish(turn, "completed");
};

let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += new TextDecoder().decode(chunk);
  let at: number;
  while ((at = Option.getOrElse(pipe(pending, Str.indexOf("\n")), () => -1)) >= 0) {
    const message = decode(pipe(pending, Str.slice(0, at)));
    pending = pipe(pending, Str.slice(at + 1));
    const params = message.params ?? {};
    const answer = (result: Schema.Json) => send({ id: message.id!, result });
    if (message.method === undefined) {
      answers.get(message.id!)?.(null);
      continue;
    }
    switch (message.method) {
      case "initialize":
        answer({ userAgent: "codex-stand-in" });
        break;
      case "account/read":
        answer(
          childEnv().FAKE_CODEX_SIGNED_OUT === "1"
            ? { account: null, requiresOpenaiAuth: true }
            : {
                account: { type: "chatgpt", email: null, planType: "pro" },
                requiresOpenaiAuth: true,
              },
        );
        break;
      case "thread/start": {
        const id = `thread-${Arr.length(Rec.keys(threads)) + 1}`;
        loaded = {
          id,
          cwd: Str.isString(params.cwd) ? params.cwd : "",
          params,
          turns: [],
          updatedAt: 1,
        };
        threads[id] = loaded;
        await save();
        answer({ thread: { id } });
        break;
      }
      case "thread/resume": {
        const known = Str.isString(params.threadId) ? threads[params.threadId] : undefined;
        if (known === undefined) {
          send({
            id: message.id!,
            error: {
              code: -32600,
              message: `no rollout found for thread id ${Str.isString(params.threadId) ? params.threadId : ""}`,
            },
          });
          break;
        }
        loaded = known;
        answer({ thread: { id: known.id } });
        break;
      }
      case "turn/start": {
        const turn: Turn = { id: `turn-${loaded!.turns.length + 1}`, items: [] };
        loaded!.turns.push(turn);
        answer({ turn: { id: turn.id, status: "inProgress" } });
        void play(turn, params);
        break;
      }
      case "turn/interrupt":
        answer({});
        running?.release();
        break;
      case "thread/list":
        answer({
          data: Arr.map(
            Arr.filter(
              Rec.values(threads),
              (thread) => thread.cwd === params.cwd && thread.turns.length > 0,
            ),
            (thread) => ({
              id: thread.id,
              name: null,
              preview: "hello there",
              updatedAt: thread.updatedAt,
              path: `${process.cwd()}/${thread.id}.jsonl`,
            }),
          ),
          nextCursor: null,
        });
        break;
      case "thread/read": {
        const thread = Str.isString(params.threadId) ? threads[params.threadId] : undefined;
        if (thread === undefined)
          send({ id: message.id!, error: { code: -32600, message: "no such thread" } });
        else answer({ thread: { id: thread.id, path: `${process.cwd()}/${thread.id}.jsonl` } });
        break;
      }
      case "thread/items/list": {
        const thread = Str.isString(params.threadId) ? threads[params.threadId] : undefined;
        const all = Arr.flatMap(thread?.turns ?? [], (turn) =>
          Arr.map(turn.items, (one) => ({ turnId: turn.id, item: one })),
        );
        const from = Str.isString(params.cursor) ? Number(params.cursor) : 0;
        answer({
          data: all.slice(from, from + 2),
          nextCursor: from + 2 < all.length ? String(from + 2) : null,
        });
        break;
      }
      case "model/list":
        answer({
          data: [
            {
              id: "gpt-6.2-sol",
              displayName: "GPT-6.2-Sol",
              description: "Fast, go-to model.",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low",
            },
            {
              id: "gpt-hidden",
              displayName: "Hidden",
              hidden: true,
              supportedReasoningEfforts: [],
            },
          ],
          nextCursor: null,
        });
        break;
      default:
        if (message.id !== undefined) answer({});
    }
  }
}
