import type { FlowRun } from "../../../src/board-model";

export const stepSteering = (node: FlowRun) => {
  const notes = node.notes ?? [];
  const unread = notes.filter((one) => one.read === null).length;
  return {
    pause: node.pause == null ? null : `Pauses before ${node.title}, as ${node.pause.by} asked`,
    badge: unread === 0 ? null : `${unread} ${unread === 1 ? "note" : "notes"}`,
    notes,
    retryText: node.why ?? "",
  };
};
