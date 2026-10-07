// The Flock's settings, as Desktop keeps them: each key is decided by its latest edit,
// made in Desktop or on any Machine, and every Machine is given what it lacks.

import { Effect, Option, Schema } from "effect";
import type { SharedSetting } from "../../../src/board-model";
import {
  parseSetting,
  parseShared,
  SETTINGS,
  type SettingKind,
  SettingValue,
  settingText,
} from "../../../src/settings";
import { epochMs } from "../../../src/time";

/** Where an edit made in Desktop's own Settings is said to come from. */
export const DESKTOP = "Desktop";

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
  for (const { key, value, at } of has) {
    const kept = settings[key];
    if (key === GIVEN_ONLY || "refused" in parseShared(key, value)) continue;
    if (kept !== undefined && epochMs(at) <= epochMs(kept.at)) continue;
    settings[key] = {
      value,
      at,
      from: machine,
      differed: first && kept !== undefined && kept.from !== machine && !same(kept.value, value),
    };
  }
  const give = Object.entries(settings).flatMap(([key, { value, at }]): SharedSetting[] => {
    const theirs = has.find((one) => one.key === key);
    return theirs !== undefined && epochMs(theirs.at) >= epochMs(at) ? [] : [{ key, value, at }];
  });
  const synced = first ? [...flock.synced, machine] : flock.synced;
  return { flock: { settings, synced } satisfies FlockSettings, give };
};

/** An edit made in Desktop's Settings, checked as the TUI checks one, at `now`. */
export const editSetting = (
  flock: FlockSettings,
  key: string,
  typed: string,
  now: string,
): FlockSettings | { readonly refused: string } => {
  const parsed = parseSetting(key, typed);
  if ("refused" in parsed) return parsed;
  return {
    ...flock,
    settings: {
      ...flock.settings,
      [key]: { value: parsed.value, at: now, from: DESKTOP, differed: false },
    },
  };
};

/** One setting as Settings shows it. */
export interface SettingRow {
  readonly key: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  /** What it is set to, empty where it is unset. */
  readonly value: string;
  /** What a Run uses while it is unset. */
  readonly fallback: string;
  /** The Machine its value was taken from over a different one, where it was. */
  readonly from: string | null;
}

/** Every setting of Collie's, but the GitLab host, which Settings keeps beside its tokens. */
export const settingRows = (flock: FlockSettings): ReadonlyArray<SettingRow> =>
  SETTINGS.filter(({ key }) => key !== GIVEN_ONLY).map(({ key, kind, choices, fallback }) => {
    const held = flock.settings[key];
    return {
      key,
      kind,
      choices,
      fallback,
      value: held === undefined ? "" : settingText(valueOf(held.value)),
      from: held?.differed === true ? held.from : null,
    };
  });
