import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { DateTime, Effect, Option } from "effect";

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

const parsed = new Map<string, number>();
const PARSED_KEPT = 100_000;

export function epochMs(iso: string) {
  const known = parsed.get(iso);
  if (known !== undefined) {
    return known;
  }
  const ms = Option.match(DateTime.make(iso), {
    onNone: () => Number.NaN,
    onSome: DateTime.toEpochMillis,
  });
  if (parsed.size >= PARSED_KEPT) {
    parsed.clear();
  }
  parsed.set(iso, ms);
  return ms;
}

export const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export function fileTime(iso: string) {
  return DateTime.toDateUtc(DateTime.makeUnsafe(iso));
}

const UNITS = [
  { unit: "day", short: "d", size: 86_400 },
  { unit: "hour", short: "h", size: 3600 },
  { unit: "minute", short: "m", size: 60 },
] as const;

// WARNING: a negative span is 0s: the two ends come from different clocks.
export function took(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h${pipe_(String(minutes % 60), Str.padStart(2, "0"))}m`;
}

export function spanned(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  for (const { unit, size } of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) {
      return `${n} ${unit}${n === 1 ? "" : "s"}`;
    }
  }
  return "";
}

export function ago(iso: string, nowMs: number) {
  const then = epochMs(iso);
  return Number.isNaN(then) ? iso : agoMs(then, nowMs);
}

export function agoMs(thenMs: number, nowMs: number) {
  const span = spanned(nowMs - thenMs);
  return span === "" ? "just now" : `${span} ago`;
}

export function agoShort(atMs: number, nowMs: number) {
  if (atMs <= 0) {
    return "";
  }
  const seconds = Math.floor((nowMs - atMs) / 1000);
  if (seconds < 5) {
    return "now";
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  for (const { short, size } of UNITS) {
    const n = Math.floor(seconds / size);
    if (n >= 1) {
      return `${n}${short} ago`;
    }
  }
  return "now";
}

export function minutes(ms: number) {
  const whole = Math.floor(Math.max(0, ms) / 60_000);
  if (whole < 1) {
    return "under a minute";
  }
  if (whole < 60) {
    return `${whole} min`;
  }
  const rest = whole % 60;
  return rest === 0 ? `${Math.floor(whole / 60)} h` : `${Math.floor(whole / 60)} h ${rest} min`;
}

export function clockTime(ms: number) {
  const iso = DateTime.formatIsoOffset(
    DateTime.makeZonedUnsafe(ms, { timeZone: DateTime.zoneMakeLocal() }),
  );
  return pipe_(iso, Str.slice(11, 16));
}
