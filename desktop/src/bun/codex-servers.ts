import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema } from "effect";
import * as Option from "effect/Option";
import { childEnv } from "./login-env";
import type { UserMcpServers } from "./session";

const RESERVED = "collie_desktop";
const OWN = "COLLIE_CHAT_";
const SHELL = "/bin/sh";
const NAME = /^[A-Za-z0-9_-]+$/;
const SETTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

// WARNING: `null` means Codex's own names are unknown: passing the human's would override them.
export const codexServers: (
  servers: UserMcpServers,
  configured: ReadonlyArray<string> | null,
) => CodexServers = (servers, configured) => {
  if (configured === null) {
    return {
      ...NO_SERVERS,
      left: Arr.map(Rec.keys(servers), (name) => ({
        name,
        why: "Collie could not read which servers Codex already has, so it passed none of the human's",
      })),
    };
  }
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
      const held = Rec.toEntries(server.env ?? {});
      const own = Arr.findFirst(held, ([key]) => pipe(key, Str.startsWith(OWN)));
      const unsettable = Arr.findFirst(held, ([key]) => !SETTABLE.test(key));
      if (Option.isSome(own)) {
        left.push({ name, why: `${own.value[0]} is in Collie's own namespace` });
        continue;
      }
      if (Option.isSome(unsettable)) {
        left.push({ name, why: `${unsettable.value[0]} is a name a shell cannot set` });
        continue;
      }
      // WARNING: a stdio value under the name the human gave it would reach Codex's other servers too.
      const passing = Arr.map(held, ([key, value]) => {
        carried += 1;
        const variable = `${OWN}STDIO_${carried}`;
        env[variable] = referenced(value, childEnv());
        return { key, variable };
      });
      args.push(
        ...setting(`mcp_servers.${name}.command`, SHELL),
        ...list(`mcp_servers.${name}.args`, [
          "-c",
          Arr.join(
            [
              ...Arr.map(passing, ({ key, variable }) => `export ${key}="$${variable}"`),
              'exec "$0" "$@"',
            ],
            "; ",
          ),
          server.command,
          ...(server.args ?? []),
        ]),
        ...list(
          `mcp_servers.${name}.env_vars`,
          Arr.map(passing, (one) => one.variable),
        ),
      );
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
