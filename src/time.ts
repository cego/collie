import { Clock, DateTime, Effect } from "effect";

export function nowMillis() {
  return Clock.currentTimeMillis;
}

export function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}
