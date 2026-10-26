import { expect, test } from "bun:test";
import { stepSteering } from "../desktop/src/shared/step-steering";
import { desktopFlowAction } from "../desktop/src/shared/flow-actions";
import { flowNode, mainFlow } from "./support/flow";
import { flowActions } from "../src/board-model";
import { task } from "./support/task";

test("a current Step offers a pause before the next expected Step and retry offers a note", () => {
  const flow = mainFlow();
  const lane = flow.lanes[1]!;
  const build = flowNode("build", { state: "running" });
  const review = flowNode("review", { title: "Review", state: "expected" });
  const drawn = flowActions(
    { ...flow, lanes: [{ ...lane, nodes: [build, review] }] },
    task({ run: lane.run }),
    new Map([[lane.run, { canResume: true, held: false, proposal: null }]]),
  );
  expect(drawn.lanes[0]!.nodes[0]).toMatchObject({
    pauseTarget: "review",
    actions: expect.arrayContaining(["pause", "note"]),
  });
  expect(drawn.lanes[0]!.nodes[1]!.actions).toContain("pause");
  const failed = flowActions(
    { ...flow, lanes: [{ ...lane, nodes: [{ ...build, state: "failed" }] }] },
    task({ run: lane.run }),
    new Map([[lane.run, { canResume: true, held: false, proposal: null }]]),
  );
  expect(failed.lanes[0]!.nodes[0]!.actions).toContain("retry-noted");
});

test("the pause mark, unread badge, note list and retry text belong to the selected Step", () => {
  const note = {
    id: "n1",
    by: "reviewer-1",
    at: "2026-01-01T00:00:00Z",
    text: "Check ordering",
    read: null,
  };
  const node = flowNode("b", {
    title: "B",
    pause: { by: "mk", at: note.at },
    notes: [note, { ...note, id: "n0", read: note.at }],
    why: "unit: expected 2, got 1",
  });
  expect(stepSteering(node)).toEqual({
    pause: "Pauses before B, as mk asked",
    badge: "1 note",
    notes: node.notes!,
    retryText: "unit: expected 2, got 1",
  });
  expect(stepSteering(flowNode("a"))).toEqual({
    pause: null,
    badge: null,
    notes: [],
    retryText: "",
  });
});

test("pause, note and retry with a note keep the lane's Run and exact Step", () => {
  const lane = mainFlow().lanes[1]!;
  const node = flowNode("b", {
    title: "B",
    state: "failed",
    actions: ["pause", "note", "retry-noted"],
    why: "unit failed",
  });
  expect(desktopFlowAction("pause", node, lane, "vm-id", true)).toMatchObject({
    label: "Pause before B",
    effect: { write: { _tag: "Control", before: "b", set: true } },
  });
  expect(
    desktopFlowAction("pause", { ...node, pause: { by: "mk", at: "now" } }, lane, "vm-id", true),
  ).toMatchObject({ label: "Don't pause", effect: { write: { before: "b", set: false } } });
  expect(desktopFlowAction("note", node, lane, "vm-id", true)).toMatchObject({
    effect: { kind: "text", write: { _tag: "Deliver", runId: lane.run, step: "b" } },
  });
  expect(desktopFlowAction("retry-noted", node, lane, "vm-id", true)).toMatchObject({
    effect: { kind: "text", write: { step: "b" }, initial: "unit failed", retry: lane.run },
  });
});

test("a note on an inspected round addresses its Step rather than its round key", () => {
  const round = flowNode("review#2", {
    title: "Review",
    state: "failed",
    actions: ["note", "retry-noted"],
  });
  const lane = { ...mainFlow().lanes[1]!, nodes: [flowNode("review", { runs: [round] })] };
  expect(desktopFlowAction("note", round, lane, "vm-id", true)?.effect).toMatchObject({
    write: { step: "review" },
  });
});
