// A Subscription's Usage reading and every judgement made from it (ADR-0049). Pure, so
// Desktop's view and a workflow module reach the same rules as the host.

import { DateTime, Schema } from "effect";
import { epochMs } from "./time";

export const SUBSCRIPTIONS = ["claude", "chatgpt"] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];

export const UsageWindow = Schema.Struct({
  kind: Schema.Literals(["session", "weekly", "weekly-model", "other"]),
  label: Schema.String,
  /** The model a `weekly-model` window applies to. */
  model: Schema.NullOr(Schema.String),
  /** 0–100. */
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
  /** The source said this window is reached, whatever its percent. */
  reached: Schema.Boolean,
});
export type UsageWindow = typeof UsageWindow.Type;

export const UsageReading = Schema.Struct({
  subscription: Schema.Literals(SUBSCRIPTIONS),
  /** The account's stable id; never an email, which can hold a personal plan and a team seat. */
  account: Schema.NullOr(Schema.String),
  accountLabel: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  windows: Schema.Array(UsageWindow),
  /** When these numbers were true. */
  at: Schema.String,
  source: Schema.Literals(["claude-usage", "claude-status-line", "codex-app-server"]),
  /** Why there is no fresh reading, as a sentence a human can act on. */
  problem: Schema.NullOr(Schema.String),
});
export type UsageReading = typeof UsageReading.Type;

export interface ChoiceLike {
  readonly harness: string;
  readonly model: string;
}

const PROVIDERS = new Map<string, Subscription>([
  ["anthropic", "claude"],
  ["openai-codex", "chatgpt"],
]);

/** The Subscription a choice draws on, or null where Collie reads none for it. */
export function subscriptionOf(choice: ChoiceLike): Subscription | null {
  if (choice.harness === "claude") return "claude";
  if (choice.harness === "codex") return "chatgpt";
  if (choice.harness !== "pi" && choice.harness !== "opencode") return null;
  return PROVIDERS.get(choice.model.split("/")[0] ?? "") ?? null;
}

const squeezed = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A model window applies to a model that names the window's model, in any case and
 * spelling: `opus` and `claude-opus-4-1` an "Opus" window, `sonnet` a "Sonnet 4.5" one. A
 * choice left at `default` is resolved by its caller; unresolved, it names no model.
 */
export function appliesTo(window: UsageWindow, model: string | null): boolean {
  if (window.model === null) return true;
  if (model === null) return false;
  return squeezed(model).includes(squeezed(window.model.split(" ")[0] ?? ""));
}

/** A window as it stands at `now`: once its reset has passed it is unused, whatever was read. */
export function current(window: UsageWindow, now: number): UsageWindow {
  if (window.resetsAt === null || epochMs(window.resetsAt) > now) return window;
  return { ...window, usedPercent: 0, reached: false };
}

export const isFull = (window: UsageWindow) => window.reached || window.usedPercent >= 100;

export interface Used {
  readonly window: UsageWindow;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly exhausted: boolean;
}

/** The busiest of these windows, counting a full one as busier than any that is not. */
function busiest(windows: ReadonlyArray<UsageWindow>): Used | null {
  let found: UsageWindow | null = null;
  const weight = (window: UsageWindow) => (isFull(window) ? 101 : window.usedPercent);
  for (const window of windows)
    if (found === null || weight(window) > weight(found)) found = window;
  if (found === null) return null;
  return {
    window: found,
    usedPercent: isFull(found) ? 100 : found.usedPercent,
    resetsAt: found.resetsAt,
    exhausted: isFull(found),
  };
}

/**
 * How much of the busiest window that applies to this choice is used, and whether its
 * Subscription is Exhausted for it. Null where nothing is read for it.
 */
export function usedFor(
  readings: ReadonlyArray<UsageReading>,
  choice: ChoiceLike,
  now: number,
): Used | null {
  const subscription = subscriptionOf(choice);
  const model = choice.model;
  return busiest(
    readings
      .filter((reading) => reading.subscription === subscription)
      .flatMap((reading) => reading.windows)
      .filter((window) => appliesTo(window, model))
      .map((window) => current(window, now)),
  );
}

/** At or above this, a door warns. */
export const WARN_PERCENT = 90;

export interface UsagePhrase {
  /** For example `claude 31% · chatgpt out`; empty where nothing is read. */
  readonly text: string;
  readonly warn: boolean;
}

/** A reading's busiest window at `now` of those that apply to every model. */
export function busiestGeneral(reading: UsageReading, now: number): Used | null {
  // A model's own window says nothing about the Subscription's other models.
  const general = reading.windows.filter((window) => window.model === null);
  return busiest(general.map((window) => current(window, now)));
}

