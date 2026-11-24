// WARNING: Codex mints its own thread ids, so codex-threads.json maps each conversation to its thread.
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { hostname } from "node:os";
import {
  Clock,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Queue,
  Schema,
  Scope,
  Stream,
  flow,
  Result,
} from "effect";
import type { Cause } from "effect";
import type { AguiEvent } from "../shared/agui";
import { ends } from "../shared/agui";
import { CodexModelList, codexEntries } from "../../../src/catalogue-model";
import { CodexError } from "../../../src/codex";
import { isNumber, isString } from "../../../src/schema";
import type { JsonObject } from "../../../src/schema";
import { standingDirectionContext } from "../../../src/standing-direction";
import type { ChatEndpoint } from "./chat-endpoint";
import { CodexStatus, NO_SERVERS, codexConnections, codexServers } from "./codex-servers";
import type { CodexServers } from "./codex-servers";
import type { ListedModel } from "./claude-models";
import type { ChatDriver, ContentBlock, DriverContext, TurnCost } from "./driver";
import { listedIn } from "./harness-lists";
import { childEnv, which } from "./login-env";
import { noticedContext, placementContext, systemPrompt } from "./session";
import type { UserMcpServers } from "./session";
import { transcriptOf } from "./transcript";

const TOKEN_ENV = "COLLIE_CHAT_MCP_TOKEN";
const SERVER = "collie_desktop";
const TOOL_TIMEOUT = 24 * 60 * 60;
const CLIENT_INFO = { name: "collie_desktop", title: "Collie Desktop", version: "1" };
const NOTE = "[Desktop: context accompanying this message]";
const SIGNED_OUT =
  "Codex is not signed in on this computer: run `codex login` in a terminal, then send your message again.";
const SIGN_IN = "run `codex login` in a terminal, then send your message again.";
const NOT_INSTALLED = "codex is not installed or not on PATH on this computer";

const encodeLine = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);
const Message = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(
    Schema.Struct({ message: Schema.String, code: Schema.optionalKey(Schema.Finite) }),
  ),
});
type Message = typeof Message.Type;
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

interface Heard {
  readonly id: Message["id"];
  readonly method: string;
  readonly params: Schema.Json | undefined;
}

const appServer = Effect.fnUntraced(function* (
  command: ReadonlyArray<string>,
  dir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...command, "app-server", ...args], {
          cwd: dir,
          env: { ...env },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: () => new CodexError({ message: NOT_INSTALLED }),
    }),
    (child) => Effect.sync(() => child.kill()),
  );
  const said = yield* Effect.promise(() => new Response(child.stderr).text()).pipe(
    Effect.forkScoped,
  );
  const heard = yield* Queue.unbounded<Heard, CodexError | Cause.Done>();
  const pending = new Map<number, Deferred.Deferred<Schema.Json, CodexError>>();
  let next = 0;
  const send = (message: JsonObject) =>
    Effect.tryPromise(() => Promise.resolve(child.stdin.write(`${encodeLine(message)}\n`))).pipe(
      Effect.andThen(Effect.tryPromise(() => Promise.resolve(child.stdin.flush()))),
      Effect.ignore,
    );
  yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => {
      const message = Option.getOrUndefined(decodeMessage(line));
      if (message === undefined) {
        return Effect.void;
      }
      if (message.method !== undefined) {
        return Queue.offer(heard, {
          id: message.id,
          method: message.method,
          params: message.params,
        });
      }
      const waiting = isNumber(message.id) ? pending.get(message.id) : undefined;
      if (waiting === undefined) {
        return Effect.void;
      }
      pending.delete(Number(message.id));
      return message.error === undefined
        ? Deferred.succeed(waiting, message.result ?? null)
        : Deferred.fail(waiting, new CodexError(message.error));
    }),
    Effect.ignore,
    Effect.andThen(
      Effect.gen(function* () {
        const code = yield* Effect.promise(() => child.exited);
        const why = new CodexError({
          message: Str.trim(yield* Fiber.join(said)) || `Codex ended its session (exit ${code}).`,
        });
        for (const waiting of pending.values()) {
          yield* Deferred.fail(waiting, why);
        }
        pending.clear();
        yield* Queue.fail(heard, why);
      }),
    ),
    Effect.forkScoped,
  );
  const call = (method: string, params: JsonObject) =>
    Effect.gen(function* () {
      const id = ++next;
      const answered = yield* Deferred.make<Schema.Json, CodexError>();
      pending.set(id, answered);
      yield* send({ jsonrpc: "2.0", id, method, params });
      return yield* Deferred.await(answered);
    });
  yield* call("initialize", { clientInfo: CLIENT_INFO });
  yield* send({ jsonrpc: "2.0", method: "initialized" });
  return {
    call,
    heard,
    refuse: (id: Heard["id"], method: string) =>
      id === undefined
        ? Effect.void
        : send({
            jsonrpc: "2.0",
            id,
            error: { code: -32_601, message: `Desktop's chat does not answer ${method}` },
          }),
    kill: () => child.kill(),
  };
});
type AppServer = Effect.Success<ReturnType<typeof appServer>>;

