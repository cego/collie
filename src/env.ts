import { Config, Effect, Option, Schema } from "effect";

// Plugin environment as herdr hands it to an action or pane entrypoint.
// Names come from the herdr plugin runtime.

export const PLUGIN_ID = "cego.collie";

export interface PluginContext {
  workspace_id?: string;
  workspace_cwd?: string;
  workspace_label?: string;
  tab_id?: string;
  tab_label?: string;
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  invocation_source?: string;
}

export interface PluginEnv {
  pluginRoot: string;
  /** The human's home, where a harness keeps what it remembers between sessions. */
  home: string;
  configDir: string;
  stateDir: string;
  binPath: string;
  socketPath: string | null;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  actionId: string | null;
  entrypointId: string | null;
  collieMode: string | null;
  /** Directory the run should treat as the project. */
  cwd: string;
  context: PluginContext;
  raw: Record<string, string>;
}

function first(env: Record<string, string | undefined>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

export function readEnv(env: Readonly<Record<string, string | undefined>>): PluginEnv {
  const context: PluginContext = Option.getOrElse(
    Schema.decodeUnknownOption(PluginContextJson)(env.HERDR_PLUGIN_CONTEXT_JSON),
    (): PluginContext => ({}),
  );

  const home = env.HOME ?? "/tmp";
  const pluginRoot = first(env, "HERDR_PLUGIN_ROOT") ?? env.PWD ?? ".";
  // `PWD` goes stale whenever something chdir'd; the real directory never does.
  const cwd = first(env, "COLLIE_CWD") ?? context.workspace_cwd ?? process.cwd();

  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) raw[key] = value;
  }

  return {
    pluginRoot,
    home,
    configDir:
      first(env, "HERDR_PLUGIN_CONFIG_DIR") ?? `${home}/.config/herdr/plugins/config/${PLUGIN_ID}`,
    stateDir:
      first(env, "HERDR_PLUGIN_STATE_DIR") ?? `${home}/.local/state/herdr/plugins/${PLUGIN_ID}`,
    binPath: first(env, "HERDR_BIN_PATH") ?? "herdr",
    socketPath: first(env, "HERDR_SOCKET_PATH"),
    workspaceId:
      first(env, "HERDR_WORKSPACE_ID", "HERDR_ACTIVE_WORKSPACE_ID") ?? context.workspace_id ?? null,
    tabId: first(env, "HERDR_TAB_ID", "HERDR_ACTIVE_TAB_ID") ?? context.tab_id ?? null,
    paneId: first(env, "HERDR_PANE_ID", "HERDR_ACTIVE_PANE_ID") ?? context.focused_pane_id ?? null,
    actionId: first(env, "HERDR_PLUGIN_ACTION_ID"),
    entrypointId: first(env, "HERDR_PLUGIN_ENTRYPOINT_ID"),
    collieMode: first(env, "COLLIE_MODE"),
    cwd,
    context,
    raw,
  };
}

const PluginContextJson = Schema.fromJsonString(
  Schema.Struct({
    workspace_id: Schema.optional(Schema.String),
    workspace_cwd: Schema.optional(Schema.String),
    workspace_label: Schema.optional(Schema.String),
    tab_id: Schema.optional(Schema.String),
    tab_label: Schema.optional(Schema.String),
    focused_pane_id: Schema.optional(Schema.String),
    focused_pane_cwd: Schema.optional(Schema.String),
    invocation_source: Schema.optional(Schema.String),
  }),
);

const environmentKeys = [
  "HOME",
  "PWD",
  "COLLIE_CWD",
  "COLLIE_MODE",
  "HERDR_BIN_PATH",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_ROOT",
  "HERDR_PLUGIN_CONFIG_DIR",
  "HERDR_PLUGIN_STATE_DIR",
  "HERDR_PLUGIN_ACTION_ID",
  "HERDR_PLUGIN_ENTRYPOINT_ID",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_WORKSPACE_ID",
  "HERDR_ACTIVE_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_ACTIVE_TAB_ID",
  "HERDR_PANE_ID",
  "HERDR_ACTIVE_PANE_ID",
] as const;

export const currentEnv = Effect.gen(function* () {
  const env: Record<string, string | undefined> = {};
  for (const key of environmentKeys) {
    const value = yield* Config.option(Config.string(key));
    if (Option.isSome(value)) env[key] = value.value;
  }
  return readEnv(env);
});
