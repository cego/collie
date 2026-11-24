import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { homedir } from "node:os";
import { Option, Schema } from "effect";
import { stringifyJson } from "../../../src/json";
import { childEnv } from "./login-env";
import type { UserMcpServers } from "./session";

const RESERVED = "collie_desktop";
const NAME = /^[A-Za-z0-9_-]+$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const Strings = Schema.Record(Schema.String, Schema.String);
const Stdio = Schema.Struct({
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Strings),
});
const Http = Schema.Struct({
  type: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optionalKey(Strings),
});

const CodexConfig = Schema.Struct({
  mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeConfig = Schema.decodeUnknownOption(CodexConfig);
const NO_CONFIG: typeof CodexConfig.Type = { mcp_servers: {} };

export const CodexStatus = Schema.Struct({
  name: Schema.String,
  tools: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  authStatus: Schema.optionalKey(Schema.String),
  toolsError: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CodexStatus = typeof CodexStatus.Type;

export interface CodexServers {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly given: ReadonlyArray<string>;
  readonly left: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}

const NONE: CodexServers = { args: [], env: {}, given: [], left: [] };

// WARNING: Codex reads a `-c` value as TOML; JSON is TOML enough for a string, an array and a table entry.
const override = (key: string, value: Schema.Json) => ["-c", `${key}=${stringifyJson(value)}`];

const headerEnv = (server: string, header: string) => `COLLIE_CHAT_MCP_${server}_${header}`;

const referenced: (value: string, env: Readonly<Record<string, string | undefined>>) => string = (
  value,
  env,
) =>
  Arr.reduce(Arr.fromIterable(pipe(value, Str.matchAll(REFERENCE))), value, (so, match) => {
    const whole = match[0] ?? "";
    const reference = match[1] ?? "";
    return pipe(so, Str.replace(whole, env[reference] ?? whole));
  });

export const codexServers: (
  servers: UserMcpServers,
  configured: ReadonlyArray<string>,
) => CodexServers = (servers, configured) =>
  Arr.reduce(Rec.toEntries(servers), NONE, (so, [name, server]) => {
    const leave = (why: string) => ({ ...so, left: [...so.left, { name, why }] });
    if (name === RESERVED) {
      return leave("the name of Collie's own server");
    }
    if (!NAME.test(name)) {
      return leave("Codex takes only letters, digits, _ and - in a server's name");
    }
    if (configured.includes(name)) {
      return so;
    }
    if ("headersHelper" in server) {
      return leave("its headersHelper runs only in Claude Code");
    }
    if (Schema.is(Stdio)(server)) {
      const { command, args, env } = server;
      return {
        ...so,
        args: [
          ...so.args,
          ...override(`mcp_servers.${name}.command`, command),
          ...(args === undefined ? [] : override(`mcp_servers.${name}.args`, args)),
          ...Arr.flatMap(Rec.toEntries(env ?? {}), ([key, value]) =>
            override(`mcp_servers.${name}.env.${key}`, value),
          ),
        ],
        given: [...so.given, name],
      };
    }
    if (!Schema.is(Http)(server)) {
      return leave("Codex does not speak SSE");
    }
    const carried: Record<string, string> = {};
    return {
      ...so,
      args: [
        ...so.args,
        ...override(`mcp_servers.${name}.url`, server.url),
        ...Arr.flatMap(Rec.toEntries(server.headers ?? {}), ([header, given]) => {
          const key = headerEnv(name, header);
          carried[key] = referenced(given, childEnv());
          return override(`mcp_servers.${name}.env_http_headers.${header}`, key);
        }),
      ],
      env: { ...so.env, ...carried },
      given: [...so.given, name],
    };
  });

export const codexConfigured: () => Promise<ReadonlyArray<string>> = () =>
  Bun.file(`${childEnv().CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`)
    .text()
    .then((text) => Option.getOrElse(decodeConfig(Bun.TOML.parse(text)), () => NO_CONFIG))
    .then((config) => Rec.keys(config.mcp_servers ?? {}))
    .catch(() => []);

export const codexConnections: (
  servers: CodexServers,
  statuses: ReadonlyArray<CodexStatus>,
) => string = (servers, statuses) => {
  const reported: Record<string, CodexStatus> = {};
  for (const one of statuses) {
    if (one.name !== RESERVED) {
      reported[one.name] = one;
    }
  }
  const names = Arr.dedupe([...servers.given, ...Rec.keys(reported)]);
  const described = Arr.map(names, (name) => {
    const tools = Rec.keys(reported[name]?.tools ?? {});
    return `${name} (${tools.length === 0 ? "no tools" : Arr.join(tools, ", ")})`;
  });
  const signIn = Arr.filter(names, (name) => {
    const status = reported[name];
    return status?.authStatus === "notLoggedIn" && status.toolsError == null;
  });
  const unconnected = Arr.filter(names, (name) => {
    const status = reported[name];
    return status === undefined || (status.toolsError !== undefined && status.toolsError !== null);
  });
  return Arr.join(
    [
      names.length === 0
        ? "Codex reports no MCP server of the human's: neither one added to Claude Code nor any of its own."
        : `Of the MCP servers the human added to Claude Code and of Codex's own, this chat has ${Arr.join(
            described,
            ", ",
          )}.`,
      ...(signIn.length === 0
        ? []
        : [
            `${Arr.join(signIn, ", ")} ${
              signIn.length === 1 ? "is" : "are"
            } not signed in to Codex: tell the human to run ${Arr.join(
              Arr.map(signIn, (name) => `codex mcp login ${name}`),
              ", ",
            )} in a terminal, then send their message again, rather than start a Run to do what the tool would.`,
          ]),
      ...(unconnected.length === 0
        ? []
        : [
            `Codex did not connect ${Arr.join(
              unconnected,
              ", ",
            )}: \`codex mcp list\` in a terminal shows why.`,
          ]),
      ...(servers.left.length === 0
        ? []
        : [
            `Left out: ${Arr.join(
              Arr.map(servers.left, ({ name, why }) => `${name} (${why})`),
              ", ",
            )}.`,
          ]),
    ],
    " ",
  );
};
