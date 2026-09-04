import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { decodeAgentList, decodeWorkspaceList, Herdr } from "../src/herdr";
import { workspaceCwdFromPanes } from "../src/operations";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("where herdr keeps worktrees is its config's answer, or its own default", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const herdr = new Herdr(rig.pluginEnv());

      // No config at all, and a config that says nothing about worktrees: herdr's own
      // default either way, which is the path its "open worktree" UI looks in.
      expect(yield* herdr.worktreesDirectory()).toBe(path.join(rig.root, ".herdr", "worktrees"));
      const config = path.join(rig.root, ".config", "herdr");
      yield* fs.makeDirectory(config, { recursive: true });
      yield* fs.writeFileString(path.join(config, "config.toml"), "[ui]\ntheme = 'x'\n");
      expect(yield* herdr.worktreesDirectory()).toBe(path.join(rig.root, ".herdr", "worktrees"));

      yield* fs.writeFileString(
        path.join(config, "config.toml"),
        `[worktrees]\ndirectory = "${path.join(rig.root, "elsewhere")}"\n`,
      );
      expect(yield* herdr.worktreesDirectory()).toBe(path.join(rig.root, "elsewhere"));

      // A config herdr itself would reject is not a reason to fail a run start.
      yield* fs.writeFileString(path.join(config, "config.toml"), "[worktrees\n");
      expect(yield* herdr.worktreesDirectory()).toBe(path.join(rig.root, ".herdr", "worktrees"));
      // Nothing was asked of herdr: there is no command for this.
      expect(yield* rig.cmds()).toEqual([]);
    }),
  ));

test("HERDR_CONFIG_PATH moves the config herdr reads, so it moves this answer too", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The default location says one thing; the config herdr was actually started
      // with says another. herdr honours the override, so a checkout put at the
      // default would be somewhere herdr never configured and would not appear in its
      // own "open worktree" list.
      const config = path.join(rig.root, ".config", "herdr");
      yield* fs.makeDirectory(config, { recursive: true });
      yield* fs.writeFileString(
        path.join(config, "config.toml"),
        `[worktrees]\ndirectory = "${path.join(rig.root, "ignored")}"\n`,
      );
      const elsewhere = path.join(rig.root, "elsewhere.toml");
      yield* fs.writeFileString(
        elsewhere,
        `[worktrees]\ndirectory = "${path.join(rig.root, "honoured")}"\n`,
      );

      const overridden = new Herdr(rig.pluginEnv({ HERDR_CONFIG_PATH: elsewhere }));
      expect(yield* overridden.worktreesDirectory()).toBe(path.join(rig.root, "honoured"));

      // And an override pointing at nothing falls back to herdr's default rather than
      // to the config file the override said to ignore.
      const missing = new Herdr(
        rig.pluginEnv({ HERDR_CONFIG_PATH: path.join(rig.root, "gone.toml") }),
      );
      expect(yield* missing.worktreesDirectory()).toBe(path.join(rig.root, ".herdr", "worktrees"));
    }),
  ));

test("cli calls are recorded with their full argv and return parsed json", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());

      const tab = yield* herdr.tabCreate({ label: "plan/goal", cwd: rig.projectDir });

      expect(tab).toEqual({ tabId: "1:1", paneId: "1-1" });
      expect(yield* rig.calls()).toEqual([
        {
          transport: "cli",
          cmd: "tab create",
          argv: [
            "tab",
            "create",
            "--workspace",
            "1",
            "--cwd",
            rig.projectDir,
            "--label",
            "plan/goal",
            "--no-focus",
          ],
        },
      ]);
    }),
  ));

test("agent start passes harness kind and model args after the separator", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());

      yield* herdr.agentStart({
        name: "build",
        kind: "claude",
        paneId: "1-2",
        args: ["--model", "sonnet"],
      });

      const calls = yield* rig.calls();
      expect(calls.at(0)?.argv).toEqual([
        "agent",
        "start",
        "build",
        "--kind",
        "claude",
        "--pane",
        "1-2",
        "--",
        "--model",
        "sonnet",
      ]);
    }),
  ));

test("socket calls are recorded in the same ordered log as cli calls", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());

      yield* herdr.tabCreate({ label: "a" });
      yield* herdr.agentViewSet("run-1", "run 1", ["1-2", "1-3"]);
      yield* herdr.notify("done");
      yield* herdr.agentViewClear("run-1");

      expect(yield* rig.cmds()).toEqual([
        "tab create",
        "agent.view.set",
        "notification show",
        "agent.view.clear",
      ]);
      const calls = yield* rig.calls();
      expect(calls.at(1)?.params).toEqual({
        source: "run-1",
        label: "run 1",
        filter: { op: "in", field: "pane_id", values: ["1-2", "1-3"] },
      });
    }),
  ));

