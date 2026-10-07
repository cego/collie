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

export interface Setting {
  /** As config.json holds it, dotted where it is nested. */
  readonly key: string;
  readonly kind: SettingKind;
  readonly choices: ReadonlyArray<string>;
  /** What a Run uses while it is unset, as text; empty where the harness decides. */
  readonly fallback: string;
}

export const SettingValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);
export type SettingValue = typeof SettingValue.Type;

const choice = (key: string, choices: ReadonlyArray<string>, fallback: string): Setting => ({
  key,
  kind: "choice",
  choices,
  fallback,
});
const of = (key: string, kind: SettingKind, fallback: string): Setting => ({
  key,
  kind,
  choices: [],
  fallback,
});
const D = FALLBACK_DEFAULTS;

export const SETTINGS: ReadonlyArray<Setting> = [
  choice("harness", HARNESS_NAMES, D.harness),
  of("model", "text", D.model),
  of("effort", "text", ""),
  choice("trust", ["auto", "never"], D.trust),
  choice("permissions", PERMISSION_MODES, D.permissions),
  choice("scope", SCOPES, D.scope),
  choice("questions", QUESTION_MODES, D.questions),
  choice("density", DENSITIES, D.density),
  of("gitlab_host", "text", D.gitlabHost),
  of("max_iterations", "number", String(D.maxIterations)),
  of("handoff_timeout_ms", "number", String(D.handoffTimeoutMs)),
  of("quiet_ms", "number", String(D.quietMs)),
  of("board_quiet_ms", "number", String(D.boardQuietMs)),
  of("compact_at_tokens", "number", String(D.compactAtTokens)),
  of("proactive", "boolean", String(D.proactive)),
  ...HARNESS_NAMES.map((harness) => of(`models.${harness}`, "list", "")),
  ...NOTIFICATION_KINDS.map((kind) => of(`notifications.${kind}`, "boolean", "true")),
];

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
