import { expect, test } from "bun:test";
import { Effect } from "effect";
import { runEffect } from "./support/effect";
import { leaveLauncher, ownRoot, readEnv, withoutHerdrOne } from "../src/env";

test("Collie reads its own installation, state and working directory", () => {
  const env = readEnv({
    HOME: "/home/x",
    COLLIE_ROOT: "/opt/collie",
    COLLIE_USER_DIR: "/cfg",
    COLLIE_STATE_DIR: "/state",
    COLLIE_CWD: "/repo",
  });

  expect(env.pluginRoot).toBe("/opt/collie");
  expect(env.stateDir).toBe("/state");
  expect(env.userDir).toBe("/cfg");
  expect(env.cwd).toBe("/repo");
});

test("without COLLIE_ROOT the compiled runner is its own installation root", () => {
  expect(ownRoot("/$bunfs/root/main", "/opt/collie/bin/collie")).toBe("/opt/collie");
  expect(ownRoot("/home/x/collie/src/env.ts", "/home/x/.bun/bin/bun")).toBeNull();
  expect(ownRoot("/$bunfs/root/main", "/collie")).toBeNull();

  expect(readEnv({ HOME: "/home/x", PWD: "/elsewhere" }, "/opt/collie").pluginRoot).toBe(
    "/opt/collie",
  );
  expect(readEnv({ HOME: "/home/x", PWD: "/elsewhere" }, null).pluginRoot).toBe("/elsewhere");
  expect(readEnv({ HOME: "/home/x", COLLIE_ROOT: "/pinned" }, "/opt/collie").pluginRoot).toBe(
    "/pinned",
  );
});

test("retired Herdr variables cannot redirect Collie's root, state or invocation", () => {
  const env = readEnv(
    {
      HOME: "/home/x",
      HERDR_PLUGIN_ROOT: "/old/root",
      HERDR_PLUGIN_STATE_DIR: "/old/state",
      HERDR_WORKSPACE_ID: "2",
      HERDR_TAB_ID: "tab",
      HERDR_PANE_ID: "pane",
      HERDR_PLUGIN_ACTION_ID: "action",
      HERDR_PLUGIN_ENTRYPOINT_ID: "entry",
      HERDR_PLUGIN_CONTEXT_JSON:
        '{"workspace_id":"3","workspace_cwd":"/ws","focused_pane_id":"3-1"}',
    },
    "/opt/collie",
  );

  expect(env.pluginRoot).toBe("/opt/collie");
  expect(env.stateDir).toBe("/home/x/.local/state/herdr/plugins/cego.collie");
  expect(env.cwd).toBe(process.cwd());
  expect(env.collieDir).toBe("/home/x/.collie");
  expect(env.userDir).toBe("/home/x/.collie/user");
});

test("a downloaded compiled runner upgrades the Collie installation, not the caller's checkout", () => {
  const cached = "/state/runners/1.0.18/collie-linux-x64";
  const root = ownRoot("/$bunfs/root/main", cached, "/srv/collie");
  expect(root).toBe("/srv/collie/release");
  expect(
    readEnv(
      {
        HOME: "/home/x",
        COLLIE_DIR: "/srv/collie",
        HERDR_PLUGIN_ROOT: "/obsolete",
        PWD: "/unrelated/checkout",
      },
      root,
    ).pluginRoot,
  ).toBe("/srv/collie/release");
  expect(ownRoot("/src/env.ts", "/bin/bun", "/srv/collie")).toBeNull();
});

test("the user directory is the Collie directory's, wherever the plugin root is", () => {
  const env = readEnv({
    HOME: "/home/x",
    COLLIE_ROOT: "/home/x/.collie/release",
    COLLIE_DIR: "/srv/collie",
  });

  expect(env.collieDir).toBe("/srv/collie");
  expect(env.userDir).toBe("/srv/collie/user");
  expect(readEnv({ HOME: "/home/x", COLLIE_USER_DIR: "/mine" }).userDir).toBe("/mine");
});

test("a host drops every retired Herdr variable before spawning a process", () => {
  expect(
    withoutHerdrOne({
      HERDR_PLUGIN_ROOT: "/old/root",
      HERDR_PLUGIN_STATE_DIR: "/old/state",
      HERDR_SOCKET_PATH: "/old/socket",
      HERDR_ACTIVE_PANE_CWD: "/old/cwd",
      COLLIE_ROOT: "/opt/collie",
      COLLIE_STATE_DIR: "/state",
      HC_SOCKET: "/core/socket",
      PATH: "/bin",
    }),
  ).toEqual({
    COLLIE_ROOT: "/opt/collie",
    COLLIE_STATE_DIR: "/state",
    HC_SOCKET: "/core/socket",
    PATH: "/bin",
  });
});

test("COLLIE_CWD is remembered as explicit; an inferred cwd is not", () => {
  const explicit = readEnv({ HOME: "/home/x", COLLIE_CWD: "/named/dir" });
  expect(explicit.cwd).toBe("/named/dir");
  expect(explicit.cwdExplicit).toBe(true);

  const inferred = readEnv({
    HOME: "/home/x",
    PWD: "/stale/workspace",
  });
  expect(inferred.cwd).toBe(process.cwd());
  expect(inferred.cwdExplicit).toBe(false);
});

test("a process that leaves the launcher starts children without its preload, keeping the rest", () =>
  runEffect(
    Effect.gen(function* () {
      for (const [name, value] of [
        ["LD_PRELOAD", "./libcef.so:/opt/mine.so"],
        ["ELECTROBUN_LAUNCHER_PID", "4242"],
      ] as const) {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const was = Bun.env[name];
            Bun.env[name] = value;
            return was;
          }),
          (was) =>
            Effect.sync(() => {
              if (was === undefined) delete Bun.env[name];
              else Bun.env[name] = was;
            }),
        );
      }
      leaveLauncher();
      const said = yield* Effect.promise(() => Bun.$`env`.text());
      expect(said).toContain("LD_PRELOAD=/opt/mine.so\n");
      expect(said).not.toContain("ELECTROBUN_LAUNCHER_PID");
      expect(said).toContain(`HOME=${Bun.env.HOME}\n`);
    }).pipe(Effect.scoped),
  ));
