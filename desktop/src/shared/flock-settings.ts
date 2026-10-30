// The Flock's settings, as Desktop keeps them: each key is decided by its latest edit,
// made in Desktop or on any Machine, and every Machine is given what it lacks.

import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
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
import type { DesktopSettings, DesktopSettingsChange, MachineRow } from "./flock";
import { whenOf } from "./flow";
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

export const editSettings = (
  flock: FlockSettings,
  changes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
  now: string,
): FlockSettings | { readonly refused: string } => {
  let edited = flock;
  for (const { key, value } of changes) {
    const next = editSetting(edited, key, value, now);
    if ("refused" in next) return next;
    edited = next;
  }
  return edited;
};

/** Desktop's own settings, which no Machine has. */
interface DesktopSetting extends Setting {
  readonly read: (desktop: DesktopSettings) => string;
  /** What setting it to `typed` changes; `typed` is never empty. */
  readonly change: (typed: string) => DesktopSettingsChange;
}

/** The harnesses the Flock chat has a driver for. */
export const CHAT_HARNESSES = ["claude", "pi"];
export const DEFAULT_CHAT_HARNESS = "claude";

const DESKTOP_SETTINGS: ReadonlyArray<DesktopSetting> = [
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
  },
];

/** What Settings says of a setting while it is unset, where its default says nothing. */
const UNSET_SAID = new Map([
  ["zoom", "Default: 100%, the size of your other apps"],
  ["machine_rule", "Unset: no rule"],
  ["release.approval_channel", "Unset: shares nothing"],
  ["slack.notification_channel", "Unset: toasts only"],
]);

/** The canvas's sub-groups within a group, by key; any other key has none. */
const SUBS: ReadonlyArray<readonly [string, (key: string) => boolean]> = [
  ["Who does the work", (key) => ["harness", "model", "effort", "fallbacks"].includes(key)],
  ["What agents may do", (key) => ["permissions", "trust"].includes(key)],
  [
    "Context and patience",
    (key) =>
      ["compact_at_tokens", "claude_auto_compact_window", "quiet_ms", "idle_close_ms"].includes(
        key,
      ),
  ],
  [
    "Advanced",
    (key) =>
      pipe(key, Str.startsWith("models.")) || ["agent_profile", "claude_subagents"].includes(key),
  ],
  ["Release approvals", (key) => pipe(key, Str.startsWith("release."))],
  ["Toasts", (key) => pipe(key, Str.startsWith("notifications."))],
];
const subOf = (key: string) =>
  Option.getOrUndefined(Arr.findFirst(SUBS, ([, has]) => has(key)))?.[0] ?? "";
/** Where a sub-group falls within its group: none first, then the canvas's order. */
const subRank = (sub: string) =>
  Option.getOrElse(
    Arr.findFirstIndex(SUBS, ([title]) => title === sub),
    () => -1,
  );

/** What setting Desktop's own `key` to `typed` changes; empty sets it back to its default. */
export const desktopChange = (key: string, typed: string): DesktopSettingsChange => {
  const setting = Option.getOrUndefined(Arr.findFirst(DESKTOP_SETTINGS, (one) => one.key === key))!;
  return setting.change(typed || setting.fallback);
};

/** One setting as Settings shows it, its value and default in its unit. */
export interface SettingRow {
  readonly key: string;
  readonly group: SettingGroup;
  /** The sub-group it is shown under within its group, empty for none. */
  readonly sub: string;
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
  /** Whose edit it is and when, or the Machine it was taken from over a different value. */
  readonly edit: string | null;
  /** Every Machine's, or this computer's alone. */
  readonly shared: boolean;
  readonly multiline: boolean;
  /** What its value brings about, stated rather than confirmed. */
  readonly hint: string | null;
}

export interface SettingSection {
  readonly group: SettingGroup;
  readonly rows: ReadonlyArray<SettingRow>;
}

const consequenceOf = (key: string, value: string): string | null => {
  if (key === "permissions" && value === "bypass")
    return "No one reviews an agent's tool calls: every Machine's agents run what they choose.";
  if (key === "compact_at_tokens" && value === "0")
    return "Compaction between pieces of work is off.";
  if (key === "quiet_ms" && value === "0")
    return "A quiet agent is never nudged; it waits as long as it takes.";
  const bare =
    key === "models.pi"
      ? Option.getOrUndefined(
          Arr.findFirst(
            Str.split(value, ", "),
            (model) => model !== "" && !pipe(model, Str.includes("/")),
          ),
        )
      : undefined;
  return bare === undefined
    ? null
    : `Pi runs a model written provider/model, such as openai-codex/gpt-6.1-sol, so it cannot run "${bare}".`;
};

