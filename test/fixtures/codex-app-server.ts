/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- a stand-in process, outside Effect as Codex is. */

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { Schema, flow, Result } from "effect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { homedir } from "node:os";
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

const asJson = flow(Schema.decodeUnknownResult(Schema.Json), Result.getOrThrow);

const ServerSchema = Schema.Record(Schema.String, Schema.Json);
type Server = Record<string, Schema.Json>;
const OwnConfig = Schema.Struct({
  mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, ServerSchema)),
  projects: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ trust_level: Schema.optionalKey(Schema.String) })),
  ),
  shell_environment_policy: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
const codexHome = childEnv().CODEX_HOME ?? `${homedir()}/.codex`;
const emptyConfig: typeof OwnConfig.Type = { mcp_servers: {}, projects: {} };
const configAt = async (path: string) =>
  (await Bun.file(path).exists())
    ? Option.getOrElse(
        Schema.decodeOption(OwnConfig)(Bun.TOML.parse(await Bun.file(path).text())),
        () => emptyConfig,
      )
    : emptyConfig;
const own = await configAt(`${codexHome}/config.toml`);
const trusted = own.projects?.[process.cwd()]?.trust_level === "trusted";
const fromProject = trusted ? await configAt(`${process.cwd()}/.codex/config.toml`) : undefined;
const project = { mcp_servers: fromProject?.mcp_servers ?? {} };

const tableOf: (value: Schema.Json | undefined) => Server = (value) =>
  Schema.is(ServerSchema)(value) ? value : {};

const put = (into: Server, path: ReadonlyArray<string>, value: Schema.Json) => {
  let held = into;
  for (const key of Arr.dropRight(path, 1)) {
    const next = tableOf(held[key]);
    held[key] = next;
    held = next;
  }
  held[path.at(-1) ?? ""] = value;
};

// WARNING: Codex's `-c` overrides layer over the config.toml its own servers come from.
const servers = () => {
  const merged: Record<string, Server> = {};
  const configured = { ...own.mcp_servers, ...project.mcp_servers };
  for (const [name, cfg] of Rec.toEntries(configured)) {
    merged[name] = { ...cfg };
  }
  for (const [at, arg] of Bun.argv.entries()) {
    if (Bun.argv[at - 1] !== "-c") {
      continue;
    }
    const [key, ...held] = Str.split(arg, "=");
    const [head, name, field, ...rest] = Str.split(key, ".");
    if (head !== "mcp_servers" || name === undefined || field === undefined) {
      continue;
    }
    put((merged[name] ??= {}), [field, ...rest], tomlValue(Arr.join(held, "=")));
  }
  return merged;
};
const server = "collie_desktop";

const ownServers: () => Promise<Server> = async () =>
  Option.getOrElse(
    Schema.decodeUnknownOption(ServerSchema)(
      await Bun.file(`${codexHome}/own-servers.json`)
        .json()
        .catch(() => ({})),
    ),
    () => ({}),
  );

if (await Bun.file(`${process.cwd()}/restart-fails`).exists()) {
  process.stderr.write("codex: the stand-in refused to start again\n");
  process.exit(1);
}

const starts = `${process.cwd()}/app-server-starts.jsonl`;
const record = async (line: JsonObject) => {
  const held = (await Bun.file(starts).exists()) ? await Bun.file(starts).text() : "";
  await Bun.write(starts, `${held}${JSON.stringify(line)}\n`);
};
await record({ pid: process.pid, chat: Bun.argv.length > 3 });

const tomlValue: (raw: string) => Schema.Json = (raw) =>
  flow(
    Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json)),
    Result.getOrThrow,
  )(Bun.TOML.parse(`value = ${raw}`)).value ?? "";

const logins: () => Promise<Readonly<Record<string, string>>> = async () =>
  Option.getOrElse(
    Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String))(
      await Bun.file(`${codexHome}/mcp-logins.json`)
        .json()
        .catch(() => ({})),
    ),
    () => ({}),
  );