/** Each Subscription's busiest window, in a few characters. */
export function usagePhrase(readings: ReadonlyArray<UsageReading>, now: number): UsagePhrase {
  const parts: string[] = [];
  let warn = false;
  for (const reading of readings) {
    const used = busiestGeneral(reading, now);
    if (used === null) continue;
    warn ||= used.usedPercent >= WARN_PERCENT;
    parts.push(
      `${reading.subscription} ${used.exhausted ? "out" : `${Math.round(used.usedPercent)}%`}`,
    );
  }
  return { text: parts.join(" · "), warn };
}

// The sources, as they answer. Every field optional: two of the three are undocumented.

const ClaudeRow = Schema.Struct({
  utilization: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  locked_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  kind: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({ display_name: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
          ),
        ),
      }),
    ),
  ),
});
type ClaudeRow = typeof ClaudeRow.Type;
export const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optionalKey(Schema.NullOr(ClaudeRow)),
  seven_day: Schema.optionalKey(Schema.NullOr(ClaudeRow)),
  limits: Schema.optionalKey(Schema.NullOr(Schema.Array(ClaudeRow))),
});
export type ClaudeUsage = typeof ClaudeUsage.Type;

/** The account a reading belongs to, as its login says. */
export interface Login {
  readonly account: string | null;
  readonly accountLabel: string | null;
  readonly plan: string | null;
}

function claudeWindow(
  row: ClaudeRow,
  kind: UsageWindow["kind"],
  label: string,
  model: string | null,
): UsageWindow {
  return {
    kind,
    label,
    model,
    usedPercent: row.percent ?? row.utilization ?? 0,
    resetsAt: row.resets_at ?? null,
    // A severity is a display level only; credits beyond the plan mark nothing.
    reached: (row.locked_reason ?? null) !== null,
  };
}

function claudeLimit(row: ClaudeRow): UsageWindow {
  switch (row.kind) {
    case "session":
      return claudeWindow(row, "session", "Session", null);
    case "weekly_all":
      return claudeWindow(row, "weekly", "Weekly", null);
    case "weekly_scoped": {
      const model = row.scope?.model?.display_name ?? null;
      return model === null
        ? claudeWindow(row, "other", "Weekly (scoped)", null)
        : claudeWindow(row, "weekly-model", `Weekly ${model}`, model);
    }
    default:
      return claudeWindow(row, "other", row.kind ?? "Other", null);
  }
}

/** `GET /api/oauth/usage`'s answer as windows: by `limits[].kind`, else the older two rows. */
export function claudeWindows(usage: ClaudeUsage): ReadonlyArray<UsageWindow> {
  if (usage.limits) return usage.limits.map(claudeLimit);
  return [
    ...(usage.five_hour ? [claudeWindow(usage.five_hour, "session", "Session", null)] : []),
    ...(usage.seven_day ? [claudeWindow(usage.seven_day, "weekly", "Weekly", null)] : []),
  ];
}

export const ClaudeJson = Schema.Struct({
  oauthAccount: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        accountUuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
        organizationUuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
        emailAddress: Schema.optionalKey(Schema.NullOr(Schema.String)),
        organizationName: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});
export type ClaudeJson = typeof ClaudeJson.Type;
const TEAM_PLANS = new Set(["team", "enterprise"]);

/** Claude Code's `~/.claude.json` account, with the plan its login says. */
export function claudeLogin(claudeJson: ClaudeJson | null, plan: string | null): Login {
  const found = claudeJson?.oauthAccount ?? null;
  const ids = [found?.organizationUuid, found?.accountUuid].filter((id) => id != null);
  const email = found?.emailAddress ?? null;
  const team = plan !== null && TEAM_PLANS.has(plan) ? (found?.organizationName ?? null) : null;
  return {
    account: ids.length === 0 ? null : ids.join(":"),
    accountLabel: email === null ? null : team === null ? email : `${email} (${team})`,
    plan,
  };
}

