import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Schema } from "effect";
import { ago, epochMs } from "../../../src/time";
import {
  busiestWindow,
  current,
  isFull,
  resetPhrase,
  SUBSCRIPTIONS,
  UsageReading,
  usedPhrase,
  WARN_PERCENT,
} from "../../../src/usage-model";
import type { Subscription } from "../../../src/usage-model";

export const MachineUsage = Schema.Struct({
  profile: Schema.String,
  name: Schema.String,
  readings: Schema.Array(UsageReading),
  problem: Schema.NullOr(Schema.String),
});
export type MachineUsage = typeof MachineUsage.Type;

export const UPGRADE_SAID = "can't say; upgrade this Machine";

const USAGE_EVERY_MS = 60_000;

export const usageDue = (askedAt: number | null, now: number, shown: boolean) =>
  shown && (askedAt === null || now - askedAt >= USAGE_EVERY_MS);

export type Level = "ok" | "warn" | "out";

const levelOf = (usedPercent: number, exhausted: boolean) =>
  exhausted ? "out" : usedPercent >= WARN_PERCENT ? "warn" : "ok";

const NAMES = { claude: "Claude", chatgpt: "ChatGPT" } satisfies Record<Subscription, string>;

const SOURCES = {
  "claude-usage": "Claude's usage endpoint",
  "claude-status-line": "a Claude status line",
  "codex-app-server": "Codex's app server",
} satisfies Record<UsageReading["source"], string>;

export interface UsageEntry {
  readonly key: string;
  readonly text: string;
  readonly level: Level;
  readonly title: string;
}

export interface UsageAccount {
  readonly key: string;
  readonly subscription: Subscription;
  readonly account: string | null;
  readonly label: string | null;
  readonly newest: { readonly reading: UsageReading; readonly machine: string } | null;
  readonly machines: ReadonlyArray<{ readonly machine: string; readonly reading: UsageReading }>;
}

// WARNING: ChatGPT's account id is its workspace's, shared by every seat, so the email tells seats apart.
const accountKey = (reading: UsageReading, machine: string) =>
  reading.account === null
    ? `${reading.subscription}:on ${machine}`
    : reading.subscription === "chatgpt"
      ? `${reading.subscription}:${reading.account}:${reading.accountLabel ?? ""}`
      : `${reading.subscription}:${reading.account}`;

const byLabel = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : pipe(a, Str.localeCompare(b));

export const usageAccounts = (
  machines: ReadonlyArray<MachineUsage>,
  live: ReadonlyArray<string>,
) => {
  const groups = new Map<string, UsageAccount>();
  for (const profile of live) {
    for (const { name, readings } of Arr.filter(
      machines,
      (machine) => machine.profile === profile,
    )) {
      for (const reading of readings) {
        const key = accountKey(reading, name);
        const held = groups.get(key);
        const newest = held?.newest ?? null;
        const newer =
          reading.windows.length > 0 &&
          (newest === null || epochMs(reading.at) > epochMs(newest.reading.at));
        groups.set(key, {
          key,
          subscription: reading.subscription,
          account: reading.account,
          label: held?.label ?? reading.accountLabel,
          newest: newer ? { reading, machine: name } : newest,
          machines: [...(held?.machines ?? []), { machine: name, reading }],
        });
      }
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      SUBSCRIPTIONS.indexOf(a.subscription) - SUBSCRIPTIONS.indexOf(b.subscription) ||
      byLabel(a.label, b.label),
  );
};

export const usageEntries = (
  machines: ReadonlyArray<MachineUsage>,
  live: ReadonlyArray<string>,
  now: number,
) => {
  const shown = Arr.flatMap(usageAccounts(machines, live), ({ key, newest }) =>
    newest === null ? [] : [{ key, ...newest }],
  );
  const accounts = new Map<Subscription, number>();
  for (const { reading } of shown) {
    accounts.set(reading.subscription, (accounts.get(reading.subscription) ?? 0) + 1);
  }
  return Arr.flatMap(shown, ({ key, reading, machine }) => {
    const used = busiestWindow(reading, now);
    if (used === null) {
      return [];
    }
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
        text: `${NAMES[reading.subscription]}${label} ${usedPhrase(used)}`,
        level: levelOf(used.usedPercent, used.exhausted),
        title: Arr.join(
          Arr.filter(
            [reading.accountLabel, reset, `read on ${machine} ${ago(reading.at, now)}`],
            (part) => part !== null,
          ),
          " · ",
        ),
      },
    ];
  });
};

export interface WindowView {
  readonly key: string;
  readonly label: string;
  readonly percent: number;
  readonly level: Level;
  readonly reset: string | null;
}

export interface UsageSection {
  readonly key: string;
  readonly title: string;
  readonly windows: ReadonlyArray<WindowView>;
  readonly said: string | null;
  readonly machines: ReadonlyArray<{ readonly name: string; readonly problem: string | null }>;
}

export interface UsagePageView {
  readonly sections: ReadonlyArray<UsageSection>;
  readonly notRead: ReadonlyArray<{ readonly key: string; readonly said: string }>;
}

const windowsOf = (reading: UsageReading, now: number) =>
  Arr.map(reading.windows, (raw, i) => {
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

const titleOf = (reading: UsageReading) =>
  Arr.join(
    Arr.filter(
      [NAMES[reading.subscription], reading.plan, reading.accountLabel],
      (part) => part !== null,
    ),
    " · ",
  );

export const usagePage = (
  machines: ReadonlyArray<MachineUsage>,
  live: ReadonlyArray<string>,
  now: number,
) => {
  const sections = Arr.flatMap(
    usageAccounts(machines, live),
    ({ key, account, newest, machines: readers }) => {
      if (account === null && newest === null) {
        return [];
      }
      const titled =
        newest?.reading ??
        Arr.reduce(Arr.drop(readers, 1), Option.getOrThrow(Arr.head(readers)), (a, b) =>
          epochMs(b.reading.at) > epochMs(a.reading.at) ? b : a,
        ).reading;
      return [
        {
          key,
          title: titleOf(titled),
          windows: newest === null ? [] : windowsOf(newest.reading, now),
          said:
            newest === null
              ? null
              : `as of ${ago(newest.reading.at, now)} · read on ${newest.machine} · ${SOURCES[newest.reading.source]}`,
          machines: Arr.map(readers, ({ machine, reading }) => ({
            name: machine,
            problem: reading.problem,
          })),
        },
      ];
    },
  );
  const notRead = Arr.flatMap(live, (profile) =>
    Arr.ensure(
      pipe(
        machines,
        Arr.filter((machine) => machine.profile === profile),
        Arr.flatMap(({ name, readings, problem }) =>
          Arr.ensure([
            ...(problem === null ? [] : [{ key: profile, said: `${name}: ${problem}` }]),
            ...Arr.flatMap(readings, (reading, i) =>
              reading.account === null && reading.windows.length === 0
                ? [
                    {
                      key: `${profile}:${i}`,
                      said: Arr.join(
                        Arr.filter(
                          [`${name} · ${NAMES[reading.subscription]}`, reading.problem],
                          (part) => part !== null,
                        ),
                        ": ",
                      ),
                    },
                  ]
                : [],
            ),
          ]),
        ),
      ),
    ),
  );
  return { sections, notRead };
};
import * as Option from "effect/Option";
