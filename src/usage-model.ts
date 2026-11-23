import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { DateTime, Schema } from "effect";
import { epochMs } from "./time";

export const SUBSCRIPTIONS = ["claude", "chatgpt"] as const;
export type Subscription = (typeof SUBSCRIPTIONS)[number];

export const UsageWindow = Schema.Struct({
  kind: Schema.Literals(["session", "weekly", "weekly-model", "other"]),
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
  usedPercent: Schema.Finite,
  resetsAt: Schema.NullOr(Schema.String),
  reached: Schema.Boolean,
});
export type UsageWindow = typeof UsageWindow.Type;

export const UsageReading = Schema.Struct({
  subscription: Schema.Literals(SUBSCRIPTIONS),
  // WARNING: the account id is stable and never an email: one address can hold a personal plan and a team seat.
  account: Schema.NullOr(Schema.String),
  accountLabel: Schema.NullOr(Schema.String),
  plan: Schema.NullOr(Schema.String),
  windows: Schema.Array(UsageWindow),
  at: Schema.String,
  source: Schema.Literals(["claude-usage", "claude-status-line", "codex-app-server"]),
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

export function subscriptionOf(choice: ChoiceLike) {
  if (choice.harness === "claude") {
    const returned: Subscription | null = "claude";
    return returned;
  }
  if (choice.harness === "codex") {
    const returned: Subscription | null = "chatgpt";
    return returned;
  }
  if (choice.harness !== "pi" && choice.harness !== "opencode") {
    const returned: Subscription | null = null;
    return returned;
  }
  const returned: Subscription | null =
    PROVIDERS.get(Str.split(choice.model, "/")[0] ?? "") ?? null;
  return returned;
}

const squeezed = (text: string) => pipe(Str.toLowerCase(text), Str.replaceAll(/[^a-z0-9]/g, ""));

// WARNING: a choice left at default is resolved by its caller; unresolved, it names no model.
export function appliesTo(window: UsageWindow, model: string | null) {
  if (window.model === null) {
    return true;
  }
  if (model === null) {
    return false;
  }
  return pipe(squeezed(model), Str.includes(squeezed(Str.split(window.model, " ")[0] ?? "")));
}

// WARNING: a window past its reset is unused, whatever was last read.
export function current(window: UsageWindow, now: number) {
  if (window.resetsAt === null || epochMs(window.resetsAt) > now) {
    const returned: UsageWindow = window;
    return returned;
  }
  const returned: UsageWindow = { ...window, usedPercent: 0, reached: false };
  return returned;
}

export const isFull = (window: UsageWindow) => window.reached || window.usedPercent >= 100;

export interface Used {
  readonly window: UsageWindow;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly exhausted: boolean;
}

function busiest(windows: ReadonlyArray<UsageWindow>) {
  let found: UsageWindow | null = null;
  const weight = (window: UsageWindow) => (isFull(window) ? 101 : window.usedPercent);
  for (const window of windows)
    if (found === null || weight(window) > weight(found)) found = window;
  if (found === null) {
    const returned: Used | null = null;
    return returned;
  }
  const returned: Used | null = {
    window: found,
    usedPercent: isFull(found) ? 100 : found.usedPercent,
    resetsAt: found.resetsAt,
    exhausted: isFull(found),
  };
  return returned;
}

export function usedFor(readings: ReadonlyArray<UsageReading>, choice: ChoiceLike, now: number) {
  const subscription = subscriptionOf(choice);
  const model = choice.model;
  const returned: Used | null = busiest(
    pipe(
      readings,
      Arr.filter((reading) => reading.subscription === subscription),
      Arr.flatMap((reading) => reading.windows),
      Arr.filter((window) => Boolean(appliesTo(window, model))),
      Arr.map((window) => current(window, now)),
    ),
  );
  return returned;
}

export const WARN_PERCENT = 90;

export interface UsagePhrase {
  readonly text: string;
  readonly warn: boolean;
}

export function busiestWindow(reading: UsageReading, now: number) {
  const returned: Used | null = busiest(Arr.map(reading.windows, (window) => current(window, now)));
  return returned;
}

export function usedPhrase(used: Used) {
  const amount = used.exhausted ? "out" : `${Math.round(used.usedPercent)}%`;
  return used.window.model === null ? amount : `${used.window.model} ${amount}`;
}

export function usagePhrase(readings: ReadonlyArray<UsageReading>, now: number) {
  const parts: Array<string> = [];
  let warn = false;
  for (const reading of readings) {
    const used = busiestWindow(reading, now);
    if (used === null) continue;
    warn ||= used.usedPercent >= WARN_PERCENT;
    parts.push(`${reading.subscription} ${usedPhrase(used)}`);
  }
  const returned: UsagePhrase = { text: Arr.join(parts, " · "), warn };
  return returned;
}

// WARNING: every field is optional: two of the three sources are undocumented.
const ClaudeRow = Schema.Struct({
  utilization: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  percent: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
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
) {
  const returned: UsageWindow = {
    kind,
    label,
    model,
    usedPercent: row.percent ?? row.utilization ?? 0,
    resetsAt: row.resets_at ?? null,
    // WARNING: severity is a display level only; credits beyond the plan mark nothing.
    reached: (row.locked_reason ?? null) !== null,
  };
  return returned;
}

function claudeLimit(row: ClaudeRow) {
  switch (row.kind) {
    case "session": {
      const returned: UsageWindow = claudeWindow(row, "session", "Session", null);
      return returned;
    }
    case "weekly_all": {
      const returned: UsageWindow = claudeWindow(row, "weekly", "Weekly", null);
      return returned;
    }
    case "weekly_scoped": {
      const model = row.scope?.model?.display_name ?? null;
      const returned: UsageWindow =
        model === null
          ? claudeWindow(row, "other", "Weekly (scoped)", null)
          : claudeWindow(row, "weekly-model", `Weekly ${model}`, model);
      return returned;
    }
    default: {
      const returned: UsageWindow = claudeWindow(row, "other", row.kind ?? "Other", null);
      return returned;
    }
  }
}

export function claudeWindows(usage: ClaudeUsage) {
  if (usage.limits) {
    const returned: ReadonlyArray<UsageWindow> = Arr.map(usage.limits, claudeLimit);
    return returned;
  }
  const returned: ReadonlyArray<UsageWindow> = [
    ...(usage.five_hour ? [claudeWindow(usage.five_hour, "session", "Session", null)] : []),
    ...(usage.seven_day ? [claudeWindow(usage.seven_day, "weekly", "Weekly", null)] : []),
  ];
  return returned;
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

export function claudeLogin(claudeJson: ClaudeJson | null, plan: string | null) {
  const found = claudeJson?.oauthAccount ?? null;
  const ids = Arr.filter([found?.organizationUuid, found?.accountUuid], (id) => id != null);
  const email = found?.emailAddress ?? null;
  const team = plan !== null && TEAM_PLANS.has(plan) ? (found?.organizationName ?? null) : null;
  const returned: Login = {
    account: ids.length === 0 ? null : Arr.join(ids, ":"),
    accountLabel: email === null ? null : team === null ? email : `${email} (${team})`,
    plan,
  };
  return returned;
}

const StatusWindow = Schema.Struct({
  used_percentage: Schema.Finite,
  resets_at: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
export const StatusLineLimits = Schema.Struct({
  five_hour: Schema.optionalKey(Schema.NullOr(StatusWindow)),
  seven_day: Schema.optionalKey(Schema.NullOr(StatusWindow)),
});
export type StatusLineLimits = typeof StatusLineLimits.Type;

export interface StatusSample {
  readonly at: number;
  readonly limits: StatusLineLimits;
}

const isoOfSeconds = (seconds: number | null | undefined) =>
  seconds == null ? null : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

export function statusLineWindows(limits: StatusLineLimits) {
  const window: (
    row: typeof StatusWindow.Type | null | undefined,
    kind: "session" | "weekly",
    label: string,
  ) => ReadonlyArray<UsageWindow> = (row, kind, label) =>
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
  const returned: ReadonlyArray<UsageWindow> = [
    ...window(limits.five_hour, "session", "Session"),
    ...window(limits.seven_day, "weekly", "Weekly"),
  ];
  return returned;
}

const CodexWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  windowDurationMins: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
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

export function codexLogin(found: CodexAccount) {
  const returned: Login = {
    account: found?.workspaceRouting?.chatgptAccountId ?? null,
    accountLabel: found?.account?.email ?? null,
    plan: found?.account?.planType ?? null,
  };
  return returned;
}

const kindOfLength = (length: number | null) =>
  length === 300 ? "session" : length === 10_080 ? "weekly" : "other";

function codexWindows(limit: CodexLimit, model: string | null, blocked: boolean) {
  const rows = Arr.filter([limit.primary, limit.secondary], (row) => row != null);
  const reached =
    blocked || (limit.rateLimitReachedType ?? null) !== null || limit.spendControlReached === true;
  const full = Arr.some(rows, (row) => row.usedPercent >= 100);
  const returned: ReadonlyArray<UsageWindow> = Arr.map(rows, (row) => {
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
  return returned;
}

export function codexUsage(usage: CodexRateLimits) {
  return {
    windows: [
      ...codexWindows(usage.rateLimits, null, usage.ordinaryUsageAllowed === false),
      ...Arr.flatMap(
        Arr.filter(Rec.toEntries(usage.rateLimitsByLimitId ?? {}), ([id]) => id !== "codex"),
        ([id, limit]) => codexWindows(limit, limit.limitName ?? id, false),
      ),
    ],
    plan: usage.rateLimits.planType ?? null,
  };
}

export function resetIn(resetsAt: string, now: number) {
  const minutes = Math.max(0, Math.ceil((epochMs(resetsAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes % 60}m`;
  }
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

export function resetPhrase(resetsAt: string, now: number) {
  return `resets ${resetClock(resetsAt, now)} (${resetIn(resetsAt, now)})`;
}

export function roomFor(readings: ReadonlyArray<UsageReading>, now: number) {
  return (choice: ChoiceLike, upTo: number | undefined) => {
    const used = usedFor(readings, choice, now);
    if (used === null) {
      const returned: { readonly room: true } | { readonly room: false; readonly why: string } = {
        room: true,
      };
      return returned;
    }
    const over = upTo !== undefined && used.usedPercent >= upTo;
    if (!used.exhausted && !over) {
      const returned: { readonly room: true } | { readonly room: false; readonly why: string } = {
        room: true,
      };
      return returned;
    }
    const parts = [
      `${Str.toLowerCase(used.window.label)} ${Math.round(used.usedPercent)}%`,
      ...(used.exhausted ? [] : [`over its ${upTo}%`]),
      ...(used.resetsAt === null ? [] : [`resets ${resetClock(used.resetsAt, now)}`]),
    ];
    const returned: { readonly room: true } | { readonly room: false; readonly why: string } = {
      room: false,
      why: Arr.join(parts, ", "),
    };
    return returned;
  };
}
