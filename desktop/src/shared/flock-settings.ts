// The Flock's settings, as Desktop keeps them: each key is decided by its latest edit,
// made in Desktop or on any Machine, and every Machine is given what it lacks.

import { Option, Schema } from "effect";
import {
  parseSetting,
  type Setting,
  SETTING_GROUPS,
  type SettingGroup,
  SETTINGS,
  type SettingKind,
  settingShown,
  type SettingUnit,
  SettingValue,
  settingText,
} from "../../../src/settings";
import type { DesktopSettings, DesktopSettingsChange } from "./flock";
import { percent } from "./scale";

/** Where an edit made in Desktop's own Settings is said to come from. */
export const DESKTOP = "Desktop";

export {
  FlockSetting,
  FlockSettings,
  NO_FLOCK_SETTINGS,
  takeFrom,
} from "../../../src/flock-settings";
import type { FlockSettings } from "../../../src/flock-settings";

const valueOf = (value: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(SettingValue)(value));
const GIVEN_ONLY = "gitlab_host";

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

/** Desktop's own settings, which no Machine has. */
interface DesktopSetting extends Setting {
  readonly read: (desktop: DesktopSettings) => string;
  /** What setting it to `typed` changes; `typed` is never empty. */
  readonly change: (typed: string) => DesktopSettingsChange;
  /** What Settings says of it while it is unset, where its default says nothing. */
  readonly unset?: (desktop: DesktopSettings) => string;
  /** Typed as several lines of the human's own words. */
  readonly multiline?: true;
}

/** The harnesses the Flock chat has a driver for. */
export const CHAT_HARNESSES = ["claude", "pi"];
export const DEFAULT_CHAT_HARNESS = "claude";

const DESKTOP_SETTINGS: ReadonlyArray<DesktopSetting> = [
  {
    key: "proactive",
    kind: "boolean",
    choices: [],
    fallback: "true",
    group: "Chat",
    label: "Flock chat speaks first",
    description:
      "Whether the Flock chat starts a turn about News that matters, as the bell in its header does.",
    read: (desktop: DesktopSettings) => String(desktop.proactive),
    change: (typed) => ({ proactive: typed === "true" }),
  },
  {
    key: "machineRule",
    kind: "text",
    choices: [],
    fallback: "",
    group: "Chat",
    label: "Machine rule",
    description:
      "Which Machine each kind of work goes to, in your own words. The Flock chat starts work where it says, and asks where it does not say.",
    read: (desktop: DesktopSettings) => desktop.machineRule ?? "",
    change: (typed) => ({ machineRule: typed.trim() }),
    unset: () => "Unset: no rule",
    multiline: true,
  },
  {
    key: "zoom",
    kind: "choice",
    choices: ["80%", "90%", "100%", "110%", "125%", "150%"],
    fallback: "100%",
    group: "Board",
    label: "Zoom",
    description:
      "How large Desktop draws on this computer, against the other apps on the same monitor.",
    read: (desktop: DesktopSettings) => percent(desktop.zoom ?? 1),
    change: (typed) => ({ zoom: Number.parseInt(typed, 10) / 100 }),
    unset: () => "Default: 100%, the size of your other apps",
  },
];

/** What setting Desktop's own `key` to `typed` changes; empty sets it back to its default. */
export const desktopChange = (key: string, typed: string): DesktopSettingsChange => {
  const setting = DESKTOP_SETTINGS.find((one) => one.key === key)!;
  return setting.change(typed || setting.fallback);
};

/** One setting as Settings shows it, its value and default in its unit. */
export interface SettingRow {
  readonly key: string;
  readonly group: SettingGroup;
  readonly label: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  /** What it is set to, empty where it is unset. */
  readonly value: string;
  /** What a Run uses while it is unset. */
  readonly fallback: string;
  readonly unit: SettingUnit | undefined;
  /** The default as Settings says it, in the row's unit. */
  readonly defaultSaid: string;
  readonly set: boolean;
  /** The Machine its value was taken from over a different one, where it was. */
  readonly from: string | null;
  /** Every Machine's, or this computer's alone. */
  readonly shared: boolean;
  readonly multiline: boolean;
}

export interface SettingSection {
  readonly group: SettingGroup;
  readonly rows: ReadonlyArray<SettingRow>;
}

const flockRow = (flock: FlockSettings, setting: Setting): SettingRow => {
  const held = flock.settings[setting.key];
  const value = held === undefined ? "" : settingText(valueOf(held.value));
  return {
    ...rowOf(setting),
    value: settingShown(setting.key, value),
    fallback: settingShown(setting.key, setting.fallback),
    defaultSaid: defaultSaid(setting, settingShown(setting.key, setting.fallback)),
    set: value !== "",
    from: held?.differed === true ? held.from : null,
    shared: true,
    multiline: setting.kind === "json",
  };
};

const defaultSaid = ({ kind, unit }: Setting, fallback: string) => {
  if (kind === "list" || kind === "json") return "Default: none";
  if (fallback === "") return "Unset: the harness decides";
  if (kind === "boolean") return `Default: ${fallback === "true" ? "on" : "off"}`;
  return `Default: ${fallback}${unit === undefined ? "" : ` ${unit}`}`;
};

const rowOf = ({ key, group, label, description, kind, choices, unit }: Setting) => ({
  key,
  group,
  label,
  description,
  kind,
  choices,
  unit,
});

/**
 * Every setting of Collie's and Desktop's own, under its group in order, but the GitLab
 * host, which Settings keeps beside its tokens.
 */
export const settingSections = (
  flock: FlockSettings,
  desktop: DesktopSettings,
): ReadonlyArray<SettingSection> => {
  const rows = [
    ...SETTINGS.filter(({ key }) => key !== GIVEN_ONLY).map((setting) => flockRow(flock, setting)),
    ...DESKTOP_SETTINGS.map(({ read, change: _, unset, multiline, ...setting }): SettingRow => {
      const value = read(desktop);
      return {
        ...rowOf(setting),
        value,
        fallback: setting.fallback,
        defaultSaid: unset?.(desktop) ?? defaultSaid(setting, setting.fallback),
        set: value !== setting.fallback,
        from: null,
        shared: false,
        multiline: multiline === true,
      };
    }),
  ];
  return SETTING_GROUPS.flatMap((group) => {
    const placed = rows.filter((row) => row.group === group);
    return placed.length === 0 ? [] : [{ group, rows: placed }];
  });
};
