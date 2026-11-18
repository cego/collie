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

export const DESKTOP = "Desktop";

export {
  FlockSetting,
  FlockSettings,
  NO_FLOCK_SETTINGS,
  takeFrom,
} from "../../../src/flock-settings";
import type { FlockSettings } from "../../../src/flock-settings";
import { isString } from "../../../src/schema";

const valueOf = (value: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(SettingValue)(value));
const GIVEN_ONLY = "gitlab_host";

export const standingDirectionOf = (flock: FlockSettings) => {
  const held = flock.settings.standing_direction;
  return held !== undefined && isString(held.value) && held.value !== ""
    ? { text: held.value, at: held.at }
    : undefined;
};

export const editSetting = (flock: FlockSettings, key: string, typed: string, now: string) => {
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
) => {
  let edited = flock;
  for (const { key, value } of changes) {
    const next = editSetting(edited, key, value, now);
    if ("refused" in next) return next;
    edited = next;
  }
  return edited;
};

interface DesktopSetting extends Setting {
  readonly read: (desktop: DesktopSettings) => string;
  readonly change: (typed: string) => DesktopSettingsChange;
}

export const CHAT_HARNESSES = ["claude", "codex", "pi"];
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
  {
    key: "record_timing",
    kind: "choice",
    choices: ["off", "on"],
    fallback: "off",
    group: "Board",
    label: "Record timing",
    description:
      "Logs how long each record took to open, and Desktop's launch, terminal, chat and scrolling, to record-timing.log in Desktop's state directory.",
    read: (desktop: DesktopSettings) => (desktop.recordTiming === true ? "on" : "off"),
    change: (typed) => ({ recordTiming: typed === "on" }),
  },
];

const UNSET_SAID = new Map([
  ["zoom", "Default: 100%, the size of your other apps"],
  ["machine_rule", "Unset: no rule"],
  ["standing_direction", "Unset: nothing kept"],
  ["release.approval_channel", "Unset: shares nothing"],
  ["slack.notification_channel", "Unset: toasts only"],
]);

const SUBS: ReadonlyArray<readonly [string, (key: string) => boolean]> = [
  ["Who does the work", (key) => ["harness", "model", "effort", "fallbacks"].includes(key)],
  [
    "What agents may do",
    (key) => ["permissions", "trust", "role_tools", "output_submit"].includes(key),
  ],
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
const subRank = (sub: string) =>
  Option.getOrElse(
    Arr.findFirstIndex(SUBS, ([title]) => title === sub),
    () => -1,
  );

export const desktopChange = (key: string, typed: string) => {
  const setting = Option.getOrUndefined(Arr.findFirst(DESKTOP_SETTINGS, (one) => one.key === key))!;
  return setting.change(typed || setting.fallback);
};

export interface SettingRow {
  readonly key: string;
  readonly group: SettingGroup;
  readonly sub: string;
  readonly label: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  readonly value: string;
  readonly fallback: string;
  readonly unit: SettingUnit | undefined;
  readonly defaultSaid: string;
  readonly set: boolean;
  readonly edit: string | null;
  readonly shared: boolean;
  readonly multiline: boolean;
  readonly hint: string | null;
}

export interface SettingSection {
  readonly group: SettingGroup;
  readonly rows: ReadonlyArray<SettingRow>;
}

const consequenceOf = (key: string, value: string) => {
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
) => {
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
    multiline:
      setting.kind === "json" || ["machine_rule", "standing_direction"].includes(setting.key),
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

export const settingSections = (
  flock: FlockSettings,
  desktop: DesktopSettings,
  now: number,
  timeZone?: string,
) => {
  const rows = [
    ...Arr.map(DESKTOP_SETTINGS, (setting) => {
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
      Arr.filter(SETTINGS, ({ key, machine }) => key !== GIVEN_ONLY && machine !== true),
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

export const flockReach = (readable: boolean, machines: ReadonlyArray<Reached>) => {
  if (!readable) return { refused: "Not set: the Flock's settings could not be read" };
  const { behind, all, of } = reachedOf(machines);
  if (all) return { said: `Given to all ${machines.length} Machines`, tone: "ok" };
  const names = Arr.map(behind, ({ name }) => name);
  return {
    said: `Given to ${of} · ${listed(names)} ${names.length === 1 ? "gets it when it connects" : "get it when they connect"}`,
    tone: "warn",
  };
};

export const syncPill = (readable: boolean, machines: ReadonlyArray<Reached>) => {
  if (!readable) return { said: "Showing the Flock's settings as last read", tone: "warn" };
  const { behind, all, of } = reachedOf(machines);
  if (all) return { said: `In sync with all ${machines.length} Machines`, tone: "ok" };
  const lagging = Arr.map(
    behind,
    ({ name, state }) => `${name} ${state === "live" ? "behind" : "out of reach"}`,
  );
  return { said: `In sync with ${of} · ${listed(lagging)}`, tone: "warn" };
};
