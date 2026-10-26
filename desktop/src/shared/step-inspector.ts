import type { FlowRun, Panel, VerificationView } from "../../../src/board-model";
export type InspectorPart = "decision" | "terminal" | "why" | "evidence" | "log" | "details";
export interface StepLog {
  readonly panel: Panel | null;
  readonly count: number;
  readonly older: string | null;
}
export const stepLines = (
  tail: Panel | null,
  first: number,
  start: number | null | undefined,
  starts: ReadonlyArray<number>,
): StepLog => {
  if (tail?._tag !== "Text" || start == null) return { panel: null, count: 0, older: null };
  const all = tail.text === "" ? [] : tail.text.replace(/\n$/, "").split("\n");
  const next = starts
    .filter((line) => line > start)
    .reduce((one, other) => Math.min(one, other), Infinity);
  const lines = all.slice(Math.max(0, start - first), Math.max(0, next - first));
  const older = first > start ? "Earlier lines are older than the log shown." : null;
  return {
    panel: {
      _tag: "Text",
      text: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      truncated: older !== null,
    },
    count: lines.length,
    older,
  };
};
export const stepEvidence = (
  checks: ReadonlyArray<VerificationView>,
  step: string,
  picked: FlowRun | null,
): ReadonlyArray<VerificationView> =>
  checks.filter((one) => {
    if (one.step !== step) return false;
    if (picked === null) return true;
    const place =
      one.place == null ? null : "item" in one.place ? one.place.item : `Round ${one.place.round}`;
    return place === picked.place;
  });
export const inspectorPart = (node: FlowRun, live: boolean): InspectorPart => {
  if (node.wait === "proposal" || node.questions.some((one) => one.open ?? one.answered === null))
    return "decision";
  if (
    live &&
    (node.state === "running" ||
      node.wait === "stalled" ||
      node.wait === "parked" ||
      node.wait === "usage")
  )
    return "terminal";
  if (node.state === "failed") return "why";
  if (node.kind === "check" || node.produces === "evidence") return "evidence";
  return node.log == null ? "details" : "log";
};
/** What the work pane shows: the part chosen where it has a tab, else the first that does. */
export const shownPart = (
  chosen: InspectorPart,
  parts: ReadonlyArray<InspectorTab>,
): InspectorPart =>
  parts.some((one) => one.value === chosen) ? chosen : (parts[0]?.value ?? chosen);
/** The work pane's words for a Step with no terminal, log or evidence. */
export const quietWork = (node: FlowRun) =>
  node.state === "expected"
    ? "This Step has not started yet."
    : "This Step left no terminal, log or evidence to show here.";
export interface InspectorTab {
  readonly value: InspectorPart;
  readonly label: string;
}
export const inspectorParts = (
  node: FlowRun,
  live: boolean,
  logs: number,
  proofs: number,
): ReadonlyArray<InspectorTab> => {
  const parts: InspectorTab[] = [];
  if (live) parts.push({ value: "terminal", label: "Terminal" });
  if (node.log != null) parts.push({ value: "log", label: `Log · ${logs}` });
  if (proofs > 0) parts.push({ value: "evidence", label: `Evidence · ${proofs}` });
  return parts;
};
