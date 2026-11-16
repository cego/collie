import * as Arr from "effect/Array";
import * as Str from "effect/String";

export interface ViewCheck {
  readonly runId: string;
  readonly status: string;
  readonly report: string | null;
  readonly delivery: string | null;
  readonly closed: boolean;
  readonly wakes: string | null;
}

export const viewMismatches = (
  actual: ReadonlyArray<ViewCheck>,
  expected: ReadonlyArray<ViewCheck>,
) => {
  const byId = new Map(Arr.map(actual, (view) => [view.runId, view] as const));
  const wrong: string[] = actual.length === byId.size ? [] : ["duplicate Run ids"];
  for (const wanted of expected) {
    const found = byId.get(wanted.runId);
    if (
      found === undefined ||
      found.status !== wanted.status ||
      found.report !== wanted.report ||
      found.delivery !== wanted.delivery ||
      found.closed !== wanted.closed ||
      found.wakes !== wanted.wakes
    )
      wrong.push(wanted.runId);
    byId.delete(wanted.runId);
  }
  return [...wrong, ...byId.keys()];
};

export const logArrivals = (frames: ReadonlyArray<{ at: number; text: string }>) => {
  const arrived = new Map<number, number>();
  for (const frame of frames)
    for (const marker of Str.matchAll(/bench-log:(\d+):\d+/g)(frame.text)) {
      const sequence = Number(marker[1]);
      if (!arrived.has(sequence)) arrived.set(sequence, frame.at);
    }
  return arrived;
};
