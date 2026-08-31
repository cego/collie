import { expect, test } from "bun:test";
import { readEnv } from "../src/env";

test("plugin env is read from the herdr-provided variables", () => {
  const env = readEnv({
    HOME: "/home/x",
    HERDR_BIN_PATH: "/usr/bin/herdr",
    HERDR_SOCKET_PATH: "/run/herdr.sock",
    HERDR_PLUGIN_ROOT: "/plugins/cego.collie",
    HERDR_PLUGIN_CONFIG_DIR: "/cfg",
    HERDR_PLUGIN_STATE_DIR: "/state",
    HERDR_PLUGIN_ACTION_ID: "pick",
    HERDR_WORKSPACE_ID: "2",
    HERDR_ACTIVE_PANE_CWD: "/repo",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/workspace" }),
  });

  expect(env.binPath).toBe("/usr/bin/herdr");
  expect(env.pluginRoot).toBe("/plugins/cego.collie");
  expect(env.stateDir).toBe("/state");
  expect(env.actionId).toBe("pick");
  expect(env.workspaceId).toBe("2");
  expect(env.cwd).toBe("/workspace");
});

test("cwd and ids fall back to the invocation context", () => {
  const env = readEnv({
    HOME: "/home/x",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: "3",
      workspace_cwd: "/ws",
      focused_pane_id: "3-1",
    }),
  });

  expect(env.workspaceId).toBe("3");
  expect(env.paneId).toBe("3-1");
  expect(env.cwd).toBe("/ws");
  expect(env.binPath).toBe("herdr");
  expect(env.configDir).toBe("/home/x/.config/herdr/plugins/config/cego.collie");
});

test("a malformed context json does not throw", () => {
  const env = readEnv({ HOME: "/home/x", HERDR_PLUGIN_CONTEXT_JSON: "{oops" });
  expect(env.context).toEqual({});
});
