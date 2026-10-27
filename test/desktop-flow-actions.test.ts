import { expect, test } from "bun:test";
import {
  desktopFlowAction,
  desktopLaneAction,
  nextMove,
  retryCaption,
} from "../desktop/src/shared/flow-actions";
import { flowNode, mainFlow } from "./support/flow";
import { nodeName } from "../desktop/src/shared/flow";
import type { FlowAction } from "../src/board-model";

const lane = mainFlow().lanes[1]!;
const node = (kind: FlowAction) =>
  flowNode("build", {
    title: "Build",
    state: "running",
    agent: "builder-1",
    primary: kind,
    actions: [],
    questions: [
      {
        name: "go",
        id: "choice-1",
        open: true,
        asked: null,
        answered: null,
        by: null,
        text: "Ship?",
        options: [],
      },
    ],
    url: "https://forge/mr/1",
  });

test.each([
  [
    "retry",
    "Retry Build",
    { kind: "write", installation: "vm-id", write: { _tag: "Resume", runId: "build-run" } },
  ],
  [
    "answer",
    "Answer",
    {
      kind: "answer",
      installation: "vm-id",
      write: { _tag: "Answer", runId: "build-run", decision: "choice-1", value: "" },
    },
  ],
  [
    "continue",
    "Continue",
    {
      kind: "write",
      installation: "vm-id",
      write: { _tag: "Control", runId: "build-run", control: "hold", set: false },
    },
  ],
  [
    "tell",
    "Tell the builder…",
    {
      kind: "text",
      installation: "vm-id",
      write: { _tag: "Deliver", runId: "build-run", agent: "builder-1", text: "" },
    },
  ],
  ["terminal", "Watch the builder", { kind: "terminal", run: "build-run", agent: "builder-1" }],
  ["open", "Open MR", { kind: "url", url: "https://forge/mr/1" }],
  ["start", "Build", { kind: "offer", run: "build-run", offer: "build" }],
  ["log", "Log", { kind: "part", run: "build-run", part: "log" }],
  ["evidence", "Evidence", { kind: "part", run: "build-run", part: "evidence" }],
] as const)("%s has its label and route on the lane's installation", (kind, label, effect) => {
  const shown = desktopFlowAction(kind, node(kind), lane, "vm-id", true)!;
  expect(shown.label).toBe(label);
  expect(shown.effect).toMatchObject(effect);
  expect(shown.icon).toStartWith("i-lucide-");
});

test("proposal, pipeline and Run links keep their exact targets", () => {
  const proposal = { kind: "proposal" as const, id: "p", hash: "h", text: "Review", actions: [] };
  expect(
    desktopFlowAction("proposal", { ...node("proposal"), proposal }, lane, "vm-id", true)?.effect,
  ).toMatchObject({
    kind: "proposal",
    installation: "vm-id",
    confirm: { _tag: "Confirm", proposal: "p", hash: "h" },
    decline: { _tag: "Decline", proposal: "p", hash: "h" },
  });
  expect(
    desktopFlowAction("open", { ...node("open"), id: "ci", kind: "release" }, lane, "vm-id", true)
      ?.label,
  ).toBe("Open pipeline");
  expect(
    desktopFlowAction(
      "open",
      {
        ...node("open"),
        title: "Investigate on vm",
        link: { run: "child", machine: "vm", state: "running", said: null },
      },
      lane,
      "vm-id",
      true,
    ),
  ).toMatchObject({
    label: "Open Investigate on vm",
    effect: { kind: "run", run: "child", machine: "vm" },
  });
});

test.each([
  ["hold", "Hold run", { _tag: "Control", control: "hold", set: true }],
  ["release", "Release hold", { _tag: "Control", control: "hold", set: false }],
  ["stop", "Stop run", { _tag: "Control", control: "stop", set: true }],
  ["resume", "Resume", { _tag: "Resume" }],
  ["follow-up", "Follow-up run", { _tag: "FollowUp", text: "" }],
] as const)("a lane's %s uses its own Run", (kind, label, write) => {
  expect(desktopLaneAction(kind, { ...lane, actions: [kind] }, "vm-id", true)).toMatchObject({
    label,
    effect: { installation: "vm-id", write: { ...write, runId: "build-run" } },
  });
});

test("Retry names the Steps it keeps, shortening after three", () => {
  const checks = flowNode("checks", { title: "Checks", state: "failed" });
  expect(
    retryCaption(
      {
        ...lane,
        nodes: [
          flowNode("build", { state: "done" }),
          flowNode("review", { state: "done" }),
          checks,
        ],
      },
      checks,
    ),
  ).toBe("Keeps Build and Review and runs Checks again.");
  expect(
    retryCaption(
      {
        ...lane,
        nodes: ["grill", "spec", "tickets", "build", "review"].map((id) =>
          flowNode(id, { state: "done" }),
        ),
      },
      checks,
    ),
  ).toBe("Keeps Grill and 4 more and runs Checks again.");
});

test("the next move is the current node's primary, and saved Flows offer no action", () => {
  const base = mainFlow();
  const flow = {
    ...base,
    lanes: base.lanes.map((row) => ({
      ...row,
      nodes: row.nodes.map((one) =>
        one.id === "build" ? { ...one, primary: "terminal" as const } : one,
      ),
    })),
  };
  expect(nextMove(flow)).toMatchObject({
    run: "build-run",
    node: { id: "build" },
    action: "terminal",
  });
  expect(desktopFlowAction("terminal", node("terminal"), lane, "vm-id", false)).toBeNull();
  expect(desktopLaneAction("hold", { ...lane, actions: ["hold"] }, "vm-id", false)).toBeNull();
  expect(
    nodeName(flowNode("build", { state: "running", said: "Slice 4 of 6" }), {
      action: "Watch the builder",
    }),
  ).toBe("Build, running, Slice 4 of 6, Watch the builder");
});
