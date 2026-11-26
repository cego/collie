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
export const TOKEN_ENV = `${OWN}MCP_TOKEN`;
const SHELL = "/bin/sh";
const NAME = /^[A-Za-z0-9_-]+$/;
const SETTABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const RELAY_HEADER = "X-Collie-Relay";
const STANDARD = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "PWD"];
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

export interface ShellPolicy {
  readonly excludes: ReadonlyArray<string>;
  readonly filters: Readonly<Record<string, string>>;
}

export const NO_POLICY: ShellPolicy = { excludes: [], filters: {} };

export interface CodexServers {
  readonly args: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly text: string }>;
  readonly given: ReadonlyArray<{ readonly name: string; readonly url?: string }>;
  readonly left: ReadonlyArray<{ readonly name: string; readonly why: string }>;
  readonly relays: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly variable: string;
  }>;
  readonly withheld: ReadonlyArray<string>;
}

export const NO_SERVERS: CodexServers = {
  args: [],
  files: [],
  given: [],
  left: [],
  relays: [],
  withheld: [],
};

// WARNING: Codex reads a `-c` value as TOML: a table's keys are quoted so a dot stays a header's name.
const quoted = (value: string) => JSON.stringify(value);
const setting = (key: string, value: string) => ["-c", `${key}=${quoted(value)}`];
export const codexServerUrlArgs: (name: string, url: string) => ReadonlyArray<string> = (
  name,
  url,
) => setting(`mcp_servers.${name}.url`, url);
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

// WARNING: the matches come from the original text, so a value holding a reference is not resolved twice.
const substituted: (
  value: string,
  env: Readonly<Record<string, string | undefined>>,
) => { readonly text: string; readonly used: ReadonlyArray<string> } = (value, env) => {
  const pieces = Arr.fromIterable(pipe(value, Str.matchAll(REFERENCE)));
  const { text, at } = Arr.reduce(pieces, { text: "", at: 0 }, (so, match) => {
    const whole = match[0] ?? "";
    const found = match.index ?? so.at;
    return {
      text: `${so.text}${pipe(value, Str.slice(so.at, found))}${env[match[1] ?? ""] ?? whole}`,
      at: found + whole.length,
    };
  });
  return {
    text: `${text}${pipe(value, Str.slice(at))}`,
    used: Arr.map(pieces, (one) => one[1] ?? ""),
  };
};

// WARNING: a url's userinfo is a credential, and Codex takes no url but in its arguments.
// WARNING: the url parser trims what a regex would not, so only its own reading can be trusted.
const credited = (url: string) => {
  if (!URL.canParse(url)) {
    return false;
  }
  const parsed = new URL(url);
  return parsed.username !== "" || parsed.password !== "";
};

const shQuote = (word: string) => `'${pipe(word, Str.replaceAll("'", String.raw`'\''`))}'`;

