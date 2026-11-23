import { Array as Arr, DateTime, Option, pipe, String as Str } from "effect";
import type { KeptRecord } from "./flock";

export interface KeptSet {
  readonly open: string | null;
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

export const opened = (set: KeptSet, key: string) =>
  trimmed({
    ...closed(set),
    open: key,
    recent: Arr.filter(closed(set).recent, (one) => one !== key),
    prefetched: set.prefetched === key ? null : set.prefetched,
  });

export const closed = (set: KeptSet) =>
  set.open === null
    ? set
    : trimmed({
        ...set,
        open: null,
        recent: [set.open, ...Arr.filter(set.recent, (one) => one !== set.open)],
      });

export const pointed = (set: KeptSet, key: string | null, now: number) =>
  key === set.pointing?.key ? set : { ...set, pointing: key === null ? null : { key, since: now } };

export const settled = (set: KeptSet, now: number) =>
  set.pointing === null ||
  now - set.pointing.since < POINT_MS ||
  keptKeys(set).has(set.pointing.key)
    ? set
    : trimmed({ ...set, prefetched: set.pointing.key });

export const sized = (set: KeptSet, key: string, bytes: number) =>
  keptKeys(set).has(key) ? trimmed({ ...set, bytes: new Map(set.bytes).set(key, bytes) }) : set;

export const keptKeys = (set: KeptSet) =>
  new Set([
    ...(set.open === null ? [] : [set.open]),
    ...set.recent,
    ...(set.prefetched === null ? [] : [set.prefetched]),
  ]);

const total = (set: KeptSet) =>
  Arr.reduce([...keptKeys(set)], 0, (sum, key) => sum + (set.bytes.get(key) ?? 0));

const trimmed = (set: KeptSet) => {
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
  readonly asOf: number | null;
}

export const recordStanding = (asOf: number | null, notLive: NotLive | null) =>
  notLive !== null
    ? { ...notLive, asOf }
    : asOf === null
      ? null
      : { icon: "i-lucide-refresh-cw", title: "Reconnecting", reason: "", asOf };

export const asOfSaid = (at: number) => {
  const { hour, minute } = DateTime.toParts(
    DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() }),
  );
  const two = (n: number) => pipe(String(n), Str.padStart(2, "0"));
  return `as of ${two(hour)}:${two(minute)}`;
};

export const refusal = (reason: string | null, asOf: number | null) =>
  reason ?? (asOf === null ? null : `Not current: showing what it last said, ${asOfSaid(asOf)}`);

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
      // WARNING: held before hold runs, which may tell a size and so trim at once.
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

export const withFlowKept = (held: Option.Option<KeptRecord>, record: KeptRecord) => {
  const flow = Option.getOrUndefined(held)?.detail?.flow;
  return record.detail === null || record.detail.flow !== undefined || flow === undefined
    ? record
    : { ...record, detail: { ...record.detail, flow } };
};
