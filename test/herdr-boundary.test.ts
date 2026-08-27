import { afterEach, beforeEach, expect, test } from "bun:test";
import { Herdr } from "../src/herdr";
import { Rig } from "./support/recorder";

let rig: Rig;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
});

afterEach(async () => {
  await rig.close();
});

test("cli calls are recorded with their full argv and return parsed json", async () => {
  const herdr = new Herdr(rig.pluginEnv());

  const tab = await herdr.tabCreate({ label: "plan/goal", cwd: rig.projectDir });

  expect(tab).toEqual({ tabId: "1:1", paneId: "1-1" });
  expect(rig.calls()).toEqual([
    {
      transport: "cli",
      cmd: "tab create",
      argv: ["tab", "create", "--workspace", "1", "--cwd", rig.projectDir, "--label", "plan/goal", "--no-focus"],
    },
  ]);
});

test("agent start passes harness kind and model args after the separator", async () => {
  const herdr = new Herdr(rig.pluginEnv());

  await herdr.agentStart({ name: "build", kind: "claude", paneId: "1-2", args: ["--model", "sonnet"] });

  expect(rig.calls()[0]!.argv).toEqual([
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
});

test("socket calls are recorded in the same ordered log as cli calls", async () => {
  const herdr = new Herdr(rig.pluginEnv());

  await herdr.tabCreate({ label: "a" });
  await herdr.agentViewSet("run-1", "run 1", ["1-2", "1-3"]);
  await herdr.notify("done");
  await herdr.agentViewClear("run-1");

  expect(rig.cmds()).toEqual(["tab create", "agent.view.set", "notification show", "agent.view.clear"]);
  expect(rig.calls()[1]!.params).toEqual({
    source: "run-1",
    label: "run 1",
    filter: { op: "in", field: "pane_id", values: ["1-2", "1-3"] },
  });
});

test("a failing herdr command surfaces its stderr", async () => {
  const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: JSON.stringify({ "agent start": "no such pane" }) }));

  await expect(
    herdr.agentStart({ name: "build", kind: "claude", paneId: "9-9" }),
  ).rejects.toThrow("herdr agent start failed (exit 1)");
});
