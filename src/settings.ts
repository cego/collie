// Collie's settings: every key a human may set in config.json, what it takes, what it is
// while unset and what is refused. The TUI's Settings and Desktop's both read this list,
// so a setting added here is offered by both. Pure: Desktop's view bundles it.

import { Option, Schema } from "effect";
import { GITLAB_HOST, isHostName } from "./gitlab-token";
import { NOTIFICATION_KINDS } from "./notify";
import { isString } from "./schema";

/**
 * What the Control Plane's Runs view is a board of: `local` is this Session's own
 * workspace, the board as it has always been; `all` is every workspace of this herdr
 * session that Collie has work in. Here rather than in the board, because it is a
 * default a human sets and every other reader takes the type from `Defaults`.
 */
export type Scope = "local" | "all";

/** How many cards the board fits across. A Setting, and the pane's width overrules it. */
export type Density = "comfortable" | "compact";
export const DENSITIES: ReadonlyArray<Density> = ["comfortable", "compact"];
export function isDensity(value: string): value is Density {
  return DENSITIES.some((density) => density === value);
}
export const SCOPES: ReadonlyArray<Scope> = ["local", "all"];
export function isScope(value: string): value is Scope {
  return SCOPES.some((scope) => scope === value);
}

/**
 * How a Run's question reaches the human. `focus` brings the Session's Collie tab to
 * the front the moment a Choice opens — the behavior every install has had. `notify`
 * leaves the toast and the board's own `asks you` alone but takes no focus, so a
 * question arriving mid-thought does not move the human off what they are doing.
 */
export type Questions = "focus" | "notify";
export const QUESTION_MODES: ReadonlyArray<Questions> = ["focus", "notify"];
export function isQuestionMode(value: string): value is Questions {
  return QUESTION_MODES.some((mode) => mode === value);
}

/**
 * Who decides whether a tool call runs: the harness's own automatic review (`auto`), no
 * one (`bypass`), or the harness's prompt in the agent's own pane (`harness`). `auto` is
 * the default because a prompt nobody is watching stops the Run instead of protecting it,
 * and the review is what stands between an agent and the checkout it works in; `bypass`
 * is an operator's to opt into.
 */
export const PERMISSION_MODES = ["auto", "bypass", "harness"] as const;

/** The harnesses `harness.ts` has an adapter for. */
export const HARNESS_NAMES = ["claude", "codex", "opencode", "pi"] as const;

/**
 * The user-wide threshold in current-context tokens, and the value that turns the
 * feature off. Absolute rather than a percentage of a window: the four harnesses
 * measure different windows, and one number is what a human can reason about.
 */
export const COMPACT_AT_TOKENS = 372_000;
export const COMPACTION_OFF = 0;

export interface Defaults {
  harness: string;
  model: string;
  /** Reasoning effort for every step that does not name its own; unset means the harness decides. */
  effort?: string;
  maxIterations: number;
  /** How long a Step may wait for the human after the agent hands off. */
  handoffTimeoutMs: number;
  /**
   * How long an agent may produce nothing before it is nudged. Nudged again at
   * double, given up on at triple. `0` waits for as long as it takes.
   */
  quietMs: number;
  /**
   * How long a running run's directory may go unchanged before the board calls it quiet.
   * Separate from `quietMs`, which is what the Driver holds one step's agent to: this is
   * a whole run writing nothing, read from the outside, and the two are worth different
   * numbers.
   */
  boardQuietMs: number;
  /**
   * Current-context tokens at or above which a reused agent is asked to compact before
   * it is given its next piece of work. `0` turns the feature off. As written rather
   * than coerced: the fallback would be the default, so a value someone meant as a
   * lower limit would silently compact an agent they had tried to leave alone.
   */
  compactAtTokens: number;
  /** Extra models to accept per harness, for models the adapter table does not list. */
  models: Readonly<Record<string, ReadonlyArray<string>>>;
  /** `harness` or `harness/model`, in order: where work goes once its Subscription is Exhausted. */
  fallbacks: ReadonlyArray<string>;
  /** What to do about a directory the harness has not been trusted with yet. */
  trust: "auto" | "never";
  /**
   * Whether the harness reviews an agent's tool calls itself, or asks in its pane. As
   * written, like `harness` and `model`: validation names an unknown one, and the engine
   * starts an agent it cannot resolve in `auto`, the default.
   */
  permissions: string;
  /** Which scope the Control Plane opens on. `g` changes it for that tab only. */
  scope: Scope;
  /** How many cards the board fits across, where the pane is wide enough for a choice. */
  density: Density;
  /** `notifications.<kind>: false` turns that kind of toast off; absent means on. */
  notifications: Readonly<Record<string, boolean>>;
  /** Whether a new question takes the human's focus, or only says so. */
  questions: Questions;
  /**
   * Whether Collie starts a turn of its own when something meaningful happens — a Run
   * stopping, asking, going round, or claiming to be finished without proving it. On by
   * default: a conversation you have to start every time is polling by hand.
   *
   * It changes what is *said*, never what may be *done*: a proposal from a proactive
   * turn goes through the same authority path as one you typed.
   */
  proactive: boolean;
  /** The one GitLab doctor and onboard check a Machine against. */
  gitlabHost: string;
}