const StatusWindow = Schema.Struct({
  used_percentage: Schema.Number,
  /** Epoch seconds. */
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
export const StatusLineLimits = Schema.Struct({
  five_hour: Schema.optionalKey(Schema.NullOr(StatusWindow)),
  seven_day: Schema.optionalKey(Schema.NullOr(StatusWindow)),
});
export type StatusLineLimits = typeof StatusLineLimits.Type;

/** The newest Claude status line's limits on a Machine, and when it reported them. */
export interface StatusSample {
  readonly at: number;
  readonly limits: StatusLineLimits;
}

const isoOfSeconds = (seconds: number | null | undefined) =>
  seconds == null ? null : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

/** A Claude status line's `rate_limits`, as the session and weekly windows it measures. */
export function statusLineWindows(limits: StatusLineLimits): ReadonlyArray<UsageWindow> {
  const window = (
    row: typeof StatusWindow.Type | null | undefined,
    kind: "session" | "weekly",
    label: string,
  ): ReadonlyArray<UsageWindow> =>
    row
      ? [
          {
            kind,
            label,
            model: null,
            usedPercent: row.used_percentage,
            resetsAt: isoOfSeconds(row.resets_at),
            reached: false,
          },
        ]
      : [];
  return [
    ...window(limits.five_hour, "session", "Session"),
    ...window(limits.seven_day, "weekly", "Weekly"),
  ];
}

const CodexWindow = Schema.Struct({
  usedPercent: Schema.Number,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  /** Epoch seconds. */
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const CodexLimit = Schema.Struct({
  limitName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  primary: Schema.optionalKey(Schema.NullOr(CodexWindow)),
  secondary: Schema.optionalKey(Schema.NullOr(CodexWindow)),
  planType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rateLimitReachedType: Schema.optionalKey(Schema.NullOr(Schema.String)),
  spendControlReached: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});
type CodexLimit = typeof CodexLimit.Type;
export const CodexRateLimits = Schema.Struct({
  ordinaryUsageAllowed: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  rateLimits: CodexLimit,
  rateLimitsByLimitId: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, CodexLimit))),
});
export type CodexRateLimits = typeof CodexRateLimits.Type;

export const CodexAccount = Schema.Struct({
  account: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        email: Schema.optionalKey(Schema.NullOr(Schema.String)),
        planType: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  workspaceRouting: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ chatgptAccountId: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
export type CodexAccount = typeof CodexAccount.Type;

/** `account/read`'s result as the account a ChatGPT reading belongs to. */
export function codexLogin(found: CodexAccount): Login {
  return {
    account: found?.workspaceRouting?.chatgptAccountId ?? null,
    accountLabel: found?.account?.email ?? null,
    plan: found?.account?.planType ?? null,
  };
}

const kindOfLength = (length: number | null) =>
  length === 300 ? "session" : length === 10080 ? "weekly" : "other";

/**
 * One limit's windows. A limit its source says is reached marks its full window
 * reached, or every window of it when none is full.
 */
function codexWindows(
  limit: CodexLimit,
  model: string | null,
  blocked: boolean,
): ReadonlyArray<UsageWindow> {
  const rows = [limit.primary, limit.secondary].filter((row) => row != null);
  const reached =
    blocked || (limit.rateLimitReachedType ?? null) !== null || limit.spendControlReached === true;
  const full = rows.some((row) => row.usedPercent >= 100);
  return rows.map((row) => {
    const length = row.windowDurationMins ?? null;
    const kind = kindOfLength(length);
    const label =
      kind === "session" ? "Session" : kind === "weekly" ? "Weekly" : `${length ?? "?"} min`;
    return {
      kind: model === null ? kind : "weekly-model",
      label: model === null ? label : `${label} ${model}`,
      model,
      usedPercent: row.usedPercent,
      resetsAt: isoOfSeconds(row.resetsAt),
      reached: reached && (!full || row.usedPercent >= 100),
    };
  });
}

/**
 * `account/rateLimits/read`'s result as windows and a plan, classified by each window's
 * length because `primary` is the weekly window on some plans. Every limit other than
 * `codex` is a model's own.
 */
export function codexUsage(usage: CodexRateLimits) {
  return {
    windows: [
      ...codexWindows(usage.rateLimits, null, usage.ordinaryUsageAllowed === false),
      ...Object.entries(usage.rateLimitsByLimitId ?? {})
        .filter(([id]) => id !== "codex")
        .flatMap(([id, limit]) => codexWindows(limit, limit.limitName ?? id, false)),
    ],
    plan: usage.rateLimits.planType ?? null,
  };
}

/** How long until a reset, in its two largest units: `in 2h 3m`, `in 1d 4h`, `in 12m`. */
export function resetIn(resetsAt: string, now: number): string {
  const minutes = Math.max(0, Math.ceil((epochMs(resetsAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${minutes % 60}m`;
  return `in ${minutes}m`;
}

const resetClock = (iso: string, now: number) => {
  const at = DateTime.makeUnsafe(iso);
  const day = (time: DateTime.DateTime) => DateTime.formatLocal(time, { dateStyle: "short" });
  const time = DateTime.formatLocal(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return day(at) === day(DateTime.makeUnsafe(now))
    ? time
    : `${DateTime.formatLocal(at, { weekday: "short", locale: "en-GB" })} ${time}`;
};

/** A reset as a local clock time and how long until it: `resets 14:00 (in 2h 3m)`. */
export function resetPhrase(resetsAt: string, now: number): string {
  return `resets ${resetClock(resetsAt, now)} (${resetIn(resetsAt, now)})`;
}