test("a failing herdr command surfaces its stderr", () => {
  const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"agent start":"no such pane"}' }));

  return expect(
    runEffect(herdr.agentStart({ name: "build", kind: "claude", paneId: "9-9" })),
  ).rejects.toThrow("herdr agent start failed (exit 1)");
});

test("a method with no socket to reach fails as a typed HerdrError", () =>
  runEffect(
    Effect.gen(function* () {
      // The socket client is Effect's Unix client now; its failures still have to
      // arrive as this module's own error rather than escaping as a defect.
      const herdr = new Herdr({ ...rig.pluginEnv(), socketPath: null });
      const failure = yield* Effect.result(herdr.agentViewClear("run-1"));

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect(failure.failure._tag).toBe("HerdrError");
    }),
  ));

test("the herdr subprocess inherits this process's environment", () =>
  runEffect(
    Effect.gen(function* () {
      // The CLI boundary spawns through ChildProcessSpawner with extendEnv, so herdr
      // sees PATH and the rest; passing only the plugin's own keys would leave it
      // without one. The fake herdr reads its own configuration from that environment,
      // so a call that works at all is that inheritance working.
      const herdr = new Herdr(rig.pluginEnv());
      expect(yield* herdr.tabCreate({ label: "inherits" })).toBeTruthy();
      expect(yield* rig.cmds()).toEqual(["tab create"]);
    }),
  ));

test("malformed herdr replies fail at the boundary", () =>
  runEffect(
    Effect.gen(function* () {
      class MalformedHerdr extends Herdr {
        protected override exec() {
          return Effect.succeed({
            code: 0,
            stdout: '{"result":{"workspaces":[{}]}}',
            stderr: "",
          });
        }
      }

      const failure = yield* Effect.result(new MalformedHerdr(rig.pluginEnv()).workspaceList());

      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure") expect(failure.failure._tag).toBe("HerdrError");
    }),
  ));

test("workspace replies may omit a working directory", () =>
  runEffect(
    Effect.gen(function* () {
      class CurrentHerdr extends Herdr {
        protected override exec() {
          return Effect.succeed({
            code: 0,
            stdout: '{"result":{"workspaces":[{"workspace_id":"wT","label":"Collie"}]}}',
            stderr: "",
          });
        }
      }

      expect(yield* new CurrentHerdr(rig.pluginEnv()).workspaceList()).toEqual([
        { workspaceId: "wT", label: "Collie", cwd: "", worktree: null },
      ]);
    }),
  ));

test("a pane tail comes back as text even when the pane is showing JSON", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_PANE_TEXT: "plain output" }));
      expect(yield* herdr.paneRead("1-1")).toContain("plain output");

      // A pane showing this plugin's own output starts with `{`, which the CLI
      // boundary parses as a reply. Liveness only needs a sample of what the pane
      // holds, and losing the tail there would leave an agent judged on its status.
      const json = new Herdr(rig.pluginEnv({ FAKE_HERDR_PANE_TEXT: `{"ok":true}` }));
      expect(yield* json.paneRead("1-1")).toContain("ok");
    }),
  ));

test("a workspace with no directory of its own takes it from its first pane", () => {
  const panes = [
    { workspaceId: "wA", cwd: "/elsewhere" },
    { workspaceId: "wB", cwd: null },
    { workspaceId: "wB", cwd: "/home/user/project" },
  ];
  expect(workspaceCwdFromPanes("wB", panes)).toBe("/home/user/project");
  // No pane knows: empty, so the caller's own fallback chain decides.
  expect(workspaceCwdFromPanes("wC", panes)).toBe("");
});

test("a worktree-backed workspace decodes, and its checkout is its directory", () =>
  runEffect(
    Effect.gen(function* () {
      const list = yield* decodeWorkspaceList({
        id: "cli:workspace:list",
        result: {
          type: "workspace_list",
          workspaces: [
            { workspace_id: "w1", label: "plain" },
            {
              workspace_id: "w2",
              label: "collie",
              worktree: {
                checkout_path: "/home/u/.herdr/worktrees/collie/feature",
                is_linked_worktree: true,
                repo_key: "/home/u/collie/.git",
                repo_name: "collie",
                repo_root: "/home/u/collie",
              },
            },
          ],
        },
      });

      expect(list.map((w) => w.cwd)).toEqual(["", "/home/u/.herdr/worktrees/collie/feature"]);
      expect(list[1]!.worktree).toBe("/home/u/.herdr/worktrees/collie/feature");
    }),
  ));

