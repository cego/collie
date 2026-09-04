import { DateTime, Effect } from "effect";

export function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}

/**
 * The one set of thresholds "how long ago" is answered against, so the two renderings
 * below cannot drift into disagreeing about when an hour becomes a day.
 */
const UNITS = [
  { unit: "day", short: "d", size: 86_400 },
  { unit: "hour", short: "h", size: 3_600 },
  { unit: "minute", short: "m", size: 60 },
] as const;

/**
 * How long something took, in the coarsest unit that still says it: `45s`, `12m`,
 * `1h03m`. Two units past an hour, because "63m" is a number to divide in your head.
 * Milliseconds rather than two timestamps, so a caller with only one end of it — a step
 * still running — asks the same question the same way.
 *
 * A negative span is `0s`: the two ends come from different clocks (a step's own stamp
 * against this machine's now), and a duration counting backwards is worse than a zero.
 */
export function took(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * How long a step has been going, or took: its own two stamps against this clock.
 * `null` for one that was skipped rather than run — it has no start — and for a Run
 * recorded before the timings were kept.
 *
 * Structurally typed rather than importing `StepRecord`, so the one module that answers
 * "how long" for every caller stays free of the record it happens to be asked about.
 */
export function stepDuration(
  step: { started_at: string | null; finished_at: string | null },
  nowMs: number,
): string | null {
  if (step.started_at === null) return null;
  const from = Date.parse(step.started_at);
  if (Number.isNaN(from)) return null;
  const to = step.finished_at === null ? nowMs : Date.parse(step.finished_at);
  return took((Number.isNaN(to) ? nowMs : to) - from);
}

/**
 * How long ago, in the coarsest unit that still says something. A menu line and a
 * prompt both want "2 days ago", not a timestamp to subtract in your head.
 */
export function ago(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  for (const { unit, size } of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/**
 * The same answer in a column's worth of characters — `2h ago` — for a dense row list
 * where "2 hours ago" does not fit. Same thresholds as `ago` above, deliberately: the
 * resume menu and the tab's row list are both on screen in one session, and the same run
 * reading "2 hours ago" in one and "2h ago" in the other is one clock, said twice.
 *
 * Epoch milliseconds rather than an ISO string, because that is what a row carries;
 * `0` is "nothing recorded when", which shows no time at all rather than 1970.
 */
export function agoShort(atMs: number, nowMs: number): string {
  if (atMs <= 0) return "";
  const seconds = Math.floor((nowMs - atMs) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  for (const { short, size } of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n}${short} ago`;
  }
  return "now";
}
