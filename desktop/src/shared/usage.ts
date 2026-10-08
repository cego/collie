// Each Machine's Usage readings as Desktop draws them: the header's entry per Subscription
// and account across the Flock, and a Machine's Usage block (ADR-0049).

import { Schema } from "effect";
import { ago, epochMs } from "../../../src/time";
import {
  busiestGeneral,
  current,
  isFull,
  resetPhrase,
  SUBSCRIPTIONS,
  type Subscription,
  UsageReading,
  WARN_PERCENT,
} from "../../../src/usage-model";

/** What one Machine's host read, or why it read nothing. */
export const MachineUsage = Schema.Struct({
  profile: Schema.String,
  name: Schema.String,
  readings: Schema.Array(UsageReading),
  problem: Schema.NullOr(Schema.String),
});
export type MachineUsage = typeof MachineUsage.Type;

export const UPGRADE_SAID = "can't say; upgrade this Machine";

const USAGE_EVERY_MS = 60_000;

/** Whether to ask each Machine again: at once, then each minute while Desktop is shown. */
export const usageDue = (askedAt: number | null, now: number, shown: boolean) =>
  shown && (askedAt === null || now - askedAt >= USAGE_EVERY_MS);

export type Level = "ok" | "warn" | "out";

const levelOf = (usedPercent: number, exhausted: boolean): Level =>
  exhausted ? "out" : usedPercent >= WARN_PERCENT ? "warn" : "ok";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT" } satisfies Record<Subscription, string>;

const SOURCES = {
  "claude-usage": "Claude's usage endpoint",
  "claude-status-line": "a Claude status line",
  "codex-app-server": "Codex's app server",
} satisfies Record<UsageReading["source"], string>;

export interface UsageEntry {
  readonly key: string;
  /** For example `Claude 72%`, or `Claude out`. */
  readonly text: string;
  readonly level: Level;
  /** Whose it is, its busiest window's reset, and which Machine read it when. */
  readonly title: string;
}

/**
 * One entry per Subscription and account across the Flock. The provider counts usage per
 * account, so of one account's readings the newest is shown.
 */
export const usageEntries = (
  machines: ReadonlyArray<MachineUsage>,
  now: number,
): ReadonlyArray<UsageEntry> => {
  const newest = new Map<string, { reading: UsageReading; machine: string }>();
  for (const { name, readings } of machines)
    for (const reading of readings) {
      if (reading.windows.length === 0) continue;
      const key = `${reading.subscription}:${reading.account ?? `on ${name}`}`;
      const held = newest.get(key);
      if (held === undefined || epochMs(reading.at) > epochMs(held.reading.at))
        newest.set(key, { reading, machine: name });
    }
  const shown = [...newest].sort(
    ([, a], [, b]) =>
      SUBSCRIPTIONS.indexOf(a.reading.subscription) - SUBSCRIPTIONS.indexOf(b.reading.subscription),
  );
  const accounts = new Map<Subscription, number>();
  for (const [, { reading }] of shown)
    accounts.set(reading.subscription, (accounts.get(reading.subscription) ?? 0) + 1);
  return shown.flatMap(([key, { reading, machine }]) => {
    const used = busiestGeneral(reading, now);
    if (used === null) return [];
    const label =
      accounts.get(reading.subscription)! > 1 && reading.accountLabel !== null
        ? ` ${reading.accountLabel}`
        : "";
    const reset =
      used.resetsAt === null
        ? used.window.label
        : `${used.window.label} ${resetPhrase(used.resetsAt, now)}`;
    return [
      {
        key,
        text: `${NAMES[reading.subscription]}${label} ${used.exhausted ? "out" : `${Math.round(used.usedPercent)}%`}`,
        level: levelOf(used.usedPercent, used.exhausted),
        title: [reading.accountLabel, reset, `read on ${machine} ${ago(reading.at, now)}`]
          .filter((part) => part !== null)
          .join(" · "),
      },
    ];
  });
};

export interface WindowView {
  readonly key: string;
  readonly label: string;
  /** 0–100, rounded. */
  readonly percent: number;
  readonly level: Level;
  /** `resets 14:00 (in 2h 10m)`; null where the source gives no reset. */
  readonly reset: string | null;
}

export interface SubscriptionView {
  readonly key: string;
  /** `Claude · max · me@example.com`. */
  readonly title: string;
  readonly windows: ReadonlyArray<WindowView>;
  /** How fresh the numbers are and where they came from, or the reading's problem. */
  readonly said: string;
}

export interface MachineUsageView {
  /** Why the Machine's host gave no readings. */
  readonly said: string | null;
  readonly subscriptions: ReadonlyArray<SubscriptionView>;
}

/** A Machine's Usage block: per Subscription, each window's meter and reset, and its age. */
export const machineUsage = (machine: MachineUsage, now: number): MachineUsageView => ({
  said: machine.problem,
  subscriptions: machine.readings.map((reading, index) => {
    const windows = reading.windows.map((raw, i) => {
      const window = current(raw, now);
      const full = isFull(window);
      return {
        key: `${i}:${window.label}`,
        label: window.label,
        percent: full ? 100 : Math.round(window.usedPercent),
        level: levelOf(window.usedPercent, full),
        reset: window.resetsAt === null ? null : resetPhrase(window.resetsAt, now),
      };
    });
    const age = `as of ${ago(reading.at, now)} · ${SOURCES[reading.source]}`;
    return {
      key: `${index}:${reading.subscription}:${reading.account ?? ""}`,
      title: [NAMES[reading.subscription], reading.plan, reading.accountLabel]
        .filter((part) => part !== null)
        .join(" · "),
      windows,
      said:
        reading.problem === null
          ? age
          : windows.length === 0
            ? reading.problem
            : `${reading.problem} · ${age}`,
    };
  }),
});