const decoded = <S extends Schema.Top>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (value: Schema.Json | undefined) =>
    decode(value).pipe(Effect.mapError((cause) => new CodexError({ message: String(cause) })));
};

const TextInput = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const isText = Schema.is(TextInput);
const Item = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  text: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.Array(Schema.String)),
  content: Schema.optionalKey(Schema.Array(Schema.Json)),
  server: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.NullOr(Schema.Struct({ content: Schema.Array(Schema.Json) }))),
  error: Schema.optionalKey(Schema.NullOr(Schema.Struct({ message: Schema.String }))),
  command: Schema.optionalKey(Schema.String),
  aggregatedOutput: Schema.optionalKey(Schema.NullOr(Schema.String)),
  changes: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
  query: Schema.optionalKey(Schema.String),
});
type Item = typeof Item.Type;
const decodeItem = Schema.decodeUnknownOption(Schema.Struct({ item: Item }));
const decodeDelta = Schema.decodeUnknownOption(
  Schema.Struct({ itemId: Schema.String, delta: Schema.String }),
);
const decodeTurn = Schema.decodeUnknownOption(
  Schema.Struct({
    turn: Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      error: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            message: Schema.String,
            codexErrorInfo: Schema.optionalKey(Schema.NullOr(Schema.Json)),
          }),
        ),
      ),
    }),
  }),
);
const decodeUsage = Schema.decodeUnknownOption(
  Schema.Struct({
    turnId: Schema.String,
    tokenUsage: Schema.Struct({
      last: Schema.Struct({
        inputTokens: Schema.Finite,
        cachedInputTokens: Schema.Finite,
        cacheWriteInputTokens: Schema.Finite,
        outputTokens: Schema.Finite,
      }),
    }),
  }),
);

type Tool = {
  readonly name: string;
  readonly args: Schema.Json;
  readonly output: string | undefined;
};

const toolOf = (item: Item) => {
  switch (item.type) {
    case "mcpToolCall": {
      const tool = item.tool ?? "";
      const name =
        item.server !== SERVER
          ? `mcp__${item.server}__${tool}`
          : tool === "AskUserQuestion"
            ? tool
            : `mcp__collie__${tool}`;
      const output =
        item.error?.message ??
        (item.result === undefined || item.result === null
          ? undefined
          : Arr.join(
              Arr.flatMap(item.result.content, (part) => (isText(part) ? [part.text] : [])),
              "\n",
            ));
      const called: Tool = { name, args: item.arguments ?? {}, output };
      return called;
    }
    case "commandExecution": {
      const tool: Tool = {
        name: "Bash",
        args: { command: item.command ?? "" },
        output: item.aggregatedOutput ?? undefined,
      };
      return tool;
    }
    case "fileChange": {
      const tool: Tool = {
        name: "Edit",
        args: { paths: Arr.map(item.changes ?? [], ({ path }) => path) },
        output: undefined,
      };
      return tool;
    }
    case "webSearch": {
      const tool: Tool = {
        name: "WebSearch",
        args: { query: item.query ?? "" },
        output: undefined,
      };
      return tool;
    }
    default:
      return undefined;
  }
};

