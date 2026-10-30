// The operator's per-role overlay for the agents Collie launches (ADR-0060).

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

/** What an overlay may set in Claude's settings: everything else is refused. */
export const CLAUDE_KEYS = Struct.keys(ClaudeOverlay.fields);

/** A value as written, or the file holding it; `~` is each Machine's own home. */
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

/** Every reason this text is not a profile, the first of them; an empty text is none. */
export function parseProfile(
  text: string,
): { readonly profile: AgentProfile } | { readonly refused: string } {
  if (Str.trim(text) === "") return { profile: {} };
  const json = AnyJson(text);
  if (Option.isNone(json)) return { refused: "agent_profile is not JSON" };
  const roles = Roles(json.value);
  if (Option.isNone(roles))
    return { refused: "agent_profile is an object of roles, each an object of env and claude" };
  for (const [role, given] of Rec.toEntries(roles.value)) {
    for (const key of Struct.keys(given))
      if (key !== "env" && key !== "claude")
        return { refused: `${role}.${key} is neither env nor claude` };
    const claude = Fields(given.claude ?? {});
    if (Option.isNone(claude)) return { refused: `${role}.claude is an object of settings` };
    for (const key of Struct.keys(claude.value)) {
      if (key === "disableAllHooks")
        return { refused: `${role}.claude.disableAllHooks would switch off Collie's own hooks` };
      if (!Arr.some(CLAUDE_KEYS, (name) => name === key))
        return {
          refused: `${role}.claude.${key} is not one Collie merges: ${Arr.join(CLAUDE_KEYS, ", ")}`,
        };
    }
  }
  const decoded = decodeProfile(json.value);
  if (decoded._tag === "Failure")
    return { refused: `agent_profile does not fit its shape: ${String(decoded.cause)}` };
  for (const [role, one] of Rec.toEntries(decoded.value))
    for (const [name, value] of Rec.toEntries(one.env ?? {})) {
      if (!ENV_NAME.test(name)) return { refused: `"${name}" is not an environment variable name` };
      if (!isLiteral(value)) continue;
      const removed = scrub(`${name}=${value}`).removed;
      if (removed.length > 0)
        return {
          refused: `${role}.env.${name} looks like a credential (${Arr.join([...new Set(removed)], ", ")}): it would be shared with every Machine, so hold it in a 0600 file and give {"file": "<path>"}`,
        };
    }
  return { profile: decoded.value };
}

const isLiteral = Schema.is(Schema.String);

/** A role's own overlay, else `*`'s, else none. */
export const roleProfile = (profile: AgentProfile, role: string): RoleProfile =>
  profile[role] ?? profile["*"] ?? {};

const expand = (path: string, home: string) =>
  path === "~"
    ? home
    : pipe(path, Str.startsWith("~/"))
      ? `${home}${pipe(path, Str.slice(1))}`
      : path;

/**
 * The pane lines that set `env` before the harness starts. A file's value is read by the
 * shell itself, so what is typed is its path and never the value.
 */
export const envLines = (env: Env, home: string): ReadonlyArray<string> =>
  Arr.map(Rec.toEntries(env), ([name, value]) =>
    isLiteral(value)
      ? `export ${name}=${Result.getOrThrow(CommandLine.quote(value))}`
      : `IFS= read -r ${name} < ${Result.getOrThrow(CommandLine.quote(expand(value.file, home)))}; export ${name}`,
  );

/** `env` as the values a terminal is started with: a file's first line, as `envLines` reads it. */
export const envValues = Effect.fn("Profile.envValues")(function* (env: Env, home: string) {
  const fs = yield* FileSystem.FileSystem;
  const values: Record<string, string> = {};
  for (const [name, value] of Rec.toEntries(env))
    values[name] = isLiteral(value)
      ? value
      : (Str.split(yield* fs.readFileString(expand(value.file, home)), "\n")[0] ?? "");
  return values;
});

/** Each file-held value that cannot be read safely, by path and problem; never its value. */
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

/** A Claude settings file, as `--settings` takes it. */
export type ClaudeSettings = Readonly<Record<string, Schema.Json>>;

const ClaudeHooks = Schema.Record(Schema.String, Schema.Array(Schema.Json));
type ClaudeHooks = typeof ClaudeHooks.Type;
const decodeHooks = Schema.decodeUnknownOption(ClaudeHooks);

/** Collie's settings with the overlay merged in: its hooks come first and always stay. */
export function mergeClaudeSettings(
  collie: ClaudeSettings,
  overlay: ClaudeOverlay,
): ClaudeSettings {
  const { hooks: added = {}, ...rest } = overlay;
  const own = Option.getOrElse(decodeHooks(collie.hooks), (): ClaudeHooks => ({}));
  const events = new Set([...Struct.keys(own), ...Struct.keys(added)]);
  const hooks: ClaudeHooks = Rec.fromEntries(
    Arr.map(
      [...events],
      (event) => [event, [...(own[event] ?? []), ...(added[event] ?? [])]] as const,
    ),
  );
  return Object.assign({}, collie, rest, { hooks });
}