export const FALLBACK_DEFAULTS: Defaults = {
  harness: "claude",
  model: "opus",
  maxIterations: 5,
  handoffTimeoutMs: 2 * 60 * 60 * 1000,
  quietMs: 10 * 60 * 1000,
  boardQuietMs: 5 * 60 * 1000,
  compactAtTokens: COMPACT_AT_TOKENS,
  models: {},
  fallbacks: [],
  trust: "auto",
  permissions: "auto",
  scope: "local",
  density: "comfortable",
  notifications: {},
  questions: "focus",
  proactive: true,
  gitlabHost: GITLAB_HOST,
};

/**
 * How a setting is typed: one of `choices`, a whole number, free text, on or off, or a
 * comma-separated list.
 */
export type SettingKind = "choice" | "number" | "text" | "boolean" | "list";

/** Where a setting is shown, in the order it is shown. */
export const SETTING_GROUPS = [
  "Agents",
  "Runs",
  "Board",
  "Chat",
  "Notifications",
  "GitLab and credentials",
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/** What a number is shown and typed in: `minutes` of a value stored in milliseconds, or a label. */
export type SettingUnit = "minutes" | "tokens";

export interface Setting {
  /** As config.json holds it, dotted where it is nested. */
  readonly key: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  /** What a Run uses while it is unset, as text; empty where the harness decides. */
  readonly fallback: string;
  readonly group: SettingGroup;
  readonly label: string;
  /** What it changes, in a sentence or two. */
  readonly description: string;
  readonly unit?: SettingUnit;
}

export const SettingValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type SettingValue = typeof SettingValue.Type;

type Explained = Pick<Setting, "group" | "label" | "description" | "unit">;

const choice = (
  key: string,
  choices: ReadonlyArray<string>,
  fallback: string,
  explained: Explained,
): Setting => ({ key, kind: "choice", choices, fallback, ...explained });
const of = (key: string, kind: SettingKind, fallback: string, explained: Explained): Setting => ({
  key,
  kind,
  choices: [],
  fallback,
  ...explained,
});
const D = FALLBACK_DEFAULTS;

const HARNESS_TITLES = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
} satisfies Record<(typeof HARNESS_NAMES)[number], string>;

const NOTIFICATION_WORDS = {
  "needs-you": ["A Run needs you", "a Run stops to ask you something"],
  "run-done": ["A Run finished", "a Run finishes well"],
  "run-failed": ["A Run failed", "a Run fails"],
  "output-unusable": ["An Output was unusable", "a Run stops on an agent's Output it cannot read"],
  "mr-opened": ["A merge request opened", "a Run opens a merge request"],
  "drift-unresolved": [
    "Drift nobody settled",
    "a Run drifted from what it was asked and Collie could not correct it",
  ],
  "correction-sent": ["A correction was sent", "Collie corrects an agent by itself"],
  "proposal-pending": [
    "Something waits for a yes",
    "something waits for your yes or no before anything else happens",
  ],
  "slice-ready": ["A slice to try", "a Run has a slice of work you can try"],
  "intent-changed": ["The Intent changed", "a Run is given a new Intent"],
} satisfies Record<(typeof NOTIFICATION_KINDS)[number], readonly [string, string]>;

