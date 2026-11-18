import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

export interface CellSummary {
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly n: number;
  readonly failed: number;
}

const nearestRank = (sorted: ReadonlyArray<number>, q: number) =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;

export const summaryOf = (samples: ReadonlyArray<number>, failed: number) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.at(-1) ?? Number.NaN,
    n: sorted.length,
    failed,
  };
};

export const barFailures = (cells: Readonly<Record<string, CellSummary>>, bar: number) =>
  Arr.flatMap(Rec.toEntries(cells), ([name, cell]) => [
    ...(cell.n === 0 ? [`${name}: no samples`] : []),
    ...(cell.p95 >= bar ? [`${name}: p95 ${cell.p95} ms`] : []),
    ...(cell.max >= bar ? [`${name}: max ${cell.max} ms`] : []),
    ...(cell.failed > 0
      ? [`${name}: ${cell.failed} sample${cell.failed === 1 ? "" : "s"} painted a wrong Flow`]
      : []),
  ]);
