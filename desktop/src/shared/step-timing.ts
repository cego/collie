import type { FlowRun } from "../../../src/board-model";
import { stepElapsed } from "../../../src/flow-timing";
import { epochMs, minutes } from "../../../src/time";
export const stepTiming = (
  node: FlowRun & { readonly runs?: ReadonlyArray<FlowRun> },
  now: number,
): string | null => {
  if (node.started === null) return node.usual == null ? null : `usually ${minutes(node.usual)}`;
  const elapsed =
    node.ended === null
      ? `${minutes(stepElapsed(node, now))} so far`
      : `${minutes(epochMs(node.ended) - epochMs(node.started))} total`;
  return node.usual == null
    ? elapsed
    : `${elapsed}, usually ${minutes(node.usual).replace(/ min$/, "")}`;
};
