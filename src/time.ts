import { DateTime, Effect } from "effect";

export function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}

/**
 * How long ago, in the coarsest unit that still says something. A menu line and a
 * prompt both want "2 days ago", not a timestamp to subtract in your head.
 */
export function ago(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  for (const [unit, size] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