export const SETTINGS: ReadonlyArray<Setting> = [
  choice("harness", HARNESS_NAMES, D.harness, {
    group: "Agents",
    label: "Harness",
    description: "The coding agent every step runs in, unless the step names its own.",
  }),
  of("model", "text", D.model, {
    group: "Agents",
    label: "Model",
    description: "The model every step's agent uses, unless the step names its own.",
  }),
  of("effort", "text", "", {
    group: "Agents",
    label: "Reasoning effort",
    description:
      "How hard every step's agent thinks, unless the step names its own. Unset leaves it to the harness.",
  }),
  ...HARNESS_NAMES.map((harness) =>
    of(`models.${harness}`, "list", "", {
      group: "Agents",
      label: `More ${HARNESS_TITLES[harness]} models`,
      description: `Model names ${HARNESS_TITLES[harness]} is allowed to run beyond the ones Collie knows, separated by commas.`,
    }),
  ),
  of("fallbacks", "list", "", {
    group: "Agents",
    label: "Fall back to",
    description:
      "When the agent a step would run on has used up its subscription, the step runs on the first of these with usage left: a harness, or harness/model, in order. Empty keeps it waiting for the reset.",
  }),
  choice("permissions", PERMISSION_MODES, D.permissions, {
    group: "Agents",
    label: "Tool permissions",
    description:
      "Who decides whether an agent's tool call runs: the harness's own review (auto), no one (bypass), or a prompt in the agent's pane (harness).",
  }),
  choice("trust", ["auto", "never"], D.trust, {
    group: "Agents",
    label: "Trust new folders",
    description:
      "Whether Collie trusts a folder the harness has not been trusted with yet (auto), or leaves the harness to ask (never).",
  }),
  of("compact_at_tokens", "number", String(D.compactAtTokens), {
    group: "Agents",
    label: "Compact at",
    description:
      "A reused agent whose context reaches this many tokens is asked to compact before its next piece of work. 0 turns compaction off.",
    unit: "tokens",
  }),
  of("quiet_ms", "number", String(D.quietMs), {
    group: "Agents",
    label: "Quiet before a nudge",
    description:
      "An agent that produces nothing this long is nudged, nudged again at double and given up on at triple. 0 waits as long as it takes.",
    unit: "minutes",
  }),
  of("max_iterations", "number", String(D.maxIterations), {
    group: "Runs",
    label: "Rounds of review",
    description: "How many review-and-fix rounds a Run goes before it stops and asks you.",
  }),
  of("handoff_timeout_ms", "number", String(D.handoffTimeoutMs), {
    group: "Runs",
    label: "Wait for you",
    description: "How long a step waits for you after its agent hands off, before it gives up.",
    unit: "minutes",
  }),
  choice("scope", SCOPES, D.scope, {
    group: "Board",
    label: "Board scope",
    description:
      "Whether the TUI's board opens on this workspace's Runs (local) or every workspace's (all). Desktop's board is not changed.",
  }),
  choice("density", DENSITIES, D.density, {
    group: "Board",
    label: "Card density",
    description:
      "How many cards the TUI's board fits across where its pane is wide enough. Desktop's board is not changed.",
  }),
  of("board_quiet_ms", "number", String(D.boardQuietMs), {
    group: "Board",
    label: "Quiet Run",
    description: "How long a running Run may write nothing before its card calls it quiet.",
    unit: "minutes",
  }),
  of("proactive", "boolean", String(D.proactive), {
    group: "Chat",
    label: "Native chat speaks first",
    description:
      "Whether each Machine's Native chat starts a turn when a Run stops, asks or goes round. The Flock chat has its own switch.",
  }),
  choice("questions", QUESTION_MODES, D.questions, {
    group: "Notifications",
    label: "A new question",
    description:
      "Whether a Run's question brings the TUI's Collie tab to the front (focus) or only says so (notify).",
  }),
  ...NOTIFICATION_KINDS.map((kind) =>
    of(`notifications.${kind}`, "boolean", "true", {
      group: "Notifications",
      label: NOTIFICATION_WORDS[kind][0],
      description: `A toast when ${NOTIFICATION_WORDS[kind][1]}.`,
    }),
  ),
  of("gitlab_host", "text", D.gitlabHost, {
    group: "GitLab and credentials",
    label: "GitLab host",
    description:
      "The GitLab every Machine is onboarded and checked against, and the one its token is made on.",
  }),
];

