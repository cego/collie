import { expect, test } from "bun:test";
import { ownRoot, readEnv } from "../src/env";

test("plugin env is read from the herdr-provided variables", () => {
  const env = readEnv({
    HOME: "/home/x",
    HERDR_BIN_PATH: "/usr/bin/herdr",
    HERDR_SOCKET_PATH: "/run/herdr.sock",
    HERDR_PLUGIN_ROOT: "/plugins/cego.collie",
    COLLIE_USER_DIR: "/cfg",
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

test("without HERDR_PLUGIN_ROOT the compiled runner is its own plugin root", () => {
  // Compiled: the sources live in bun's virtual filesystem and execPath is the binary.
  expect(ownRoot("/$bunfs/root/main", "/opt/collie/bin/collie")).toBe("/opt/collie");
  // Development: `bun src/main.ts` runs from disk, and execPath is bun itself.
  expect(ownRoot("/home/x/collie/src/env.ts", "/home/x/.bun/bin/bun")).toBeNull();
  expect(ownRoot("/$bunfs/root/main", "/collie")).toBeNull();

  expect(readEnv({ HOME: "/home/x", PWD: "/elsewhere" }, "/opt/collie").pluginRoot).toBe(
    "/opt/collie",
  );
  expect(readEnv({ HOME: "/home/x", PWD: "/elsewhere" }, null).pluginRoot).toBe("/elsewhere");
  expect(readEnv({ HOME: "/home/x", HERDR_PLUGIN_ROOT: "/pinned" }, "/opt/collie").pluginRoot).toBe(
    "/pinned",
  );
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
  // The user's own layer sits beside the installation, whatever herdr would configure.
  expect(env.userDir).toBe(`${env.pluginRoot}/user`);
});

test("a malformed context json does not throw", () => {
  const env = readEnv({ HOME: "/home/x", HERDR_PLUGIN_CONTEXT_JSON: "{oops" });
  expect(env.context).toEqual({});
});

test("COLLIE_CWD is remembered as explicit; an inferred cwd is not", () => {
  const explicit = readEnv({ HOME: "/home/x", COLLIE_CWD: "/named/dir" });
  expect(explicit.cwd).toBe("/named/dir");
  expect(explicit.cwdExplicit).toBe(true);

  const inferred = readEnv({
    HOME: "/home/x",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_cwd: "/workspace" }),
  });
  expect(inferred.cwd).toBe("/workspace");
  expect(inferred.cwdExplicit).toBe(false);
});
