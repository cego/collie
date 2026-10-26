import { expect, test } from "bun:test";
import { stepTiming } from "../desktop/src/shared/step-timing";
import { inspectorOf } from "../desktop/src/shared/flow";
import { nextMove } from "../desktop/src/shared/flow-actions";
import { flowNode, mainFlow } from "./support/flow";
import { epochMs } from "../src/time";

test("the inspector and hover describe elapsed and usual time, including an expected Step", () => {
  const start = "2026-10-23T09:00:00Z";
  const now = epochMs("2026-10-23T09:09:00Z");
  const node = flowNode("review", { state: "running", started: start, usual: 720_000 });
  expect(stepTiming(node, now)).toBe("9 min so far, usually 12");
  expect(stepTiming(flowNode("next", { usual: 120_000 }), now)).toBe("usually 2 min");
  const flow = { ...mainFlow(), lanes: [{ ...mainFlow().lanes[1]!, nodes: [node] }] };
  expect(inspectorOf(flow, { run: "build-run", node: "review", item: null }, now)?.lines).toContain(
    "9 min so far, usually 12",
  );
});

test("the warning keeps the current Step's primary action", () => {
  const flow = {
    ...mainFlow(),
    notice: "Review is taking longer than usual: 25 min, usually 12.",
    current: { run: "build-run", node: "review" },
    lanes: [
      { ...mainFlow().lanes[1]!, nodes: [flowNode("review", { long: true, primary: "terminal" })] },
    ],
  };
  expect(nextMove(flow)).toMatchObject({
    notice: flow.notice,
    action: "terminal",
    node: { id: "review" },
  });
});
