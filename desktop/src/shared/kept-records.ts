// Which records Desktop keeps subscribed: the open one, the last few opened, and a card the
// human has pointed at long enough to be about to open it.

import { Array as Arr, DateTime, Option, pipe, String as Str } from "effect";
import type { KeptRecord } from "./flock";

export interface KeptSet {
  readonly open: string | null;
  /** Records opened before, the most recent first. */
  readonly recent: ReadonlyArray<string>;
  readonly pointing: { readonly key: string; readonly since: number } | null;
  readonly prefetched: string | null;
  readonly bytes: ReadonlyMap<string, number>;
}

export const RECENT = 8;
export const CAP_BYTES = 16 * 1024 * 1024;
export const POINT_MS = 150;

export const EMPTY_KEPT: KeptSet = {
  open: null,
  recent: [],
  pointing: null,
  prefetched: null,
  bytes: new Map(),
};

export const opened = (set: KeptSet, key: string): KeptSet =>
  trimmed({
    ...closed(set),
    open: key,
    recent: Arr.filter(closed(set).recent, (one) => one !== key),
    prefetched: set.prefetched === key ? null : set.prefetched,
  });

export const closed = (set: KeptSet): KeptSet =>
  set.open === null
    ? set
    : trimmed({
        ...set,
        open: null,
        recent: [set.open, ...Arr.filter(set.recent, (one) => one !== set.open)],
      });

/** The card the human points at now, or null for none. */
export const pointed = (set: KeptSet, key: string | null, now: number): KeptSet =>
  key === set.pointing?.key ? set : { ...set, pointing: key === null ? null : { key, since: now } };

/** The card pointed at long enough becomes the one prefetched. */
export const settled = (set: KeptSet, now: number): KeptSet =>
  set.pointing === null ||
  now - set.pointing.since < POINT_MS ||
  keptKeys(set).has(set.pointing.key)
    ? set
    : trimmed({ ...set, prefetched: set.pointing.key });

/** The encoded size of a kept record's latest frame. */
export const sized = (set: KeptSet, key: string, bytes: number): KeptSet =>
  keptKeys(set).has(key) ? trimmed({ ...set, bytes: new Map(set.bytes).set(key, bytes) }) : set;

export const keptKeys = (set: KeptSet): ReadonlySet<string> =>
  new Set([
    ...(set.open === null ? [] : [set.open]),
    ...set.recent,
    ...(set.prefetched === null ? [] : [set.prefetched]),
  ]);

const total = (set: KeptSet) =>
  Arr.reduce([...keptKeys(set)], 0, (sum, key) => sum + (set.bytes.get(key) ?? 0));

/** Past eight recent or over the cap, the prefetched one and then the least recently opened go. */
const trimmed = (set: KeptSet): KeptSet => {
  let kept: KeptSet = { ...set, recent: Arr.take(set.recent, RECENT) };
  while (total(kept) > CAP_BYTES && (kept.prefetched !== null || kept.recent.length > 0))
    kept =
      kept.prefetched !== null
        ? { ...kept, prefetched: null }
        : { ...kept, recent: Arr.dropRight(kept.recent, 1) };
  const keys = keptKeys(kept);
  return { ...kept, bytes: new Map(Arr.filter([...kept.bytes], ([key]) => keys.has(key))) };
};

export interface NotLive {
  readonly icon: string;
  readonly title: string;
  readonly reason: string;
}
export interface Standing extends NotLive {
  /** When its host last confirmed what it shows. */
  readonly asOf: number | null;
}

/** What a record says of itself while it is not its host's current one; null while it is. */
export const recordStanding = (asOf: number | null, notLive: NotLive | null): Standing | null =>
  notLive !== null
    ? { ...notLive, asOf }
    : asOf === null
      ? null
      : { icon: "i-lucide-refresh-cw", title: "Reconnecting", reason: "", asOf };

/** `as of 14:05`, in this computer's time. */
export const asOfSaid = (at: number) => {
  const { hour, minute } = DateTime.toParts(
    DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const two = (n: number) => pipe(String(n), Str.padStart(2, "0"));
  return `as of ${two(hour)}:${two(minute)}`;
};

/** Why an action on a record is refused: its own `reason`, else that its host has not confirmed it since `asOf`. */
export const refusal = (reason: string | null, asOf: number | null) =>
  reason ?? (asOf === null ? null : `Not current: showing what it last said, ${asOfSaid(asOf)}`);

/** Holds the kept set's records: `hold` subscribes one, and what it returns lets it go. */
export const keptHolder = (
  hold: (key: string, sized: (bytes: number) => void) => () => void,
  now: () => number,
  later: (ms: number, then: () => void) => void,
) => {
  let set = EMPTY_KEPT;
  const held = new Map<string, () => void>();
  const sync = () => {
    const keys = keptKeys(set);
    for (const [key, release] of held)
      if (!keys.has(key)) {
        held.delete(key);
        release();
      }
    for (const key of keys) {
      if (held.has(key) || !keptKeys(set).has(key)) continue;
      // Held before `hold` runs, which may tell a size, and so trim, at once.
      held.set(key, () => {});
      const release = hold(key, (bytes) => {
        set = sized(set, key, bytes);
        sync();
      });
      if (held.has(key)) held.set(key, release);
      else release();
    }
  };
  return {
    opened: (key: string) => {
      set = opened(set, key);
      sync();
    },
    closed: (key: string) => {
      if (set.open !== key) return;
      set = closed(set);
      sync();
    },
    pointed: (key: string | null) => {
      set = pointed(set, key, now());
      if (key === null) return;
      later(POINT_MS, () => {
        set = settled(set, now());
        sync();
      });
    },
  };
};

/** A frame Desktop sent without the Flow the view holds, which it left out as unchanged. */
export const withFlowKept = (held: Option.Option<KeptRecord>, record: KeptRecord): KeptRecord => {
  const flow = Option.getOrUndefined(held)?.detail?.flow;
  return record.detail === null || record.detail.flow !== undefined || flow === undefined
    ? record
    : { ...record, detail: { ...record.detail, flow } };
};
