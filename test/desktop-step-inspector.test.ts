import { expect, test } from "bun:test";
import type { FlowRun, VerificationView } from "../src/board-model";
import {
  type InspectorPart,
  inspectorPart,
  inspectorParts,
  shownPart,
  stepEvidence,
  stepLines,
} from "../desktop/src/shared/step-inspector";
import { flowNode } from "./support/flow";

test("a Step's Log is bounded by the next Step's start line", () => {
  expect(
    stepLines(
      {
        _tag: "Text",
        text: "first\n── First ──\na\n── Second ──\nb\nc\n── Third ──\nd\n",
        truncated: false,
      },
      1,
      4,
      [2, 4, 7],
    ),
  ).toEqual({
    panel: { _tag: "Text", text: "── Second ──\nb\nc\n", truncated: false },
    count: 3,
    older: null,
  });
});
test("a tail beginning inside a Step shows what it holds and says where earlier lines went", () => {
  expect(
    stepLines({ _tag: "Text", text: "b\nc\n── Third ──\nd\n", truncated: true }, 5, 4, [2, 4, 7]),
  ).toEqual({
    panel: { _tag: "Text", text: "b\nc\n", truncated: true },
    count: 2,
    older: "Earlier lines are older than the log shown.",
  });
});
test("the Step's evidence excludes other Steps and narrows to a picked Slice", () => {
  const check = (id: string, step?: string, item?: string): VerificationView => ({
    id,
    name: id,
    result: "pass",
    expect: "pass",
    exit: 0,
    at: "then",
    by: "agent",
    step,
    place: item === undefined ? null : { item, items: ["01", "02"] },
  });
  const checks = [
    check("a", "build", "01"),
    check("b", "build", "02"),
    check("c", "review"),
    check("legacy"),
  ];
  expect(stepEvidence(checks, "build", null)?.map((one) => one.id)).toEqual(["a", "b"]);
  expect(
    stepEvidence(checks, "build", flowNode("build@02", { place: "02" }))?.map((one) => one.id),
  ).toEqual(["b"]);
});
test.each<[string, Partial<FlowRun>, boolean, InspectorPart]>([
  [
    "question",
    { questions: [{ name: "go", open: true, asked: null, answered: null, by: null }] },
    false,
    "decision",
  ],
  ["proposal", { wait: "proposal" }, false, "decision"],
  ["agent at work", { state: "running" }, true, "terminal"],
  ["stalled", { state: "needs-you", wait: "stalled" }, true, "terminal"],
  ["parked", { state: "waiting", wait: "parked" }, true, "terminal"],
  ["usage wait", { state: "waiting", wait: "usage" }, true, "terminal"],
  ["failed", { state: "failed" }, false, "why"],
  ["check", { kind: "check" }, false, "evidence"],
  ["produces evidence", { produces: "evidence" }, false, "evidence"],
  ["has Log", { log: 3 }, false, "log"],
  ["expected", {}, false, "details"],
])("the inspector opens on %s", (_title, node, live, part) =>
  expect(inspectorPart(flowNode("work", node), live)).toBe(part),
);
test("parts are offered with their counts only while they have something", () => {
  expect(inspectorParts(flowNode("work", { log: 1 }), true, 42, 3)).toEqual([
    { value: "terminal", label: "Terminal" },
    { value: "log", label: "Log · 42" },
    { value: "evidence", label: "Evidence · 3" },
  ]);
  expect(inspectorParts(flowNode("work"), false, 0, 0)).toEqual([]);
});
test("a Step opened on why it failed or its question shows its first part beneath that", () => {
  const parts = inspectorParts(flowNode("work", { log: 1 }), false, 4, 2);
  expect(shownPart("why", parts)).toBe("log");
  expect(shownPart("decision", parts)).toBe("log");
  expect(shownPart("evidence", parts)).toBe("evidence");
  expect(shownPart("details", [])).toBe("details");
});