test("the worktree list is read as branch, checkout and the workspace holding it", () =>
  runEffect(
    Effect.gen(function* () {
      class ListingHerdr extends Herdr {
        protected override exec() {
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              result: {
                type: "worktree_list",
                // The repository's own checkout, which is where a command about the
                // repository has to run: any of the others may be removed under it.
                source: { source_checkout_path: "/repo", repo_root: "/repo" },
                worktrees: [
                  { branch: "master", path: "/repo", open_workspace_id: "wT" },
                  { branch: "add-picker", path: "/wt/add-picker" },
                ],
              },
            }),
            stderr: "",
          });
        }
      }

      expect(yield* new ListingHerdr(rig.pluginEnv()).worktreeList("/repo")).toEqual({
        worktrees: [
          { branch: "master", path: "/repo", workspaceId: "wT" },
          { branch: "add-picker", path: "/wt/add-picker", workspaceId: null },
        ],
        source: "/repo",
      });
    }),
  ));

test("creating a worktree answers with its checkout and its new workspace", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      const made = yield* herdr.worktreeCreate({
        cwd: "/repo",
        branch: "add-picker",
        base: "origin/master",
        label: "⚙ implement · add-picker",
      });

      expect(made.branch).toBe("add-picker");
      expect(made.path).toContain("add-picker");
      // The new workspace's own numbered shell tab, which the run reuses for its first
      // agent rather than leaving it behind beside the run's tabs.
      expect(made.rootTab).toEqual({ tabId: "1:1", paneId: "1-1" });
      expect(yield* rig.calls()).toEqual([
        {
          transport: "cli",
          cmd: "worktree create",
          argv: [
            "worktree",
            "create",
            "--cwd",
            "/repo",
            "--branch",
            "add-picker",
            "--base",
            "origin/master",
            "--label",
            "⚙ implement · add-picker",
            "--no-focus",
          ],
        },
      ]);
    }),
  ));

test("a create that answers with no root pane still gives the run its checkout", () =>
  runEffect(
    Effect.gen(function* () {
      // herdr describes `worktree_created` twice — with the shell tab and its pane, and
      // without them — so a reply carrying neither is as legal as one carrying both.
      // Requiring them refused the Run its checkout over a tab it can do without: no
      // tab to take over is the old cosmetic bug, not a reason to refuse to start.
      class NoRootPaneHerdr extends Herdr {
        protected override exec() {
          return Effect.succeed({
            code: 0,
            stdout: JSON.stringify({
              result: {
                type: "worktree_created",
                worktree: { path: "/w/add-picker", branch: "add-picker" },
                workspace: { workspace_id: "w1" },
                tab: { tab_id: "1:1" },
              },
            }),
            stderr: "",
          });
        }
      }

      const made = yield* new NoRootPaneHerdr(rig.pluginEnv()).worktreeCreate({
        cwd: "/repo",
        branch: "add-picker",
      });

      expect(made.workspaceId).toBe("w1");
      expect(made.branch).toBe("add-picker");
      // Nothing to take over, so the run opens its own tab as it always did.
      expect(made.rootTab).toBeNull();
    }),
  ));

test("opening an existing checkout brings no root tab of its own", () =>
  runEffect(
    Effect.gen(function* () {
      // `worktree open` reuses a workspace, so there is no fresh shell tab to take
      // over: the run opens its tabs as it always did.
      const herdr = new Herdr(rig.pluginEnv());
      yield* rig.addWorktree("add-picker", `${rig.root}/worktrees/add-picker`, "w9");

      const opened = yield* herdr.worktreeOpen({
        cwd: "/repo",
        path: `${rig.root}/worktrees/add-picker`,
      });

      expect(opened.workspaceId).toBe("w9");
      expect(opened.rootTab).toBeNull();
    }),
  ));

test("removing a worktree names its workspace and never forces", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      yield* herdr.worktreeRemove("w1P");

      const calls = yield* rig.calls();
      expect(calls.at(0)?.argv).toEqual(["worktree", "remove", "--workspace", "w1P"]);
    }),
  ));

test("an agent's terminal title decodes, and an agent without one has none", () =>
  runEffect(
    Effect.gen(function* () {
      const list = yield* decodeAgentList({
        id: "cli:agent:list",
        result: {
          type: "agent_list",
          agents: [
            {
              name: "impl-1",
              pane_id: "1-2",
              agent_status: "working",
              terminal_title: "◐ Simplify cego.collie plugin",
            },
            { name: "rev-1", pane_id: "1-3", agent_status: "idle" },
            {
              name: "impl-2",
              pane_id: "1-4",
              agent_status: "working",
              terminal_title: "◐ [Fix] the parser",
            },
            {
              name: "impl-3",
              pane_id: "1-5",
              agent_status: "working",
              terminal_title: "[Fix] the parser",
            },
          ],
        },
      });

      // The glyph herdr prefixes is its own spinner, not part of what the agent said.
      expect(list[0]!.title).toBe("Simplify cego.collie plugin");
      expect(list[1]!.title).toBeNull();
      // And only the spinner: a title that starts with punctuation of its own keeps it.
      expect(list[2]!.title).toBe("[Fix] the parser");
      expect(list[3]!.title).toBe("[Fix] the parser");
    }),
  ));
