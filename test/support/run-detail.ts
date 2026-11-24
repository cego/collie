import type { RunDetail } from "../../src/board-model";
import { NO_RUN_OUTCOME } from "../../src/views";

export function runDetail(over: Partial<RunDetail> = {}) {
  const returned: RunDetail = {
    id: "r1",
    dir: "/state/runs/r1",
    title: "Selected Run",
    status: "running",
    inputs: [],
    steps: [],
    handoffs: [],
    intent: null,
    review: { _tag: "None", reason: "none" },
    plan: null,
    outputs: [],
    tail: null,
    attention: { category: "none", reason: "running", explanation: "", actions: [] },
    outcome: NO_RUN_OUTCOME,
    finishedAt: 0,
    mr: null,
    findings: [],
    verifications: [],
    steering: [],
    evidence: [],
    diff: null,
    ...over,
  };
  return returned;
}