const headersOf = (cfg: Server) => {
  const headers: Record<string, string> = {};
  const literal = cfg.http_headers;
  if (Schema.is(Schema.Record(Schema.String, Schema.String))(literal)) {
    Object.assign(headers, literal);
  }
  const fromEnv = cfg.env_http_headers;
  if (Schema.is(Schema.Record(Schema.String, Schema.String))(fromEnv)) {
    const named: Readonly<Record<string, string>> = fromEnv;
    for (const header of Rec.keys(named)) {
      const value = childEnv()[named[header] ?? ""];
      if (value !== undefined) {
        headers[header] = value;
      }
    }
  }
  if (Str.isString(cfg.bearer_token_env_var)) {
    const token = childEnv()[cfg.bearer_token_env_var];
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
};

const forwarded = (cfg: Server) => {
  const env: Record<string, string> = {};
  const held = Arr.isArray(cfg.env_vars) ? cfg.env_vars : [];
  for (const one of held) {
    const variable = Str.isString(one)
      ? one
      : Schema.is(Schema.Struct({ name: Schema.String }))(one)
        ? one.name
        : undefined;
    const value = variable === undefined ? undefined : childEnv()[variable];
    if (variable !== undefined && value !== undefined) {
      env[variable] = value;
    }
  }
  return env;
};

const DEFAULT_EXCLUDES = ["*KEY*", "*TOKEN*", "*SECRET*", "*PASSWORD*"];
const CORE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "PWD"];
const Filter = Schema.Literals(["include", "exclude"]);
const ShellPolicy = Schema.Struct({
  inherit: Schema.optionalKey(Schema.String),
  ignore_default_excludes: Schema.optionalKey(Schema.Boolean),
  exclude: Schema.optionalKey(Schema.Array(Schema.String)),
  include_only: Schema.optionalKey(Schema.Array(Schema.String)),
  filters: Schema.optionalKey(Schema.Record(Schema.String, Filter)),
});
const wildcard = (glob: string, key: string) =>
  new RegExp(
    `^${pipe(glob, Str.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`), Str.replaceAll("*", ".*"))}$`,
  ).test(key);

const shellPolicy = () => {
  const merged = { ...own.shell_environment_policy };
  let legacy = false;
  let keyed = false;
  for (const [at, arg] of Bun.argv.entries()) {
    if (Bun.argv[at - 1] !== "-c") {
      continue;
    }
    const [key, ...held] = Str.split(arg, "=");
    if (!pipe(key, Str.startsWith("shell_environment_policy."))) {
      continue;
    }
    const name = Str.split(key, ".")[1] ?? "";
    merged[name] = tomlValue(Arr.join(held, "="));
    legacy = legacy || name === "exclude" || name === "include_only";
    keyed = keyed || name === "filters";
  }
  // WARNING: Codex drops a keyed `filters` table when a legacy name is set beside it.
  if (legacy && !keyed) {
    delete merged.filters;
  }
  const held: typeof ShellPolicy.Type = Option.getOrElse(
    Schema.decodeOption(ShellPolicy)(merged),
    () => ({}),
  );
  return held;
};

const reportedPolicy = () => {
  const policy = shellPolicy();
  return {
    inherit: policy.inherit ?? null,
    ignore_default_excludes: policy.ignore_default_excludes ?? null,
    exclude: policy.exclude ?? null,
    set: null,
    include_only: policy.include_only ?? null,
    filters: policy.filters ?? null,
    experimental_use_profile: null,
  };
};

const shellEnv = () => {
  const policy = shellPolicy();
  const inherit = policy.inherit ?? "all";
  const excluded = [
    ...(policy.ignore_default_excludes === true ? [] : DEFAULT_EXCLUDES),
    ...(policy.exclude ?? []),
  ];
  const filtered = Rec.toEntries(policy.filters ?? {});
  return Rec.filter(
    Rec.getSomes(Rec.map(childEnv(), (value) => Option.fromUndefinedOr(value))),
    (_value, key) => {
      if (Arr.some(excluded, (glob) => wildcard(glob, key))) {
        return false;
      }
      const keyed = Arr.findFirst(filtered, ([glob]) => wildcard(glob, key));
      if (Option.isSome(keyed)) {
        return keyed.value[1] === "include";
      }
      return policy.include_only === undefined
        ? inherit === "all" || (inherit === "core" && Arr.contains(CORE, key))
        : Arr.some(policy.include_only, (glob) => wildcard(glob, key));
    },
  );
};

const openConnection = async (name: string) => {
  const cfg = servers()[name] ?? {};
  const client = new Client({ name: "codex-stand-in", version: "1" });
  if (Str.isString(cfg.url)) {
    const headers = headersOf(cfg);
    const held = (await logins())[name];
    if (headers.Authorization === undefined && held !== undefined) {
      headers.Authorization = `Bearer ${held}`;
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } }),
    );
    return client;
  }
  if (!Str.isString(cfg.command)) {
    return undefined;
  }
  await client.connect(
    new StdioClientTransport({
      command: cfg.command,
      args: Arr.filter(Arr.isArray(cfg.args) ? cfg.args : [], Str.isString),
      env: { PATH: childEnv().PATH ?? "", ...forwarded(cfg) },
      cwd: process.cwd(),
      stderr: "ignore",
    }),
  );
  return client;
};

// WARNING: Codex connects a server once for the thread it has loaded, so a later login is not picked up.
const connections = new Map<string, Promise<Client | undefined>>();
const connect = (name: string) => {
  const held = connections.get(name);
  if (held !== undefined) {
    return held;
  }
  const made = openConnection(name);
  connections.set(name, made);
  return made;
};

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
  params: JsonObject;
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
const resumedHere = new Set<string>();
let running: { turn: Turn; release: () => void } | undefined;
const answers = new Map<string | number, (result: Schema.Json) => void>();
const ask = (method: string, params: JsonObject) =>
  new Promise<Schema.Json>((resolve) => {
    const id = `server-${answers.size + 1}`;
    answers.set(id, resolve);
    send({ id, method, params });
  });

const item = (turn: Turn, one: JsonObject, live = true) => {
  if (live) {
    notify("item/started", { threadId: loaded!.id, turnId: turn.id, item: one });
  }
  turn.items.push(one);
};
const completed = (turn: Turn, one: JsonObject) => {
  notify("item/completed", { threadId: loaded!.id, turnId: turn.id, item: one });
  const at = Arr.findFirstIndex(turn.items, (held) => held.id === one.id);
  if (at._tag === "Some") {
    turn.items[at.value] = one;
  } else {
    turn.items.push(one);
  }
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
        env: Rec.getSomes(Rec.map(childEnv(), (value) => Option.fromUndefinedOr(value))),
        thread: loaded!.id,
        pid: process.pid,
        start: loaded!.params,
        turn: params,
      }),
    );
    return finish(turn, "completed");
  }
  if (pipe(said, Str.startsWith("shell"))) {
    reply(
      `${turn.id}-shell`,
      Arr.join(
        Arr.map(Rec.toEntries(shellEnv()), ([key, value]) => `${key}=${value}`),
        "\n",
      ),
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
    const url = servers()[server]?.url;
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
  if (pipe(said, Str.startsWith("servers"))) {
    for (const name of Rec.keys(servers())) {
      if (name === server) {
        continue;
      }
      const client = await connect(name).catch(() => undefined);
      if (client === undefined) {
        continue;
      }
      const first = (await client.listTools()).tools[0];
      if (first !== undefined) {
        const call = {
          type: "mcpToolCall",
          id: `${turn.id}-${name}-mcp`,
          server: name,
          tool: first.name,
          status: "inProgress",
          arguments: {},
          result: null,
          error: null,
        };
        item(turn, call);
        const result = await client.callTool({ name: first.name, arguments: {} });
        completed(turn, {
          ...call,
          status: "completed",
          result: {
            content: asJson(result.content),
            structuredContent: null,
            _meta: null,
          },
        });
      }
      await client.close();
    }
    return finish(turn, "completed");
  }
  if (pipe(said, Str.startsWith("wait"))) {
    await new Promise<void>((release) => {
      running = { turn, release };
    });
    return finish(turn, "interrupted");
  }
  if (pipe(said, Str.startsWith("limit"))) {
    return finish(turn, "failed", {
      message: "You've hit your usage limit.",
      codexErrorInfo: "usageLimitExceeded",
    });
  }
  if (pipe(said, Str.startsWith("signed-out"))) {
    return finish(turn, "failed", { message: "Unauthorized", codexErrorInfo: "unauthorized" });
  }
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
  for (const delta of ["Hel", "lo"]) {
    notify("item/agentMessage/delta", {
      threadId: loaded!.id,
      turnId: turn.id,
      itemId: `${turn.id}-text`,
      delta,
    });
  }
  completed(turn, { type: "agentMessage", id: `${turn.id}-text`, text: "Hello" });
  // WARNING: A request the chat does not answer must be refused, not left waiting.
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
              code: -32_600,
              message: `no rollout found for thread id ${Str.isString(params.threadId) ? params.threadId : ""}`,
            },
          });
          break;
        }
        if (resumedHere.has(known.id)) {
          loaded = known;
          answer({ thread: { id: known.id } });
          break;
        }
        resumedHere.add(known.id);
        known.params = { ...known.params, ...params };
        loaded = known;
        await save();
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
        if (thread === undefined) {
          send({ id: message.id!, error: { code: -32_600, message: "no such thread" } });
        } else {
          answer({ thread: { id: thread.id, path: `${process.cwd()}/${thread.id}.jsonl` } });
        }
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
      case "config/read": {
        if (await Bun.file(`${process.cwd()}/config-unreadable`).exists()) {
          send({ id: message.id!, error: { code: -32_603, message: "config/read failed" } });
          break;
        }
        answer({
          config: {
            mcp_servers: { ...servers(), ...(await ownServers()) },
            shell_environment_policy: reportedPolicy(),
          },
        });
        break;
      }
      case "mcpServerStatus/list": {
        const data = [];
        const scoped = Str.isString(params.threadId);
        const overridden = new Set<string>();
        for (const [at, arg] of Bun.argv.entries()) {
          if (Bun.argv[at - 1] !== "-c") {
            continue;
          }
          const key = Str.split(arg, "=")[0] ?? "";
          if (pipe(key, Str.startsWith("mcp_servers."))) {
            overridden.add(Str.split(key, ".")[1] ?? "");
          }
        }
        for (const [name, cfg] of Rec.toEntries(servers())) {
          if (!scoped && project.mcp_servers[name] !== undefined && !overridden.has(name)) {
            continue;
          }
          const credential = Rec.keys(headersOf(cfg)).length > 0;
          let tools: Record<string, Schema.Json> = {};
          let authStatus = "unsupported";
          let toolsError: string | null = null;
          try {
            const client = await connect(name);
            if (client !== undefined) {
              tools = Rec.fromEntries(
                Arr.map((await client.listTools()).tools, (tool) => [tool.name, asJson(tool)]),
              );
              authStatus = credential
                ? "bearerToken"
                : (await logins())[name] === undefined
                  ? "unsupported"
                  : "oAuth";
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // WARNING: 401 to a server holding no credential is Codex's sign-in to do, not a failure.
            if (!credential && /401|Unauthorized/.test(message)) {
              authStatus = "notLoggedIn";
              toolsError = `auth required: ${message}`;
            } else {
              authStatus = credential ? "bearerToken" : "unsupported";
              toolsError = message;
            }
          }
          data.push({ name, tools, authStatus, toolsError });
        }
        answer({ data, nextCursor: null });
        if (scoped) {
          await record({ pid: process.pid, scoped: true });
        }
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
        if (message.id !== undefined) {
          answer({});
        }
    }
  }
}
