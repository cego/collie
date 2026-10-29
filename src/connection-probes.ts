import { Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import type { PluginEnv } from "./env";
import { credentials, helleMe } from "./helle";
import { helleUrlOf } from "./helle-url";
import type { ConnectionReading as Probe } from "./connection-model";

export type { ConnectionReading as Probe } from "./connection-model";

/** Long enough for a small internal service; short enough that chat's health line is not held by it. */
const HELLE_PROBE = "5 seconds";

export const helleEnvPath = (env: PluginEnv) =>
  env.raw["HELLE_ENV_FILE"] ?? `${env.home}/.config/helle/env`;

export const probeHelle = Effect.fn("Connections.probeHelle")(function* (env: PluginEnv) {
  const file = helleEnvPath(env);
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file)))
    return {
      state: "absent",
      detail: `no credentials at ${file}`,
      fix: `write HELLE_API_TOKEN=<token> to ${file}`,
    } satisfies Probe;
  const creds = yield* credentials({
    home: env.home,
    envFile: file,
    url: helleUrlOf(env.raw),
  }).pipe(Effect.result);
  if (Result.isFailure(creds))
    return {
      state: "broken",
      detail: creds.failure.message,
      fix: `add HELLE_API_TOKEN=<token> to ${file}`,
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
      fix: `check that ${creds.success.url} is reachable`,
    } satisfies Probe;
  if (Result.isFailure(me))
    return {
      state: "broken",
      detail: me.failure.message,
      fix: `check HELLE_API_TOKEN in ${file}`,
    } satisfies Probe;
  return {
    state: "ok",
    account: me.success.user_id,
    detail: `${creds.success.url} as ${me.success.user_id}`,
  } satisfies Probe;
});

export const LINEAR_MCP_ADD = [
  "mcp",
  "add",
  "--transport",
  "http",
  "--scope",
  "user",
  "linear-server",
  "https://mcp.linear.app/mcp",
];
export const LINEAR_MCP_FIX = `claude ${LINEAR_MCP_ADD.join(" ")}`;

const Servers = Schema.Record(
  Schema.String,
  Schema.Struct({
    url: Schema.optionalKey(Schema.String),
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
);
type Servers = Schema.Schema.Type<typeof Servers>;
const McpConfig = Schema.Struct({
  mcpServers: Schema.optionalKey(Servers),
  mcp_servers: Schema.optionalKey(Servers),
  mcp: Schema.optionalKey(Schema.Union([Schema.Struct({ servers: Servers }), Servers])),
  projects: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ mcpServers: Schema.optionalKey(Servers) })),
  ),
});
type McpConfig = Schema.Schema.Type<typeof McpConfig>;
const decodeMcpConfig = Schema.decodeUnknownSync(McpConfig);

const linearAmong = (servers: Servers | undefined): string | null => {
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (server.enabled !== false && (/linear/i.test(name) || /linear/i.test(server.url ?? "")))
      return name;
  }
  return null;
};

export const probeLinearMcp = Effect.fn("Connections.probeLinearMcp")(function* (env: PluginEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = env.raw["CLAUDE_CONFIG_DIR"] ?? env.home;
  const json = Schema.decodeUnknownSync(Schema.fromJsonString(McpConfig));
  const jsonc = (text: string) => decodeMcpConfig(Bun.JSONC.parse(text));
  const toml = (text: string) => decodeMcpConfig(Bun.TOML.parse(text));
  const places: {
    file: string;
    harness: string;
    parse: (text: string) => McpConfig;
    servers: (config: McpConfig) => Servers | undefined;
  }[] = [
    {
      file: path.join(configDir, ".claude.json"),
      harness: "Claude Code",
      parse: json,
      servers: (config) => config.mcpServers,
    },
    {
      file: path.join(configDir, ".claude.json"),
      harness: "Claude Code",
      parse: json,
      servers: (config) => config.projects?.[env.cwd]?.mcpServers,
    },
    {
      file: path.join(env.cwd, ".mcp.json"),
      harness: "Claude Code",
      parse: json,
      servers: (config) => config.mcpServers,
    },
    ...[
      path.join(env.raw.CODEX_HOME ?? path.join(env.home, ".codex"), "config.toml"),
      path.join(env.cwd, ".codex", "config.toml"),
    ].map((file) => ({
      file,
      harness: "Codex",
      parse: toml,
      servers: (config: McpConfig) => config.mcp_servers,
    })),
    ...[
      env.raw.OPENCODE_CONFIG,
      ...[
        path.join(env.raw.XDG_CONFIG_HOME ?? path.join(env.home, ".config"), "opencode"),
        env.cwd,
      ].flatMap((dir) => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]),
    ]
      .filter((file) => file !== undefined)
      .map((file) => ({
        file,
        harness: "OpenCode",
        parse: jsonc,
        servers: (config: McpConfig) => {
          if (config.mcp === undefined) return undefined;
          if ("servers" in config.mcp && Schema.is(Servers)(config.mcp.servers))
            return config.mcp.servers;
          return Schema.is(Servers)(config.mcp) ? config.mcp : undefined;
        },
      })),
  ];
  const seen: string[] = [];
  let broken: Probe | undefined;
  for (const place of places) {
    if (!(yield* fs.exists(place.file))) continue;
    if (!seen.includes(place.file)) seen.push(place.file);
    const text = yield* fs.readFileString(place.file).pipe(Effect.catch(() => Effect.succeed("")));
    const config = yield* Effect.try(() => place.parse(text)).pipe(Effect.result);
    if (Result.isFailure(config)) {
      broken ??= {
        state: "broken",
        detail: `${place.file} could not be read as ${place.harness}'s settings, so its MCP servers are unknown`,
        fix: `fix or remove ${place.file}`,
      } satisfies Probe;
      continue;
    }
    const name = linearAmong(place.servers(config.success));
    if (name !== null)
      return { state: "ok", account: name, detail: `"${name}" in ${place.file}` } satisfies Probe;
  }
  return (
    broken ??
    ({
      state: "absent",
      detail: `no Linear MCP server in Claude Code (looked in ${seen.length === 0 ? path.join(configDir, ".claude.json") : seen.join(", ")}); plan's "Offload to Linear" and a Linear issue as the work need one`,
      fix: LINEAR_MCP_FIX,
    } satisfies Probe)
  );
});

export { probeGitlab } from "./forge/gitlab";
export { probeGithub } from "./forge/github";
