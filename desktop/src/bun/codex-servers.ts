import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { homedir } from "node:os";
import { Option, Schema } from "effect";
import { childEnv } from "./login-env";
import type { UserMcpServers } from "./session";

const RESERVED = "collie_desktop";
const OWN = "COLLIE_CHAT_";
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
  projects: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ trust_level: Schema.optionalKey(Schema.String) })),
  ),
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
  readonly given: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
  readonly left: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}

export const NO_SERVERS: CodexServers = { args: [], env: {}, given: [], left: [] };

// WARNING: Codex reads a `-c` value as TOML: a table's keys are quoted so a dot stays a header's name.
const quoted = (value: string) => JSON.stringify(value);
const setting = (key: string, value: string) => ["-c", `${key}=${quoted(value)}`];
const list = (key: string, values: ReadonlyArray<string>) => [
  "-c",
  `${key}=[${Arr.join(Arr.map(values, quoted), ", ")}]`,
];
const table = (key: string, values: Readonly<Record<string, string>>) => {
  const entries = Rec.toEntries(values);
  return entries.length === 0
    ? []
    : [
        "-c",
        `${key}={ ${Arr.join(
          Arr.map(entries, ([name, value]) => `${quoted(name)} = ${quoted(value)}`),
          ", ",
        )} }`,
      ];
};

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
) => CodexServers = (servers, configured) => {
  const args: Array<string> = [];
  const env: Record<string, string> = {};
  const given: Array<{ name: string; url?: string }> = [];
  const left: Array<{ name: string; why: string }> = [];
  const claimed: Record<string, { name: string; value: string }> = {};
  let carried = 0;
  for (const [name, server] of Rec.toEntries(servers)) {
    if (name === RESERVED) {
      left.push({ name, why: "the name of Collie's own server" });
      continue;
    }
    if (!NAME.test(name)) {
      left.push({ name, why: "Codex takes only letters, digits, _ and - in a server's name" });
      continue;
    }
    if (configured.includes(name)) {
      continue;
    }
    if ("headersHelper" in server) {
      left.push({ name, why: "its headersHelper runs only in Claude Code" });
      continue;
    }
    if (Schema.is(Stdio)(server)) {
      const variables: Array<string> = [];
      let why: string | undefined;
      for (const [key, value] of Rec.toEntries(server.env ?? {})) {
        const held = claimed[key];
        const resolved = referenced(value, childEnv());
        if (pipe(key, Str.startsWith(OWN))) {
          why = `${key} is in Collie's own namespace`;
          break;
        }
        if (held !== undefined && held.value !== resolved) {
          why = `it needs a different ${key} than ${held.name}, and Codex gives every server one variable of that name`;
          break;
        }
      }
      if (why !== undefined) {
        left.push({ name, why });
        continue;
      }
      for (const [key, value] of Rec.toEntries(server.env ?? {})) {
        const resolved = referenced(value, childEnv());
        env[key] = resolved;
        claimed[key] = { name, value: resolved };
        variables.push(key);
      }
      args.push(...setting(`mcp_servers.${name}.command`, server.command));
      if (server.args !== undefined) {
        args.push(...list(`mcp_servers.${name}.args`, server.args));
      }
      args.push(...list(`mcp_servers.${name}.env_vars`, variables));
      given.push({ name });
      continue;
    }
    if (!Schema.is(Http)(server)) {
      left.push({ name, why: "Codex does not speak SSE" });
      continue;
    }
    args.push(...setting(`mcp_servers.${name}.url`, server.url));
    const headers: Record<string, string> = {};
    for (const [header, value] of Rec.toEntries(server.headers ?? {})) {
      carried += 1;
      const variable = `${OWN}SERVER_${carried}`;
      env[variable] = referenced(value, childEnv());
      headers[header] = variable;
    }
    args.push(...table(`mcp_servers.${name}.env_http_headers`, headers));
    given.push({ name, url: server.url });
  }
  return { args, env, given, left };
};

const readConfig = (path: string) =>
  Bun.file(path)
    .text()
    .then((text) => Option.getOrElse(decodeConfig(Bun.TOML.parse(text)), () => NO_CONFIG))
    .catch(() => NO_CONFIG);

const namesIn = (path: string) =>
  readConfig(path).then((config) => Rec.keys(config.mcp_servers ?? {}));

