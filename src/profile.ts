import * as Struct from "effect/Struct";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Option, Result, Schema } from "effect";
import { CommandLine } from "effect/process";
import { scrub } from "./redact";

const ClaudeOverlay = Schema.Struct({
  enabledPlugins: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  skillOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  claudeMdExcludes: Schema.optionalKey(Schema.Array(Schema.String)),
  disableClaudeAiConnectors: Schema.optionalKey(Schema.Boolean),
  hooks: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.Json))),
});
export type ClaudeOverlay = typeof ClaudeOverlay.Type;

export const CLAUDE_KEYS = Struct.keys(ClaudeOverlay.fields);

const EnvValue = Schema.Union([Schema.String, Schema.Struct({ file: Schema.String })]);
export type Env = Readonly<Record<string, typeof EnvValue.Type>>;

const RoleProfile = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, EnvValue)),
  claude: Schema.optionalKey(ClaudeOverlay),
});
export type RoleProfile = typeof RoleProfile.Type;

const AgentProfile = Schema.Record(Schema.String, RoleProfile);
export type AgentProfile = typeof AgentProfile.Type;

const AnyJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const Roles = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
);
const Fields = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const decodeProfile = Schema.decodeUnknownExit(AgentProfile);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseProfile(text: string) {
  if (Str.trim(text) === "") {
    const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
      profile: {},
    };
    return returned;
  }
  const json = AnyJson(text);
  if (Option.isNone(json)) {
    const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
      refused: "agent_profile is not JSON",
    };
    return returned;
  }
  const roles = Roles(json.value);
  if (Option.isNone(roles)) {
    const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
      refused: "agent_profile is an object of roles, each an object of env and claude",
    };
    return returned;
  }
  for (const [role, given] of Rec.toEntries(roles.value)) {
    for (const key of Struct.keys(given))
      if (key !== "env" && key !== "claude") {
        const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
          refused: `${role}.${key} is neither env nor claude`,
        };
        return returned;
      }
    const claude = Fields(given.claude ?? {});
    if (Option.isNone(claude)) {
      const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
        refused: `${role}.claude is an object of settings`,
      };
      return returned;
    }
    for (const key of Struct.keys(claude.value)) {
      if (key === "disableAllHooks") {
        const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
          refused: `${role}.claude.disableAllHooks would switch off Collie's own hooks`,
        };
        return returned;
      }
      if (!Arr.some(CLAUDE_KEYS, (name) => name === key)) {
        const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
          refused: `${role}.claude.${key} is not one Collie merges: ${Arr.join(CLAUDE_KEYS, ", ")}`,
        };
        return returned;
      }
    }
  }
  const decoded = decodeProfile(json.value);
  if (decoded._tag === "Failure") {
    const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
      refused: `agent_profile does not fit its shape: ${String(decoded.cause)}`,
    };
    return returned;
  }
  for (const [role, one] of Rec.toEntries(decoded.value))
    for (const [name, value] of Rec.toEntries(one.env ?? {})) {
      if (!ENV_NAME.test(name)) {
        const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
          refused: `"${name}" is not an environment variable name`,
        };
        return returned;
      }
      if (!isLiteral(value)) continue;
      const removed = scrub(`${name}=${value}`).removed;
      if (removed.length > 0) {
        const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
          refused: `${role}.env.${name} looks like a credential (${Arr.join([...new Set(removed)], ", ")}): it would be shared with every Machine, so hold it in a 0600 file and give {"file": "<path>"}`,
        };
        return returned;
      }
    }
  const returned: { readonly profile: AgentProfile } | { readonly refused: string } = {
    profile: decoded.value,
  };
  return returned;
}

const isLiteral = Schema.is(Schema.String);

export const roleProfile = (profile: AgentProfile, role: string) =>
  profile[role] ?? profile["*"] ?? {};

const expand = (path: string, home: string) =>
  path === "~"
    ? home
    : pipe(path, Str.startsWith("~/"))
      ? `${home}${pipe(path, Str.slice(1))}`
      : path;

export const envLines = (env: Env, home: string) =>
  Arr.map(Rec.toEntries(env), ([name, value]) =>
    isLiteral(value)
      ? `export ${name}=${Result.getOrThrow(CommandLine.quote(value))}`
      : `IFS= read -r ${name} < ${Result.getOrThrow(CommandLine.quote(expand(value.file, home)))}; export ${name}`,
  );

export const envValues = Effect.fn("Profile.envValues")(function* (env: Env, home: string) {
  const fs = yield* FileSystem.FileSystem;
  const values: Record<string, string> = {};
  for (const [name, value] of Rec.toEntries(env))
    values[name] = isLiteral(value)
      ? value
      : (Str.split(yield* fs.readFileString(expand(value.file, home)), "\n")[0] ?? "");
  return values;
});

export const envFileProblems = Effect.fn("Profile.envFileProblems")(function* (
  env: Env,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const problems: string[] = [];
  for (const value of Rec.values(env)) {
    if (isLiteral(value)) continue;
    const path = expand(value.file, home);
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (Option.isNone(info)) problems.push(`${path} does not exist`);
    else if (info.value.type !== "File") problems.push(`${path} is not a file`);
    else if ((info.value.mode & 0o777) !== 0o600)
      problems.push(`${path} is mode 0${(info.value.mode & 0o777).toString(8)}, not 0600`);
  }
  return problems;
});

export type ClaudeSettings = Readonly<Record<string, Schema.Json>>;

const ClaudeHooks = Schema.Record(Schema.String, Schema.Array(Schema.Json));
type ClaudeHooks = typeof ClaudeHooks.Type;
const decodeHooks = Schema.decodeUnknownOption(ClaudeHooks);

export function mergeClaudeSettings(collie: ClaudeSettings, overlay: ClaudeOverlay) {
  const { hooks: added = {}, ...rest } = overlay;
  const own = Option.getOrElse(decodeHooks(collie.hooks), () => {
    const returned: ClaudeHooks = {};
    return returned;
  });
  const events = new Set([...Struct.keys(own), ...Struct.keys(added)]);
  const hooks: ClaudeHooks = Rec.fromEntries(
    Arr.map(
      [...events],
      (event) => [event, [...(own[event] ?? []), ...(added[event] ?? [])]] as const,
    ),
  );
  return Object.assign({}, collie, rest, { hooks });
}