// WARNING: `null` means Codex's own names are unknown: passing the human's would override them.
export const codexServers: (
  servers: UserMcpServers,
  configured: ReadonlyArray<string> | null,
  policy: ShellPolicy,
  secrets: string,
  nativeVariables: ReadonlyArray<string>,
) => CodexServers = (servers, configured, policy, secrets, nativeVariables) => {
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
  const files: Array<{ path: string; text: string }> = [];
  const given: Array<{ name: string; url?: string }> = [];
  const left: Array<{ name: string; why: string }> = [];
  const relays: Array<{
    name: string;
    url: string;
    headers: Record<string, string>;
    variable: string;
  }> = [];
  const used: Array<string> = [];
  let mine: Array<string> = [];
  const resolve = (value: string) => {
    const made = substituted(value, childEnv());
    mine.push(...made.used);
    return made.text;
  };
  const included = (name: string) =>
    Arr.some(
      Rec.toEntries(policy.filters),
      ([key, rule]) => Str.toLowerCase(key) === Str.toLowerCase(name) && rule === "include",
    );
  const whyLeft = (variables: ReadonlyArray<string>) => {
    const native = Arr.findFirst(variables, (variable) => Arr.contains(nativeVariables, variable));
    if (Option.isSome(native)) {
      return `${native.value} is a variable Codex's own servers read`;
    }
    const standard = Arr.findFirst(variables, (variable) => Arr.contains(STANDARD, variable));
    if (Option.isSome(standard)) {
      return `${standard.value} is a variable the shell cannot do without`;
    }
    const allowed = Arr.findFirst(variables, included);
    return Option.isSome(allowed)
      ? `${allowed.value} is a variable the shell's allowlist names`
      : null;
  };
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
    mine = [];
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
      const resolvedValues = Arr.map(held, ([key, value]) => ({ key, text: resolve(value) }));
      const stdioWhy = whyLeft(mine);
      if (stdioWhy !== null) {
        left.push({ name, why: stdioWhy });
        continue;
      }
      // WARNING: a value in Codex's own environment is one its shell can read, so it waits in a file.
      const passing = Arr.map(resolvedValues, ({ key, text }, index) => {
        carried += 1;
        const path = `${secrets}/${carried}`;
        files.push({ path, text });
        return { key, path, temp: `${OWN}STAGE_${index + 1}` };
      });
      // WARNING: the sentinel keeps the newlines a command substitution would strip, and every value is read before any export replaces `PATH`.
      const staged = Arr.map(passing, ({ path, temp }) => ({
        ready: `[ -r ${shQuote(path)} ] || exit 1`,
        read: `${temp}=$(cat ${shQuote(path)} || exit 1; printf x) || exit 1; ${temp}=\${${temp}%x}`,
      }));
      args.push(
        ...setting(`mcp_servers.${name}.command`, SHELL),
        ...list(`mcp_servers.${name}.args`, [
          "-c",
          Arr.join(
            [
              ...Arr.map(staged, (one) => one.ready),
              ...Arr.map(staged, (one) => one.read),
              ...(passing.length === 0
                ? []
                : [
                    `rm -f ${Arr.join(
                      Arr.map(passing, (one) => shQuote(one.path)),
                      " ",
                    )} || exit 1`,
                  ]),
              ...Arr.map(passing, ({ key, temp }) => `export ${key}="$${temp}"`),
              'exec "$0" "$@"',
            ],
            "; ",
          ),
          server.command,
          ...(server.args ?? []),
        ]),
      );
      used.push(...mine);
      given.push({ name });
      continue;
    }
    if (!Schema.is(Http)(server)) {
      left.push({ name, why: "Codex does not speak SSE" });
      continue;
    }
    if (credited(server.url)) {
      left.push({ name, why: "its url holds a credential Codex would show in its arguments" });
      continue;
    }
    const headers: Record<string, string> = {};
    for (const [header, value] of Rec.toEntries(server.headers ?? {})) {
      headers[header] = resolve(value);
    }
    const httpWhy = whyLeft(mine);
    if (httpWhy !== null) {
      left.push({ name, why: httpWhy });
      continue;
    }
    if (!URL.canParse(server.url)) {
      left.push({ name, why: "its url is not a url" });
      continue;
    }
    if (Rec.size(headers) === 0) {
      args.push(...codexServerUrlArgs(name, server.url));
    } else {
      // WARNING: the token guards the relay, so it is Collie's own and never an imported value.
      const variable = `${OWN}RELAY_${relays.length + 1}`;
      args.push(...table(`mcp_servers.${name}.env_http_headers`, { [RELAY_HEADER]: variable }));
      relays.push({ name, url: server.url, headers, variable });
    }
    used.push(...mine);
    given.push({ name, url: server.url });
  }
  const withheld = Arr.dedupe(used);
  // WARNING: a wildcard exclusion would drop a human's include for that wildcard, so only Collie's own names are excluded.
  const folded = (name: string) => Str.toLowerCase(name);
  const keyed = Rec.toEntries(policy.filters);
  const wants = Arr.dedupe([TOKEN_ENV, ...Arr.map(relays, (one) => one.variable), ...used]);
  const foldedOnce = (so: ReadonlyArray<string>, name: string) =>
    Arr.some(so, (held) => folded(held) === folded(name)) ? so : Arr.append(so, name);
  const added = Arr.reduce(wants, Arr.empty<string>(), foldedOnce);
  const dropped = Arr.map(added, (name) => folded(name));
  const untouched = Rec.filter(policy.filters, (_rule, key) => !Arr.contains(dropped, folded(key)));
  const merged = Arr.reduce(added, { ...untouched }, (so, name) => ({ ...so, [name]: "exclude" }));
  // WARNING: Codex drops its keyed `filters` table when a legacy exclude is set beside it.
  if (added.length > 0) {
    args.push(
      ...(keyed.length > 0
        ? table("shell_environment_policy.filters", merged)
        : list("shell_environment_policy.exclude", Arr.dedupe([...added, ...policy.excludes]))),
    );
  }
  return { args, files, given, left, relays, withheld };
};

const toolsOf = (status: CodexStatus | undefined) => Rec.keys(status?.tools ?? {});

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
  const relayed = Arr.map(servers.relays, (one) => one.name);
  const signingIn = Arr.filter(names, (name) => reported[name]?.authStatus === "notLoggedIn");
  // WARNING: the relay's own header reads as a credential to Codex, so a server behind it never asks for a sign-in of its own.
  const failed = Arr.filter(
    imported,
    (name) =>
      !Arr.contains(relayed, name) &&
      (reported[name] === undefined || (reported[name]?.toolsError ?? null) !== null),
  );
  const stuck = Arr.filter(relayed, (name) =>
    reported[name] === undefined ? true : (reported[name]?.toolsError ?? null) !== null,
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
        stuck.length === 0
          ? ""
          : `${Arr.join(stuck, ", ")} cannot be signed in through Collie's relay: its definition carries a header, so Collie gives Codex its own address and a sign-in Codex stored for the server itself is not used — tell the human to remove that header, or add the server to Codex itself.`,
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