const parentOf = (path: string) =>
  pipe(
    path,
    Str.slice(
      0,
      Option.getOrElse(pipe(path, Str.lastIndexOf("/")), () => 0),
    ),
  );

// WARNING: Codex ignores a project's .codex/config.toml unless that project is trusted.
const configPaths = (dir: string, projects: Readonly<Record<string, { trust_level?: string }>>) => {
  const home = homedir();
  const paths: Array<string> = [];
  for (let at = dir; at.length > 1; at = parentOf(at)) {
    if (projects[at]?.trust_level === "trusted") {
      paths.push(`${at}/.codex/config.toml`);
    }
    if (at === home) {
      break;
    }
  }
  return paths;
};

const config = () => `${childEnv().CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`;

export const codexConfigured: (dir: string) => Promise<ReadonlyArray<string>> = (dir) =>
  readConfig(config()).then((user) =>
    Promise.all(Arr.map(configPaths(dir, user.projects ?? {}), namesIn)).then((found) =>
      Arr.dedupe([...Rec.keys(user.mcp_servers ?? {}), ...Arr.flatten(found)]),
    ),
  );

const toolsOf = (status: CodexStatus | undefined) => Rec.keys(status?.tools ?? {});

const shQuote = (word: string) => `'${pipe(word, Str.replaceAll("'", String.raw`'\''`))}'`;

export const codexConnections: (
  servers: CodexServers,
  statuses: ReadonlyArray<CodexStatus>,
  configured: ReadonlyArray<string>,
) => string = (servers, statuses, configured) => {
  const reported: Record<string, CodexStatus> = {};
  for (const one of statuses) {
    if (one.name !== RESERVED) {
      reported[one.name] = one;
    }
  }
  const urls: Record<string, string> = {};
  for (const one of servers.given) {
    if (one.url !== undefined) {
      urls[one.name] = one.url;
    }
  }
  const imported = Arr.map(servers.given, (one) => one.name);
  const own = Arr.filter(configured, (name) => !imported.includes(name));
  const names = Arr.dedupe([...imported, ...own, ...Rec.keys(reported)]);
  const signingIn = Arr.filter(names, (name) => reported[name]?.authStatus === "notLoggedIn");
  const failed = Arr.filter(
    imported,
    (name) => reported[name] === undefined || (reported[name]?.toolsError ?? null) !== null,
  );
  const broken = Arr.filter(own, (name) => (reported[name]?.toolsError ?? null) !== null);
  const described = Arr.map(names, (name) => {
    const one = reported[name];
    if (one === undefined) {
      return name;
    }
    const tools = toolsOf(one);
    return `${name} (${tools.length === 0 ? "no tools" : Arr.join(tools, ", ")})`;
  });
  const login = (name: string) => {
    const url = urls[name];
    return `codex mcp login ${shQuote(name)}${
      url === undefined ? "" : ` -c ${shQuote(`mcp_servers.${name}.url=${quoted(url)}`)}`
    }`;
  };
  return Arr.join(
    Arr.filter(
      [
        names.length === 0
          ? "Codex reports no MCP server of the human's: neither one added to Claude Code nor any of its own."
          : `Of the MCP servers the human added to Claude Code and of Codex's own, this chat has ${Arr.join(
              described,
              ", ",
            )}.`,
        signingIn.length === 0
          ? ""
          : `${Arr.join(signingIn, ", ")} ${
              signingIn.length === 1 ? "is" : "are"
            } not signed in to Codex: tell the human to run ${Arr.join(
              Arr.map(signingIn, login),
              ", ",
            )} in a terminal, then send their message again, rather than start a Run to do what the tool would.`,
        failed.length === 0
          ? ""
          : `Codex did not connect ${Arr.join(failed, ", ")}: the human's definition of ${
              failed.length === 1 ? "it" : "them"
            } is in Claude Code, which \`claude mcp list\` shows.`,
        broken.length === 0
          ? ""
          : `Codex did not connect ${Arr.join(broken, ", ")}: \`codex mcp list\` shows what Codex says of it.`,
        servers.left.length === 0
          ? ""
          : `Left out: ${Arr.join(
              Arr.map(servers.left, ({ name, why }) => `${name} (${why})`),
              ", ",
            )}.`,
      ],
      (text) => text !== "",
    ),
    " ",
  );
};
