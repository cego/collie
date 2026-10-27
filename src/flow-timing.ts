import type { FlowRun } from "./board-model";
import { epochMs } from "./time";

export const stepElapsed = (
  node: FlowRun & { readonly runs?: ReadonlyArray<FlowRun> },
  now: number,
): number => {
  const active = node.runs?.findLast((one) => one.state === "running") ?? node;
  return active.started === null ? 0 : Math.max(0, now - epochMs(active.started));
};