const flockRow = (
  flock: FlockSettings,
  setting: Setting,
  now: number,
  timeZone: string | undefined,
): SettingRow => {
  const held = flock.settings[setting.key];
  const value = held === undefined ? "" : settingText(valueOf(held.value));
  const edit =
    held === undefined || value === ""
      ? null
      : held.differed
        ? `Taken from ${held.from} over a different value at the first sync`
        : `Last edit: ${held.from} · ${whenOf(held.at, now, timeZone)}`;
  return {
    ...rowOf(setting),
    value: settingShown(setting.key, value),
    fallback: settingShown(setting.key, setting.fallback),
    defaultSaid: defaultSaid(setting, settingShown(setting.key, setting.fallback)),
    set: value !== "",
    edit,
    shared: true,
    multiline: setting.kind === "json" || setting.key === "machine_rule",
    hint: consequenceOf(setting.key, value),
  };
};

const defaultSaid = ({ key, kind, unit }: Setting, fallback: string) => {
  const unset = UNSET_SAID.get(key);
  if (unset !== undefined) return unset;
  if (kind === "list" || kind === "json") return "Default: none";
  if (fallback === "") return "Unset: the harness decides";
  if (kind === "boolean") return `Default: ${fallback === "true" ? "on" : "off"}`;
  return `Default: ${fallback}${unit === undefined ? "" : ` ${unit}`}`;
};

const rowOf = ({ key, group, label, description, kind, choices, unit }: Setting) => ({
  key,
  group,
  sub: subOf(key),
  label,
  description,
  kind,
  choices,
  unit,
});

/**
 * Every setting of Collie's and Desktop's own, under its group in order, but the GitLab
 * host, which Settings keeps beside its tokens. An edit is said at `now`, on the clock of
 * `timeZone`.
 */
export const settingSections = (
  flock: FlockSettings,
  desktop: DesktopSettings,
  now: number,
  timeZone?: string,
): ReadonlyArray<SettingSection> => {
  const rows = [
    ...Arr.map(DESKTOP_SETTINGS, (setting): SettingRow => {
      const value = setting.read(desktop);
      const set = value !== setting.fallback;
      return {
        ...rowOf(setting),
        value,
        fallback: setting.fallback,
        defaultSaid: defaultSaid(setting, setting.fallback),
        set,
        edit: set ? "Saved on this computer" : null,
        shared: false,
        multiline: false,
        hint: null,
      };
    }),
    ...Arr.map(
      Arr.filter(SETTINGS, ({ key }) => key !== GIVEN_ONLY),
      (setting) => flockRow(flock, setting, now, timeZone),
    ),
  ];
  return Arr.flatMap(SETTING_GROUPS, (group) => {
    const placed = Arr.filter(rows, (row) => row.group === group).sort(
      (a, b) => subRank(a.sub) - subRank(b.sub),
    );
    return placed.length === 0 ? [] : [{ group, rows: placed }];
  });
};

export type Reached = Pick<MachineRow, "name" | "state" | "settings">;

export interface Said {
  readonly said: string;
  readonly tone: "ok" | "warn";
}

const missed = ({ state, settings }: Reached) =>
  state !== "live" || settings === null || settings.failed !== null;

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2
    ? Arr.join(names, "")
    : `${Arr.join(names.slice(0, -1), ", ")} and ${names.at(-1)}`;

const reachedOf = (machines: ReadonlyArray<Reached>) => {
  const behind = Arr.filter(machines, missed);
  return {
    behind,
    all: behind.length === 0,
    of: `${machines.length - behind.length} of ${machines.length}`,
  };
};

/**
 * How far an edit of the Flock's settings reached, from each Machine's latest sync, or why
 * it is not sent: one made while the Flock's settings cannot be read would be made blind.
 */
export const flockReach = (
  readable: boolean,
  machines: ReadonlyArray<Reached>,
): Said | { readonly refused: string } => {
  if (!readable) return { refused: "Not set: the Flock's settings could not be read" };
  const { behind, all, of } = reachedOf(machines);
  if (all) return { said: `Given to all ${machines.length} Machines`, tone: "ok" };
  const names = Arr.map(behind, ({ name }) => name);
  return {
    said: `Given to ${of} · ${listed(names)} ${names.length === 1 ? "gets it when it connects" : "get it when they connect"}`,
    tone: "warn",
  };
};

export const syncPill = (readable: boolean, machines: ReadonlyArray<Reached>): Said => {
  if (!readable) return { said: "Showing the Flock's settings as last read", tone: "warn" };
  const { behind, all, of } = reachedOf(machines);
  if (all) return { said: `In sync with all ${machines.length} Machines`, tone: "ok" };
  const lagging = Arr.map(
    behind,
    ({ name, state }) => `${name} ${state === "live" ? "behind" : "out of reach"}`,
  );
  return { said: `In sync with ${of} · ${listed(lagging)}`, tone: "warn" };
};
