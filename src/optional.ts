// The integrations a Run can need and an install cannot make: Helle credentials, and a
// Linear MCP server in Claude Code. Neither is a prerequisite — the baseline `implement`
// and `review` need neither — so `doctor` reports them without failing. But a Run that
// does need one finds out at its merge step, hours of tokens in, or when an agent goes
// looking for a tool it does not have; so `startRun` asks the same two questions first,
// and refuses with the fix rather than starting a Run it can already see failing.

import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import type { PluginEnv } from "./env";
import { credentials, helleMe } from "./helle";

/**
 * `ok`: there. `absent`: not set up, and nothing is wrong. `broken`: set up and not
 * working, which is the state a human wants told apart from "not set up" — the fix
 * for one is to write a file, for the other to read it.
 */
export type Probe =
  | { state: "ok"; detail: string }
  | { state: "absent" | "broken"; detail: string; fix: string };

/** Long enough for a small internal service; short enough that chat's health line is not held by it. */
const HELLE_PROBE = "5 seconds";

export const helleEnvPath = (env: PluginEnv) =>
  env.raw["HELLE_ENV_FILE"] ?? `${env.home}/.config/helle/env`;

export const probeHelle = Effect.fn("Optional.probeHelle")(function* (env: PluginEnv) {
  const file = helleEnvPath(env);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file)))
    return {
      state: "absent",
      detail: `no credentials at ${file}; only workflows that wait on Helle (renovate) need them`,
      fix: `write HELLE_API_URL=<url> and HELLE_API_TOKEN=<token> to ${file}`,
    } satisfies Probe;
  const creds = yield* credentials({ home: env.home, envFile: file }).pipe(Effect.result);
  if (Result.isFailure(creds))
    return {
      state: "broken",
      detail: creds.failure.message,
      fix: `add the missing line to ${file}`,
    } satisfies Probe;
  const me = yield* helleMe(creds.success).pipe(
    Effect.result,
    Effect.timeoutOption(HELLE_PROBE),
    Effect.map(Option.getOrNull),
  );
  if (me === null)
    return {
      state: "broken",
      detail: `${creds.success.url} did not answer within ${HELLE_PROBE}`,
      fix: `check HELLE_API_URL in ${file}, and that the host is reachable`,
    } satisfies Probe;
  if (Result.isFailure(me))
    return {
      state: "broken",
      detail: me.failure.message,
      fix: `check HELLE_API_TOKEN in ${file}`,
    } satisfies Probe;
  return { state: "ok", detail: `${creds.success.url} as ${me.success.user_id}` } satisfies Probe;
});

/**
 * Where Claude Code keeps MCP servers: user and local scope in `.claude.json` (under
 * `CLAUDE_CONFIG_DIR` when that is set), project scope in the project's `.mcp.json`.
 * A server is Linear's when its name or URL says so; Collie has no other way to know.
 * Only the keys this question needs are read; everything else in those files is theirs.
 */
export const LINEAR_MCP_FIX =
  "claude mcp add --transport http --scope user linear-server https://mcp.linear.app/mcp";

const Servers = Schema.Record(
  Schema.String,
  Schema.Struct({ url: Schema.optionalKey(Schema.String) }),
);
type Servers = Schema.Schema.Type<typeof Servers>;
const McpConfig = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optionalKey(Servers),
    projects: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Struct({ mcpServers: Schema.optionalKey(Servers) })),
    ),
  }),
);
type McpConfig = Schema.Schema.Type<typeof McpConfig>;
const decodeMcpConfig = Schema.decodeUnknownEffect(McpConfig);

const linearAmong = (servers: Servers | undefined): string | null => {
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (/linear/i.test(name) || /linear/i.test(server.url ?? "")) return name;
  }
  return null;
};

export const probeLinearMcp = Effect.fn("Optional.probeLinearMcp")(function* (env: PluginEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = env.raw["CLAUDE_CONFIG_DIR"] ?? env.home;
  const places: { file: string; servers: (config: McpConfig) => Servers | undefined }[] = [
    { file: path.join(configDir, ".claude.json"), servers: (config) => config.mcpServers },
    {
      file: path.join(configDir, ".claude.json"),
      servers: (config) => config.projects?.[env.cwd]?.mcpServers,
    },
    { file: path.join(env.cwd, ".mcp.json"), servers: (config) => config.mcpServers },
  ];
  const seen: string[] = [];
  for (const place of places) {
    if (!(yield* fs.exists(place.file))) continue;
    if (!seen.includes(place.file)) seen.push(place.file);
    const text = yield* fs.readFileString(place.file).pipe(Effect.catch(() => Effect.succeed("")));
    const config = yield* decodeMcpConfig(text).pipe(Effect.result);
    if (Result.isFailure(config))
      return {
        state: "broken",
        detail: `${place.file} could not be read as Claude Code's settings, so its MCP servers are unknown`,
        fix: `fix or remove ${place.file}`,
      } satisfies Probe;
    const name = linearAmong(place.servers(config.success));
    if (name !== null) return { state: "ok", detail: `"${name}" in ${place.file}` } satisfies Probe;
  }
  return {
    state: "absent",
    detail: `no Linear MCP server in Claude Code (looked in ${seen.length === 0 ? path.join(configDir, ".claude.json") : seen.join(", ")}); plan's "Offload to Linear" and a Linear issue as the work need one`,
    fix: LINEAR_MCP_FIX,
  } satisfies Probe;
});
