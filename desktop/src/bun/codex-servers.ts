import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { homedir } from "node:os";
import { Option, Schema } from "effect";
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
      args.push(...setting(`mcp_servers.${name}.command`, server.command));
      if (server.args !== undefined) {
        args.push(...list(`mcp_servers.${name}.args`, server.args));
      }
      const variables = Arr.map(Rec.toEntries(server.env ?? {}), ([key, value]) => {
        env[key] = referenced(value, childEnv());
        return key;
      });
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
      const variable = `COLLIE_CHAT_SERVER_${carried}`;
      env[variable] = referenced(value, childEnv());
      headers[header] = variable;
    }
    args.push(...table(`mcp_servers.${name}.env_http_headers`, headers));
    given.push({ name, url: server.url });
  }
  return { args, env, given, left };
};

const namesIn = (path: string) =>
  Bun.file(path)
    .text()
    .then((text) => Option.getOrElse(decodeConfig(Bun.TOML.parse(text)), () => NO_CONFIG))
    .then((config) => Rec.keys(config.mcp_servers ?? {}))
    .catch(() => []);

const configPaths = (dir: string) => {
  const home = homedir();
  const paths: Array<string> = [`${childEnv().CODEX_HOME ?? `${home}/.codex`}/config.toml`];
  for (
    let at = dir;
    at.length > 1;
    at = pipe(
      at,
      Str.slice(
        0,
        Option.getOrElse(pipe(at, Str.lastIndexOf("/")), () => 0),
      ),
    )
  ) {
    paths.push(`${at}/.codex/config.toml`);
    if (at === home) {
      break;
    }
  }
  return paths;
};

export const codexConfigured: (dir: string) => Promise<ReadonlyArray<string>> = (dir) =>
  Promise.all(Arr.map(configPaths(dir), namesIn)).then((found) => Arr.dedupe(Arr.flatten(found)));

const toolsOf = (status: CodexStatus | undefined) => Rec.keys(status?.tools ?? {});

export const codexUnsettled: (statuses: ReadonlyArray<CodexStatus>) => boolean = (statuses) =>
  Arr.some(
    statuses,
    (one) => one.authStatus === "notLoggedIn" || (one.toolsError ?? null) !== null,
  );

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
  const urls: Record<string, string> = {};
  for (const one of servers.given) {
    if (one.url !== undefined) {
      urls[one.name] = one.url;
    }
  }
  const names = Arr.dedupe([...Arr.map(servers.given, (one) => one.name), ...Rec.keys(reported)]);
  const signingIn = Arr.filter(names, (name) => reported[name]?.authStatus === "notLoggedIn");
  const failed = Arr.filter(
    names,
    (name) =>
      reported[name] === undefined ||
      (!signingIn.includes(name) && (reported[name]?.toolsError ?? null) !== null),
  );
  const described = Arr.map(names, (name) => {
    const tools = toolsOf(reported[name]);
    return `${name} (${tools.length === 0 ? "no tools" : Arr.join(tools, ", ")})`;
  });
  const login = (name: string) => {
    const url = urls[name];
    return `codex mcp login ${name}${
      url === undefined ? "" : ` -c 'mcp_servers.${name}.url=${quoted(url)}'`
    }`;
  };
  const errors: Array<string> = [];
  for (const name of failed) {
    const said = reported[name]?.toolsError ?? "";
    if (said !== "") {
      errors.push(said);
    }
  }
  const fromCollie = Arr.filter(failed, (name) => urls[name] !== undefined);
  const fromCodex = Arr.filter(failed, (name) => urls[name] === undefined);
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
          : `Codex did not connect ${Arr.join(failed, ", ")}: ${
              errors.length === 0 ? "it reported nothing of it" : Arr.join(errors, "; ")
            }.`,
        fromCollie.length === 0
          ? ""
          : `The definition of ${Arr.join(
              fromCollie,
              ", ",
            )} is the human's own, in Claude Code, which \`claude mcp list\` shows.`,
        fromCodex.length === 0
          ? ""
          : `Codex configures ${Arr.join(fromCodex, ", ")} itself, and \`codex mcp list\` shows it.`,
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
