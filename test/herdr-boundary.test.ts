import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeWorkspaceList, Herdr } from "../src/herdr";
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
