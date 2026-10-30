// What a cell's samples come to, and whether it meets the bar.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

export interface CellSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly n: number;
  /** Samples that painted a Flow other than the host's. */
  readonly failed: number;
}

const nearestRank = (sorted: ReadonlyArray<number>, q: number) =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

export const summaryOf = (samples: ReadonlyArray<number>, failed: number): CellSummary => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.at(-1) ?? Number.NaN,
    n: sorted.length,
    failed,
  };
};

/** Why each cell misses the bar: a p95 or a max at or over it, or a wrong Flow. */
export const barFailures = (
  cells: Readonly<Record<string, CellSummary>>,
  bar: number,
): ReadonlyArray<string> =>
  Arr.flatMap(Rec.toEntries(cells), ([name, cell]) => [
    ...(cell.n === 0 ? [`${name}: no samples`] : []),
    ...(cell.p95 >= bar ? [`${name}: p95 ${cell.p95} ms`] : []),
    ...(cell.max >= bar ? [`${name}: max ${cell.max} ms`] : []),
    ...(cell.failed > 0
      ? [`${name}: ${cell.failed} sample${cell.failed === 1 ? "" : "s"} painted a wrong Flow`]
      : []),
  ]);
