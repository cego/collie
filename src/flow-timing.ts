import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { FlowRun } from "./board-model";
import { epochMs } from "./time";

export const stepElapsed = (
  node: FlowRun & { readonly runs?: ReadonlyArray<FlowRun> },
  now: number,
): number => {
  const active =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(node.runs), (present) =>
        Option.getOrUndefined(Arr.findLast(present, (one) => one.state === "running")),
      ),
    ) ?? node;
  return active.started === null ? 0 : Math.max(0, now - epochMs(active.started));
};
