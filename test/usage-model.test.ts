// A Usage reading from each source's recorded answer, and what is judged from it.

import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";
import { epochMs } from "../src/time";
import {
  claudeLogin,
  claudeWindows,
  codexLogin,
  codexUsage,
  statusLineWindows,
  subscriptionOf,
  usagePhrase,
  usedFor,
  type UsageReading,
  type UsageWindow,
} from "../src/usage-model";
import claudeUsage from "./fixtures/usage/claude-oauth-usage.json";
import statusLine from "./fixtures/usage/claude-status-line-rate-limits.json";
import codexRateLimits from "./fixtures/usage/codex-account-ratelimits-read.json";
import codexAccount from "./fixtures/usage/codex-account-read.json";

const NOW = epochMs("2026-10-08T08:00:00Z");
const AFTER_RESET = epochMs("2026-10-08T11:00:00Z");
const isoOfSeconds = (seconds: number) => DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

const window = (over: Partial<UsageWindow>): UsageWindow => ({
  kind: "session",
  label: "Session",
  model: null,
  usedPercent: 0,
  resetsAt: "2026-10-08T10:49:59Z",
  reached: false,
  ...over,
});

const reading = (over: Partial<UsageReading>): UsageReading => ({
  subscription: "claude",
  account: "org:acct",
  accountLabel: "me@example.com",
  plan: "max",
  windows: [],
  at: "2026-10-08T08:00:00Z",
  source: "claude-usage",
  problem: null,
  ...over,
});

const opus = { harness: "claude", model: "opus" };

describe("parsing", () => {
  test("Claude's limits[] become session, weekly and a model's weekly window", () => {
    expect(claudeWindows(claudeUsage)).toEqual([
      window({ usedPercent: 31, resetsAt: "2026-10-08T10:49:59.623151+00:00" }),
      window({
        kind: "weekly",
        label: "Weekly",
        usedPercent: 88,
        resetsAt: "2026-10-09T10:59:59.623170+00:00",
      }),
      window({
        kind: "weekly-model",
        label: "Weekly Fable",
        model: "Fable",
        usedPercent: 0,
        resetsAt: "2026-10-09T11:00:00+00:00",
      }),
    ]);
  });

  test("Claude without limits[] falls back to five_hour and seven_day", () => {
    const { limits: _, ...older } = claudeUsage;
    const locked = {
      ...older,
      seven_day: { ...older.seven_day, locked_reason: "spend_limit" },
    };
    expect(claudeWindows(locked)).toEqual([
      window({ usedPercent: 31, resetsAt: "2026-10-08T10:49:59.623151+00:00" }),
      window({
        kind: "weekly",
        label: "Weekly",
        usedPercent: 88,
        resetsAt: "2026-10-09T10:59:59.623170+00:00",
        reached: true,
      }),
    ]);
  });

  test("Codex's weekly-only primary is classified by its length", () => {
    expect(codexUsage(codexRateLimits.result)).toEqual({
      windows: [
        window({
          kind: "weekly",
          label: "Weekly",
          usedPercent: 2,
          resetsAt: isoOfSeconds(1791973608),
        }),
      ],
      plan: "self_serve_business_prolite",
    });
  });

  test("Codex reached marks the full window, or every window when none is full", () => {
    const limits = (primary: number) => ({
      ...codexRateLimits.result,
      rateLimits: {
        ...codexRateLimits.result.rateLimits,
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: primary, windowDurationMins: 300, resetsAt: 1791457799 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1791973608 },
      },
    });
    expect(codexUsage(limits(100))?.windows.map((w) => [w.kind, w.reached])).toEqual([
      ["session", true],
      ["weekly", false],
    ]);
    expect(codexUsage(limits(70))?.windows.map((w) => [w.kind, w.reached])).toEqual([
      ["session", true],
      ["weekly", true],
    ]);
  });

  test("a model's own Codex limit is its window, reached by its own flags", () => {
    const spark = {
      ...codexRateLimits.result.rateLimits,
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1791973608 },
      rateLimitReachedType: "rate_limit_reached",
    };
    const usage = codexUsage({
      ...codexRateLimits.result,
      rateLimitsByLimitId: { ...codexRateLimits.result.rateLimitsByLimitId, spark },
    });
    expect(usage.windows.map((w) => [w.label, w.model, w.reached])).toEqual([
      ["Weekly", null, false],
      ["Weekly GPT-5.3-Codex-Spark", "GPT-5.3-Codex-Spark", true],
    ]);
    const readings = [reading({ subscription: "chatgpt", windows: usage.windows })];
    expect(
      usedFor(readings, { harness: "codex", model: "gpt-5.3-codex-spark" }, NOW)?.exhausted,
    ).toBe(true);
    expect(usedFor(readings, { harness: "codex", model: "gpt-5" }, NOW)?.exhausted).toBe(false);
  });

  test("a Claude status line's rate_limits are its session and weekly windows", () => {
    expect(statusLineWindows(statusLine.rate_limits)).toEqual([
      window({ usedPercent: 31, resetsAt: isoOfSeconds(1791457799) }),
      window({
        kind: "weekly",
        label: "Weekly",
        usedPercent: 88,
        resetsAt: isoOfSeconds(1791544799),
      }),
    ]);
  });
});