/** Why a `fallbacks` entry is refused: a harness Collie has, then optionally `/model`. */
function fallbackProblem(entry: string): string | null {
  const at = entry.indexOf("/");
  const harness = at === -1 ? entry : entry.slice(0, at);
  if (!HARNESS_NAMES.some((name) => name === harness))
    return `"${entry}" names no harness Collie has (${HARNESS_NAMES.join(", ")})`;
  return at === entry.length - 1 ? `"${entry}" names no model after its /` : null;
}

export const settingOf = (key: string) => SETTINGS.find((setting) => setting.key === key);

/**
 * What was typed, as the value written; `null` unsets it. Trimmed, and empty is unset:
 * an empty string is a configured value, and an empty `harness` fails every Run. A
 * number arrives as one, because `loadDefaults` ignores a string where it reads one.
 */
export function parseSetting(
  key: string,
  typed: string,
): { readonly value: SettingValue | null } | { readonly refused: string } {
  const setting = settingOf(key);
  if (setting === undefined) return { refused: `${key} is not one of Collie's settings` };
  const said = typed.trim();
  if (said === "") return { value: null };
  switch (setting.kind) {
    case "number":
      // Within the safe integers too: a threshold no Run can use fails every launch.
      return /^\d+$/.test(said) && Number.isSafeInteger(Number(said))
        ? { value: Number(said) }
        : { refused: `${key} has to be a whole number, not "${typed}"` };
    case "choice":
      return setting.choices.includes(said)
        ? { value: said }
        : { refused: `${key} has to be one of ${setting.choices.join(", ")}, not "${typed}"` };
    case "boolean":
      return said === "true" || said === "false"
        ? { value: said === "true" }
        : { refused: `${key} has to be true or false, not "${typed}"` };
    case "list": {
      const items = said
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      const bad =
        key === "fallbacks" ? items.map(fallbackProblem).find((one) => one !== null) : null;
      if (bad !== undefined && bad !== null) return { refused: `fallbacks: ${bad}` };
      return { value: items.length === 0 ? null : items };
    }
    case "text":
      return key === "gitlab_host" && !isHostName(said)
        ? {
            refused: `gitlab_host has to be a host name, such as gitlab.example.com, not "${typed}"`,
          }
        : { value: said };
  }
}

const msPer = (key: string) => (settingOf(key)?.unit === "minutes" ? 60_000 : undefined);

/** A stored value as typed in its unit: a duration in minutes, decimals only where needed. */
export function settingShown(key: string, stored: string): string {
  const per = msPer(key);
  return per === undefined || stored.trim() === "" ? stored : String(Number(stored) / per);
}

/** A value typed in its unit as the text `parseSetting` takes: a duration in whole milliseconds. */
export function settingStored(
  key: string,
  typed: string,
): { readonly stored: string } | { readonly refused: string } {
  const per = msPer(key);
  const said = typed.trim();
  if (per === undefined || said === "") return { stored: said };
  const minutes = Number(said);
  return Number.isFinite(minutes) && minutes >= 0
    ? { stored: String(Math.round(minutes * per)) }
    : { refused: `${key} has to be a number of minutes, not "${typed}"` };
}

/** A setting's value as one line of text, which `parseSetting` reads back to the same value. */
export function settingText(value: SettingValue | null): string {
  if (value === null) return "";
  if (isString(value)) return value;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** A value one Machine shares for `key`, checked as an edit of it would be. */
export function parseShared(
  key: string,
  value: Schema.Json | null,
): { readonly value: SettingValue | null } | { readonly refused: string } {
  const typed = Schema.decodeUnknownOption(Schema.NullOr(SettingValue))(value);
  return Option.isSome(typed)
    ? parseSetting(key, settingText(typed.value))
    : { refused: `${key} cannot take that value` };
}
