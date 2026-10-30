// A Flock's latest edits, shared by Desktop and paired hosts.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, Option, Schema } from "effect";
import type { SharedSetting } from "./board-model";
import { parseShared, SettingValue, settingText } from "./settings";
import { epochMs } from "./time";

export const FlockSetting = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  at: Schema.String,
  /** The Machine whose edit it is, or Desktop. */
  from: Schema.String,
  /** Taken over a different value another Machine had, which Settings says once. */
  differed: Schema.Boolean,
});
export type FlockSetting = typeof FlockSetting.Type;

export const FlockSettings = Schema.Struct({
  settings: Schema.Record(Schema.String, FlockSetting),
  /** The Machines synced at least once: only a first sync says where a value came from. */
  synced: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type FlockSettings = typeof FlockSettings.Type;

export const NO_FLOCK_SETTINGS: FlockSettings = { settings: {}, synced: [] };

const valueOf = (value: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(SettingValue)(value));

const same = (a: Schema.Json | null, b: Schema.Json | null) =>
  settingText(valueOf(a)) === settingText(valueOf(b));

/** Desktop's own, given to every Machine and never taken from one: its token is made for it. */
const GIVEN_ONLY = "gitlab_host";

/** Each side's edits the other lacks or holds older; a tie keeps what is held, and a removal is an edit. */
export const latestEdits = <
  Held extends { readonly at: string },
  Has extends { readonly at: string },
>(
  held: ReadonlyArray<Held>,
  has: ReadonlyArray<Has>,
  keyOf: (edit: Held | Has) => string,
) => {
  const later = (one: Held | Has, others: ReadonlyArray<Held | Has>) => {
    const other = Option.getOrUndefined(
      Arr.findFirst(others, (each) => keyOf(each) === keyOf(one)),
    );
    return other === undefined || epochMs(one.at) > epochMs(other.at);
  };
  return {
    take: Arr.filter(has, (one) => later(one, held)),
    give: Arr.filter(held, (one) => later(one, has)),
  };
};

/**
 * What a Machine has, taken into the Flock's where it is the later edit and a value its
 * setting takes, and what the Machine should then be given: each key whose latest edit it
 * lacks.
 */
export const takeFrom = (
  flock: FlockSettings,
  machine: string,
  has: ReadonlyArray<SharedSetting>,
) => {
  const settings = { ...flock.settings };
  const first = !flock.synced.includes(machine);
  const held = (edits: FlockSettings["settings"]) =>
    Arr.map(Rec.toEntries(edits), ([key, { value, at }]): SharedSetting => ({ key, value, at }));
  const takeable = Arr.filter(
    has,
    ({ key, value }) => key !== GIVEN_ONLY && !("refused" in parseShared(key, value)),
  );
  for (const { key, value, at } of latestEdits(held(settings), takeable, byKey).take) {
    const kept = settings[key];
    settings[key] = {
      value,
      at,
      from: machine,
      differed: first && kept !== undefined && kept.from !== machine && !same(kept.value, value),
    };
  }
  const { give } = latestEdits(held(settings), has, byKey);
  const synced = first ? [...flock.synced, machine] : flock.synced;
  return { flock: { settings, synced } satisfies FlockSettings, give };
};

export const byKey = (setting: { readonly key: string }) => setting.key;
