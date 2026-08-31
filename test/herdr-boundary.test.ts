import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Herdr } from "../src/herdr";
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