const ZERO: TurnCost["usage"] = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const codexEvents = (thread: string) => {
  let turn = 0;
  let turnId: string | undefined;
  let usage = ZERO;
  let limited = false;
  const texts = new Set<string>();
  const reasons = new Set<string>();
  const tools = new Set<string>();
  const runId = () => `${thread}:${turn}`;
  const startTool: (item: Item) => Array<AguiEvent> = (item) => {
    const tool = toolOf(item);
    if (tool === undefined || tools.has(item.id)) {
      return [];
    }
    tools.add(item.id);
    return [
      {
        type: "TOOL_CALL_START",
        toolCallId: item.id,
        toolCallName: tool.name,
        parentMessageId: runId(),
      },
      { type: "TOOL_CALL_ARGS", toolCallId: item.id, delta: encodeLine(tool.args) },
      { type: "TOOL_CALL_END", toolCallId: item.id },
    ];
  };
  const step: (method: string, params: Schema.Json | undefined) => ReadonlyArray<AguiEvent> = (
    method,
    params,
  ) => {
    switch (method) {
      case "item/agentMessage/delta":
        return Option.match(decodeDelta(params), {
          onNone: () => [],
          onSome: ({ itemId, delta }) =>
            [
              ...(texts.has(itemId)
                ? []
                : (texts.add(itemId),
                  [
                    {
                      type: "TEXT_MESSAGE_START" as const,
                      messageId: itemId,
                      role: "assistant" as const,
                    },
                  ])),
              { type: "TEXT_MESSAGE_CONTENT", messageId: itemId, delta },
            ] satisfies Array<AguiEvent>,
        });
      case "item/reasoning/summaryTextDelta":
        return Option.match(decodeDelta(params), {
          onNone: () => [],
          onSome: ({ itemId, delta }) =>
            [
              ...(reasons.has(itemId)
                ? []
                : (reasons.add(itemId),
                  [
                    { type: "REASONING_START" as const, messageId: itemId },
                    {
                      type: "REASONING_MESSAGE_START" as const,
                      messageId: itemId,
                      role: "reasoning" as const,
                    },
                  ])),
              { type: "REASONING_MESSAGE_CONTENT", messageId: itemId, delta },
            ] satisfies Array<AguiEvent>,
        });
      case "item/started":
        return Option.match(decodeItem(params), {
          onNone: () => [],
          onSome: ({ item }) => startTool(item),
        });
      case "item/completed":
        return Option.match(decodeItem(params), {
          onNone: () => [],
          onSome: ({ item }) => {
            if (item.type === "agentMessage") {
              if (texts.has(item.id)) {
                return [{ type: "TEXT_MESSAGE_END", messageId: item.id }];
              }
              if (item.text === undefined || item.text === "") {
                return [];
              }
              return [
                { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" },
                { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: item.text },
                { type: "TEXT_MESSAGE_END", messageId: item.id },
              ];
            }
            if (item.type === "reasoning") {
              return reasons.has(item.id)
                ? [
                    { type: "REASONING_MESSAGE_END", messageId: item.id },
                    { type: "REASONING_END", messageId: item.id },
                  ]
                : [];
            }
            const tool = toolOf(item);
            if (tool === undefined) {
              return [];
            }
            return [
              ...startTool(item),
              {
                type: "TOOL_CALL_RESULT",
                toolCallId: item.id,
                messageId: `${item.id}:result`,
                content: tool.output ?? "",
                role: "tool",
              },
            ];
          },
        });
      case "turn/started":
        Option.map(decodeTurn(params), ({ turn }) => (turnId = turn.id));
        return [];
      case "thread/tokenUsage/updated":
        Option.map(decodeUsage(params), ({ turnId: of, tokenUsage: { last } }) => {
          if (of !== turnId) {
            return;
          }
          usage = {
            input_tokens: usage.input_tokens + last.inputTokens - last.cachedInputTokens,
            output_tokens: usage.output_tokens + last.outputTokens,
            cache_read_input_tokens: usage.cache_read_input_tokens + last.cachedInputTokens,
            cache_creation_input_tokens:
              usage.cache_creation_input_tokens + last.cacheWriteInputTokens,
          };
        });
        return [];
      case "turn/completed":
        return Option.match(decodeTurn(params), {
          onNone: () => [],
          onSome: ({ turn: ended }) => {
            if (turnId !== undefined && ended.id !== turnId) {
              return [];
            }
            const error = ended.status === "failed" ? ended.error : undefined;
            if (error === undefined || error === null) {
              return [{ type: "RUN_FINISHED", threadId: thread, runId: runId() }];
            }
            limited = error.codexErrorInfo === "usageLimitExceeded";
            return [
              {
                type: "RUN_ERROR",
                runId: runId(),
                message:
                  error.codexErrorInfo === "unauthorized"
                    ? `${error.message}: ${SIGN_IN}`
                    : error.message,
              },
            ];
          },
        });
      default:
        return [];
    }
  };
  return {
    begin: () => {
      turn++;
      turnId = undefined;
      usage = ZERO;
      limited = false;
      texts.clear();
      reasons.clear();
      tools.clear();
      return { type: "RUN_STARTED", threadId: thread, runId: runId() } satisfies AguiEvent;
    },
    started: (id: string) => {
      turnId = id;
    },
    turnId: () => turnId,
    step,
    usage: () => usage,
    limited: () => limited,
  };
};

const inputOf = (content: string | ReadonlyArray<ContentBlock>, note: string) => {
  const blocks = isString(content) ? [{ type: "text" as const, text: content }] : content;
  const text = (words: string) => ({ type: "text", text: words, text_elements: [] });
  const partOf: (block: ContentBlock) => ReadonlyArray<JsonObject> = (block) => {
    if (block.type === "text") {
      return [text(block.text)];
    }
    if (block.type === "image") {
      return [
        {
          type: "image",
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      ];
    }
    return [];
  };
  return [...Arr.flatMap(blocks, partOf), ...(note === "" ? [] : [text(`${NOTE}\n${note}`)])];
};

const entryOf: (item: Item) => ReadonlyArray<Schema.Json> = (item) => {
  const of = { uuid: item.id, parent_tool_use_id: null };
  switch (item.type) {
    case "userMessage":
      return [
        {
          ...of,
          type: "user",
          message: {
            content: Arr.flatMap(item.content ?? [], (part) =>
              isText(part) && !pipe_(part.text, Str.startsWith(NOTE))
                ? [{ type: "text", text: part.text }]
                : [],
            ),
          },
        },
      ];
    case "agentMessage":
      return [
        {
          ...of,
          type: "assistant",
          message: { content: [{ type: "text", text: item.text ?? "" }] },
        },
      ];
    case "reasoning":
      return item.summary === undefined || item.summary.length === 0
        ? []
        : [
            {
              ...of,
              type: "assistant",
              message: {
                content: [{ type: "thinking", thinking: Arr.join(item.summary, "\n") }],
              },
            },
          ];
    default: {
      const tool = toolOf(item);
      if (tool === undefined) {
        return [];
      }
      return [
        {
          ...of,
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: item.id, name: tool.name, input: tool.args }],
          },
        },
        {
          ...of,
          uuid: `${item.id}:result`,
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: item.id, content: tool.output ?? "" }],
          },
        },
      ];
    }
  }
};