describe("accounts", () => {
  const claudeJson = (organizationUuid: string) => ({
    oauthAccount: {
      accountUuid: "acct-1",
      organizationUuid,
      emailAddress: "me@example.com",
      organizationName: "Cego",
    },
  });

  test("one email in two organizations is two accounts", () => {
    const personal = claudeLogin(claudeJson("org-personal"), "max");
    const team = claudeLogin(claudeJson("org-team"), "team");
    expect(personal).toEqual({
      account: "org-personal:acct-1",
      accountLabel: "me@example.com",
      plan: "max",
    });
    expect(team).toEqual({
      account: "org-team:acct-1",
      accountLabel: "me@example.com (Cego)",
      plan: "team",
    });
  });

  test("ChatGPT's account is its chatgptAccountId, labelled by its email", () => {
    expect(codexLogin(codexAccount.result)).toEqual({
      account: "<redacted>",
      accountLabel: "<redacted>",
      plan: "self_serve_business_prolite",
    });
  });
});

test("subscriptionOf is the provider a choice draws on", () => {
  const drawn = [
    ["claude", "opus"],
    ["codex", "default"],
    ["pi", "anthropic/claude-sonnet-4-5"],
    ["opencode", "openai-codex/gpt-5.6-sol"],
    ["pi", "openrouter/qwen3"],
    ["pi", "default"],
    ["aider", "default"],
  ].map(([harness = "", model = ""]) => subscriptionOf({ harness, model }));
  expect(drawn).toEqual(["claude", "chatgpt", "claude", "chatgpt", null, null, null]);
});

describe("usedFor and Exhausted", () => {
  const opusWindow = window({
    kind: "weekly-model",
    label: "Weekly Opus",
    model: "Opus",
    usedPercent: 100,
  });

  test("a model's window applies only to that model", () => {
    const readings = [reading({ windows: [window({ usedPercent: 20 }), opusWindow] })];
    expect(usedFor(readings, opus, NOW)?.exhausted).toBe(true);
    expect(usedFor(readings, { harness: "claude", model: "claude-opus-4-1" }, NOW)?.exhausted).toBe(
      true,
    );
    // `default` is resolved by the caller; unresolved, it names no model.
    expect(usedFor(readings, { harness: "claude", model: "default" }, NOW)?.exhausted).toBe(false);
    const sonnet45 = window({
      kind: "weekly-model",
      label: "Weekly Sonnet 4.5",
      model: "Sonnet 4.5",
      usedPercent: 100,
    });
    expect(
      usedFor([reading({ windows: [sonnet45] })], { harness: "claude", model: "sonnet" }, NOW)
        ?.exhausted,
    ).toBe(true);
    expect(usedFor(readings, { harness: "claude", model: "sonnet" }, NOW)).toMatchObject({
      usedPercent: 20,
      exhausted: false,
    });
  });

  test("a window at 100% or reached is Exhausted until its reset", () => {
    for (const full of [window({ usedPercent: 100 }), window({ usedPercent: 40, reached: true })]) {
      const readings = [reading({ windows: [full] })];
      expect(usedFor(readings, opus, NOW)).toMatchObject({ usedPercent: 100, exhausted: true });
      expect(usedFor(readings, opus, AFTER_RESET)).toMatchObject({
        usedPercent: 0,
        exhausted: false,
      });
    }
  });

  test("no reading, or one with only a problem, is never Exhausted", () => {
    expect(usedFor([], opus, NOW)).toBeNull();
    const broken = reading({ problem: "Claude Code's login expired" });
    expect(usedFor([broken], opus, NOW)).toBeNull();
  });

  test("another Subscription's windows do not count", () => {
    const chatgpt = reading({ subscription: "chatgpt", windows: [window({ usedPercent: 100 })] });
    expect(usedFor([chatgpt], opus, NOW)).toBeNull();
    expect(usedFor([chatgpt], { harness: "codex", model: "default" }, NOW)?.exhausted).toBe(true);
  });
});

describe("usagePhrase", () => {
  test("each Subscription's busiest window, warning at 90% and saying out when Exhausted", () => {
    const claude = reading({ windows: [window({ usedPercent: 31 }), window({ usedPercent: 12 })] });
    const chatgpt = reading({ subscription: "chatgpt", windows: [window({ usedPercent: 2 })] });
    expect(usagePhrase([claude, chatgpt], NOW)).toEqual({
      text: "claude 31% · chatgpt 2%",
      warn: false,
    });
    const nearly = reading({ windows: [window({ usedPercent: 90 })] });
    expect(usagePhrase([nearly], NOW)).toEqual({ text: "claude 90%", warn: true });
    const out = reading({ windows: [window({ usedPercent: 100 })] });
    expect(usagePhrase([out, chatgpt], NOW)).toEqual({
      text: "claude out · chatgpt 2%",
      warn: true,
    });
    expect(usagePhrase([reading({ problem: "no login" })], NOW)).toEqual({ text: "", warn: false });
    const opusOut = reading({
      windows: [
        window({ usedPercent: 10 }),
        window({ kind: "weekly-model", label: "Weekly Opus", model: "Opus", usedPercent: 100 }),
      ],
    });
    expect(usagePhrase([opusOut], NOW)).toEqual({ text: "claude Opus out", warn: true });
  });
});
