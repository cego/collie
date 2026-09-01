import { DateTime, Effect } from "effect";

export function nowIso() {
  return DateTime.now.pipe(Effect.map(DateTime.formatIso));
}
