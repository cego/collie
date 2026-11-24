import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, Option, Schema } from "effect";
import type { SharedSetting } from "./board-model";
import { parseShared, SettingValue, settingText } from "./settings";
import { epochMs } from "./time";

export const FlockSetting = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  at: Schema.String,
  from: Schema.String,
  differed: Schema.Boolean,
});
export type FlockSetting = typeof FlockSetting.Type;

export const FlockSettings = Schema.Struct({
  settings: Schema.Record(Schema.String, FlockSetting),
  // WARNING: only a first sync says where a value came from.
  synced: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
export type FlockSettings = typeof FlockSettings.Type;

export const NO_FLOCK_SETTINGS: FlockSettings = { settings: {}, synced: [] };

const valueOf = (value: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(SettingValue)(value));

const same = (a: Schema.Json | null, b: Schema.Json | null) =>
  settingText(valueOf(a)) === settingText(valueOf(b));

// WARNING: never taken from a Machine; its token is made for Desktop.
const GIVEN_ONLY = "gitlab_host";

// WARNING: a tie keeps the held value, and a removal counts as an edit.
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

export const takeFrom = (
  flock: FlockSettings,
  machine: string,
  has: ReadonlyArray<SharedSetting>,
) => {
  const settings = { ...flock.settings };
  const first = !flock.synced.includes(machine);
  const held = (edits: FlockSettings["settings"]) =>
    Arr.map(Rec.toEntries(edits), ([key, { value, at }]) => ({ key, value, at }));
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
