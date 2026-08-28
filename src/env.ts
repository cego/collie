// Plugin environment as herdr hands it to an action or pane entrypoint.
// Names come from the herdr plugin runtime; see docs/SPEC.md.

export const PLUGIN_ID = "cego.workflows";

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

export function readEnv(env: Record<string, string | undefined> = process.env): PluginEnv {
  let context: PluginContext = {};
  const json = env.HERDR_PLUGIN_CONTEXT_JSON;
  if (json) {
    try {
      context = JSON.parse(json) as PluginContext;
    } catch {
      // A malformed context must not stop the run; inference falls back to cwd.
    }
  }

  const home = env.HOME ?? "/tmp";
  const pluginRoot = first(env, "HERDR_PLUGIN_ROOT") ?? process.cwd();
  const cwd =
    first(env, "HERDR_WORKFLOWS_CWD", "HERDR_ACTIVE_PANE_CWD") ??
    context.focused_pane_cwd ??
    context.workspace_cwd ??
    process.cwd();

  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("HERDR_") && v !== undefined) raw[k] = v;
  }

  return {
    pluginRoot,
    home,
    configDir:
      first(env, "HERDR_PLUGIN_CONFIG_DIR") ?? `${home}/.config/herdr/plugins/${PLUGIN_ID}`,
    stateDir:
      first(env, "HERDR_PLUGIN_STATE_DIR") ?? `${home}/.local/state/herdr/plugins/${PLUGIN_ID}`,
    binPath: first(env, "HERDR_BIN_PATH") ?? "herdr",
    socketPath: first(env, "HERDR_SOCKET_PATH"),
    workspaceId: first(env, "HERDR_WORKSPACE_ID", "HERDR_ACTIVE_WORKSPACE_ID") ?? context.workspace_id ?? null,
    tabId: first(env, "HERDR_TAB_ID", "HERDR_ACTIVE_TAB_ID") ?? context.tab_id ?? null,
    paneId: first(env, "HERDR_PANE_ID", "HERDR_ACTIVE_PANE_ID") ?? context.focused_pane_id ?? null,
    actionId: first(env, "HERDR_PLUGIN_ACTION_ID"),
    entrypointId: first(env, "HERDR_PLUGIN_ENTRYPOINT_ID"),
    cwd,
    context,
    raw,
  };
}