const entriesOf = (items: ReadonlyArray<Item>) => Arr.flatMap(items, entryOf);

const Threads = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeThreadRef = decoded(Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }));
const decodeTurnStarted = decoded(Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) }));
const decodeAccount = decoded(
  Schema.Struct({ account: Schema.NullOr(Schema.Json), requiresOpenaiAuth: Schema.Boolean }),
);
const decodeItems = decoded(
  Schema.Struct({
    data: Schema.Array(Schema.Struct({ item: Item })),
    nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const decodeList = decoded(
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optionalKey(Schema.NullOr(Schema.String)),
        preview: Schema.optionalKey(Schema.String),
        updatedAt: Schema.Finite,
      }),
    ),
  }),
);
const decodeRead = decoded(
  Schema.Struct({
    thread: Schema.Struct({ path: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  }),
);
const decodeModels = decoded(CodexModelList);

// WARNING: Codex 0.170.0 refuses to resume a thread it has no rollout of.
const unknownThread = (cause: CodexError) =>
  cause.code === -32_600 && pipe_(cause.message, Str.startsWith("no rollout found"));

const reading = <A>(
  command: ReadonlyArray<string> | null,
  dir: string,
  read: (server: AppServer) => Effect.Effect<A, CodexError>,
) =>
  command === null
    ? Effect.fail(new CodexError({ message: NOT_INSTALLED }))
    : appServer(command, dir, [], childEnv()).pipe(Effect.flatMap(read), Effect.scoped);

export const readCodexModels: (
  dir: string,
  command?: ReadonlyArray<string> | null,
) => Effect.Effect<ReadonlyArray<ListedModel>, string> = (
  dir,
  command = which("codex") === null ? null : [which("codex")!],
) =>
  reading(command, dir, (server) =>
    server.call("model/list", { includeHidden: true }).pipe(Effect.flatMap(decodeModels)),
  ).pipe(
    Effect.mapError(({ message }) => message),
    Effect.flatMap((list) =>
      Effect.fromResult(
        listedIn([{ harness: "codex", at: "", table: null, entries: codexEntries(list) }], "codex"),
      ),
    ),
  );

type Live = {
  readonly scope: Scope.Closeable;
  readonly server: AppServer;
  readonly thread: string;
};

const decodeStatuses = decoded(Schema.Struct({ data: Schema.Array(CodexStatus) }));
const NO_STATUS: ReadonlyArray<CodexStatus> = [];
const Effective = Schema.Struct({
  config: Schema.optionalKey(
    Schema.Struct({
      mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
const decodeEffective = decoded(Effective);
const instructions = () => systemPrompt(hostname());

const noThreads: Readonly<Record<string, string>> = {};

export const codexDriver: (
  context: DriverContext,
  endpoint: ChatEndpoint,
  userServers: () => Promise<UserMcpServers>,
  command?: ReadonlyArray<string> | null,
) => ChatDriver = (
  context,
  endpoint,
  userServers,
  command = which("codex") === null ? null : [which("codex")!],
) => {
  const mapping = `${context.dir}/codex-threads.json`;
  const threads = Effect.promise(() =>
    context.run(
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(mapping)),
        Effect.flatMap(Schema.decodeUnknownEffect(Threads)),
        Effect.orElseSucceed(() => noThreads),
      ),
    ),
  );
  const remember = (id: string, thread: string) =>
    threads.pipe(
      Effect.flatMap((held) =>
        Effect.promise(() =>
          context.run(
            FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) =>
                fs.writeFileString(
                  mapping,
                  flow(Schema.encodeResult(Threads), Result.getOrThrow)({ ...held, [id]: thread }),
                ),
              ),
              Effect.orDie,
            ),
          ),
        ),
      ),
    );
  const threadOf = (id: string) => Effect.map(threads, (held) => held[id] ?? id);
  const read = <A>(use: (server: AppServer) => Effect.Effect<A, CodexError>) =>
    reading(command, context.dir, use);
  const setting = {
    cwd: context.dir,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
  return {
    installed: command !== null,
    open: Effect.fnUntraced(function* (id, model, effort) {
      const output = yield* Queue.unbounded<AguiEvent, string | Cause.Done>();
      const state = codexEvents(id);
      let started = 0;
      let lastTurn: TurnCost | undefined;
      const pump = (server: AppServer) =>
        Stream.fromQueue(server.heard).pipe(
          Stream.runForEach(({ id: asked, method, params }) =>
            Effect.gen(function* () {
              if (asked !== undefined) {
                return yield* server.refuse(asked, method);
              }
              if (method === "item/started") {
                const item = Option.getOrUndefined(decodeItem(params))?.item;
                if (
                  item?.type === "mcpToolCall" &&
                  item.server === SERVER &&
                  item.tool === "AskUserQuestion"
                ) {
                  yield* endpoint.question(
                    item.id,
                    Schema.is(Schema.Record(Schema.String, Schema.Json))(item.arguments)
                      ? item.arguments
                      : {},
                  );
                }
              }
              const events = state.step(method, params);
              if (Arr.some(events, ends)) {
                lastTurn = {
                  duration_ms: (yield* Clock.currentTimeMillis) - started,
                  usage: state.usage(),
                };
                yield* endpoint.finish;
              }
              yield* Queue.offerAll(output, events);
            }),
          ),
          Effect.catch(({ message }) => Queue.fail(output, message)),
        );
      let given: CodexServers = NO_SERVERS;
      let configured: ReadonlyArray<string> | null = null;
      let signingIn = false;
      let live: Live | undefined;
      let owned: Scope.Closeable | undefined;
      const statusesOf = (server: AppServer, thread?: string) =>
        server.call("mcpServerStatus/list", thread === undefined ? {} : { threadId: thread }).pipe(
          Effect.flatMap(decodeStatuses),
          Effect.map(({ data }) => data),
          Effect.orElseSucceed(() => NO_STATUS),
        );
      // WARNING: Codex's own resolution decides which names it already has; reading its files guesses.
      const readConfigured = () =>
        Effect.gen(function* () {
          if (command === null) {
            return Option.none<ReadonlyArray<string>>();
          }
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const probe = yield* appServer(command, context.dir, [], childEnv());
              const { config } = yield* probe
                .call("config/read", { cwd: context.dir })
                .pipe(Effect.flatMap(decodeEffective));
              const names: ReadonlyArray<string> = Arr.filter(
                Rec.keys(config?.mcp_servers ?? {}),
                (name) => name !== SERVER,
              );
              return Option.some(names);
            }),
          ).pipe(Effect.orElseSucceed(() => Option.none<ReadonlyArray<string>>()));
        });
      const ownServers = yield* Effect.cached(readConfigured());
      const connect = (own: Scope.Scope) =>
        Effect.gen(function* () {
          if (command === null) {
            return yield* new CodexError({ message: NOT_INSTALLED });
          }
          const { url, token } = yield* endpoint.start;
          configured = Option.getOrNull(yield* ownServers);
          given = codexServers(
            yield* Effect.tryPromise(userServers).pipe(Effect.orElseSucceed(() => ({}))),
            configured,
          );
          const server = yield* appServer(
            command,
            context.dir,
            [
              ...given.args,
              "-c",
              `mcp_servers.${SERVER}.url=${encodeLine(url)}`,
              "-c",
              `mcp_servers.${SERVER}.bearer_token_env_var=${encodeLine(TOKEN_ENV)}`,
              "-c",
              `mcp_servers.${SERVER}.tool_timeout_sec=${TOOL_TIMEOUT}`,
            ],
            { ...childEnv(), ...given.env, [TOKEN_ENV]: token },
          );
          yield* Effect.forkScoped(pump(server));
          const { account, requiresOpenaiAuth } = yield* server
            .call("account/read", {})
            .pipe(Effect.flatMap(decodeAccount));
          if (account === null && requiresOpenaiAuth) {
            return yield* new CodexError({ message: SIGNED_OUT });
          }
          const started = { ...setting, developerInstructions: instructions() };
          const resumed = yield* server
            .call("thread/resume", { threadId: yield* threadOf(id), ...started })
            .pipe(
              Effect.flatMap(decodeThreadRef),
              Effect.asSome,
              Effect.catchIf(unknownThread, () => Effect.succeedNone),
            );
          const thread = Option.isSome(resumed)
            ? resumed.value.thread.id
            : (yield* server.call("thread/start", started).pipe(Effect.flatMap(decodeThreadRef)))
                .thread.id;
          if (Option.isNone(resumed)) {
            yield* remember(id, thread);
          }
          // WARNING: a trusted project's servers arrive only from the thread-scoped call.
          const scoped = yield* statusesOf(server, thread);
          signingIn = Arr.some(scoped, (one) => one.authStatus === "notLoggedIn");
          return { server, thread };
        }).pipe(Scope.provide(own));
      const establish = () =>
        Effect.gen(function* () {
          const own = yield* Scope.make();
          owned = own;
          const built = yield* connect(own).pipe(
            Effect.onError(() => Scope.close(own, Exit.void).pipe(Effect.ignore)),
          );
          const made: Live = { scope: own, ...built };
          live = made;
          return made;
        });
      let first = yield* Deferred.make<Live, CodexError>();
      let failed = false;
      const connectOnce = () =>
        establish().pipe(
          Effect.tap((made) => Deferred.succeed(first, made)),
          Effect.tapError((error) =>
            Effect.sync(() => {
              failed = true;
            }).pipe(Effect.andThen(Deferred.fail(first, error))),
          ),
        );
      yield* connectOnce().pipe(
        Effect.catch(({ message }) => Queue.fail(output, message)),
        Effect.forkScoped,
      );
      const settle = Effect.gen(function* () {
        if (live !== undefined) {
          if (!signingIn) {
            return live;
          }
          const stale = live;
          live = undefined;
          signingIn = false;
          yield* Scope.close(stale.scope, Exit.void).pipe(Effect.ignore);
          first = yield* Deferred.make<Live, CodexError>();
          return yield* connectOnce();
        }
        if (!failed) {
          return Option.getOrUndefined(yield* Deferred.await(first).pipe(Effect.option));
        }
        failed = false;
        first = yield* Deferred.make<Live, CodexError>();
        return Option.getOrUndefined(yield* connectOnce().pipe(Effect.option));
      });
      const note = () => {
        const placement = context.placement();
        const noticed = context.noticed();
        return Arr.join(
          Arr.filter(
            [
              placement === undefined ? "" : placementContext(placement),
              standingDirectionContext(context.flock.standingDirection()) ?? "",
              noticed === undefined ? "" : noticedContext(noticed),
            ],
            (text) => text !== "",
          ),
          "\n\n",
        );
      };
      return {
        conversation: () => id,
        offer: (content) =>
          Effect.gen(function* () {
            yield* endpoint.begin;
            started = yield* Clock.currentTimeMillis;
            yield* Queue.offer(output, state.begin());
            const settled = yield* settle.pipe(Effect.result);
            const current = Result.isSuccess(settled) ? settled.success : undefined;
            if (current === undefined) {
              return yield* Queue.offer(output, {
                type: "RUN_ERROR",
                runId: id,
                message: Result.isFailure(settled)
                  ? settled.failure.message
                  : "Codex could not start its session",
              });
            }
            live = current;
            const said = codexConnections(
              given,
              yield* statusesOf(current.server, current.thread),
              configured ?? [],
            );
            const noted = Arr.filter([note(), said], (text) => text !== "");
            const asked = yield* current.server
              .call("turn/start", {
                threadId: current.thread,
                input: inputOf(content, Arr.join(noted, "\n\n")),
                ...(model !== "default" && { model }),
                ...(effort !== null && { effort }),
              })
              .pipe(Effect.flatMap(decodeTurnStarted), Effect.result);
            if (Result.isSuccess(asked)) {
              state.started(asked.success.turn.id);
            } else {
              yield* Queue.offer(output, {
                type: "RUN_ERROR",
                runId: id,
                message: asked.failure.message,
              });
            }
          }),
        events: Stream.fromQueue(output),
        interrupt: Effect.gen(function* () {
          const turnId = state.turnId();
          if (live === undefined || turnId === undefined) {
            return;
          }
          yield* live.server
            .call("turn/interrupt", { threadId: live.thread, turnId })
            .pipe(Effect.ignore);
        }).pipe(Effect.andThen(endpoint.finish)),
        close: Effect.sync(() => {
          const ending = owned;
          live = undefined;
          owned = undefined;
          return ending === undefined ? Effect.void : Scope.close(ending, Exit.void);
        }).pipe(Effect.flatten, Effect.andThen(endpoint.finish)),
        lastTurn: () => lastTurn,
        limited: state.limited,
      };
    }),
    transcript: (id) =>
      read((server) =>
        Effect.gen(function* () {
          const threadId = yield* threadOf(id);
          const items: Array<Item> = [];
          let cursor: string | null = null;
          do {
            const page: Effect.Success<ReturnType<typeof decodeItems>> = yield* server
              .call("thread/items/list", { threadId, cursor, limit: 200 })
              .pipe(Effect.flatMap(decodeItems));
            items.push(...Arr.map(page.data, ({ item }) => item));
            cursor = page.nextCursor ?? null;
          } while (cursor !== null);
          return transcriptOf(entriesOf(items));
        }),
      ).pipe(Effect.orElseSucceed(() => [])),
    earlier: (limit) =>
      Effect.gen(function* () {
        const held = yield* threads;
        const desktop = Rec.fromEntries(
          Arr.map(Rec.toEntries(held), ([id, thread]) => [thread, id]),
        );
        const { data } = yield* read((server) =>
          server
            .call("thread/list", { cwd: context.dir, limit, sortKey: "updated_at" })
            .pipe(Effect.flatMap(decodeList)),
        );
        return Arr.map(data, (thread) => ({
          session: desktop[thread.id] ?? thread.id,
          title: thread.name ?? (thread.preview || "Conversation"),
          at: thread.updatedAt * 1000,
        }));
      }).pipe(Effect.orElseSucceed(() => [])),
    transcriptPath: (id) =>
      threadOf(id).pipe(
        Effect.flatMap((threadId) =>
          read((server) =>
            server.call("thread/read", { threadId }).pipe(Effect.flatMap(decodeRead)),
          ),
        ),
        Effect.map(({ thread }) => thread.path ?? null),
        Effect.orElseSucceed(() => null),
      ),
  };
};
