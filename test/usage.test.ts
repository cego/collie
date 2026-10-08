// The host's Usage readings: how often each endpoint is called, what a refusal or a silent
// endpoint leaves behind, a login read and never written, and the status lines' samples.

import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect, Fiber, FileSystem, Path, Schema, Scope } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";
import {
  askClaude,
  claudeLoginSource,
  codexReading,
  makeUsage,
  USAGE_INTERVAL_MS,
  type Asked,
  type UsageSources,
} from "../src/usage";
import { usageLines } from "../src/commands/usage";
import { readEnv } from "../src/env";
import { epochMs } from "../src/time";
import type { UsageReading } from "../src/usage-model";
import claudeUsage from "./fixtures/usage/claude-oauth-usage.json";
import codexRateLimits from "./fixtures/usage/codex-account-ratelimits-read.json";
import codexAccount from "./fixtures/usage/codex-account-read.json";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const onTestClock = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide([BunServices.layer, TestClock.layer()])),
  );

const read = (subscription: "claude" | "chatgpt", at: number, percent: number): UsageReading => ({
  subscription,
  account: "acct",
  accountLabel: "me@example.com",
  plan: "max",
  windows: [
    {
      kind: "session",
      label: "Session",
      model: null,
      usedPercent: percent,
      resetsAt: null,
      reached: false,
    },
  ],
  at: iso(at),
  source: subscription === "claude" ? "claude-usage" : "codex-app-server",
  problem: null,
});

/** A source that answers what `answers` says next, counting each call. */
const counted = (answers: (call: number, at: number) => Effect.Effect<Asked>) => {
  const calls = { count: 0 };
  const ask = Effect.gen(function* () {
    calls.count += 1;
    const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    return yield* answers(calls.count, at);
  });
  return { calls, ask };
};

const quiet: UsageSources = {
  claude: Effect.succeed({ reading: read("claude", 0, 0), called: true }),
  chatgpt: Effect.succeed({ reading: read("chatgpt", 0, 0), called: true }),
  statusLine: Effect.succeed(null),
};

describe("the call interval", () => {
  test("a second ask within five minutes makes no call", () =>
    onTestClock(
      Effect.gen(function* () {
        const claude = counted((call, at) =>
          Effect.succeed({ reading: read("claude", at, call * 10), called: true }),
        );
        const usage = yield* makeUsage({ ...quiet, claude: claude.ask });

        expect((yield* usage.readings)[0]?.windows[0]?.usedPercent).toBe(10);
        yield* TestClock.adjust(USAGE_INTERVAL_MS - 1);
        expect((yield* usage.readings)[0]?.windows[0]?.usedPercent).toBe(10);
        expect(claude.calls.count).toBe(1);

        yield* TestClock.adjust(1);
        expect((yield* usage.readings)[0]?.windows[0]?.usedPercent).toBe(20);
        expect(claude.calls.count).toBe(2);
      }),
    ));

  test("a refusal's Retry-After delays the next call, and the last reading stands with its age", () =>
    onTestClock(
      Effect.gen(function* () {
        const claude = counted((call, at) =>
          Effect.succeed(
            call === 2
              ? {
                  reading: { ...read("claude", at, 0), windows: [], problem: "refusing" },
                  called: true,
                  retryAfterMs: 20 * 60_000,
                }
              : { reading: read("claude", at, 40), called: true },
          ),
        );
        const usage = yield* makeUsage({ ...quiet, claude: claude.ask });
        yield* usage.readings;
        yield* TestClock.adjust(USAGE_INTERVAL_MS);

        const refused = (yield* usage.readings)[0];
        expect(refused).toMatchObject({ at: iso(0), problem: "refusing" });
        expect(refused?.windows[0]?.usedPercent).toBe(40);

        yield* TestClock.adjust(USAGE_INTERVAL_MS);
        yield* usage.readings;
        expect(claude.calls.count).toBe(2);
        yield* TestClock.adjust(15 * 60_000);
        expect((yield* usage.readings)[0]?.problem).toBeNull();
        expect(claude.calls.count).toBe(3);
      }),
    ));

  test("an endpoint that does not answer becomes a problem", () =>
    onTestClock(
      Effect.gen(function* () {
        const usage = yield* makeUsage({ ...quiet, chatgpt: Effect.never });
        const asking = yield* Effect.forkChild(usage.readings);
        yield* TestClock.adjust("10 seconds");
        const [, chatgpt] = yield* Fiber.join(asking);
        expect(chatgpt?.problem).toBe("codex-app-server did not answer within 10s");
        expect(chatgpt?.windows).toEqual([]);
      }),
    ));
});

describe("Claude's login", () => {
  const fakeHttp = (status: number, body: string, headers: Record<string, string> = {}) => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = HttpClient.make((request) => {
      requests.push({ url: request.url, headers: { ...request.headers } });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(body, { status, headers })),
      );
    });
    return { requests, client };
  };

  const credentials = (expiresAt: number) =>
    asJson({
      claudeAiOauth: {
        accessToken: "token-1",
        refreshToken: "refresh-1",
        expiresAt,
        subscriptionType: "team",
      },
    });
  const claudeJson = asJson({
    oauthAccount: {
      accountUuid: "acct-1",
      organizationUuid: "org-1",
      emailAddress: "me@example.com",
      organizationName: "Cego",
    },
  });

  test("an expired login makes no call and says why", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.setTime(10_000);
        const http = fakeHttp(200, asJson(claudeUsage));
        const asked = yield* askClaude({
          credentials: Effect.succeed(credentials(5_000)),
          claudeJson: Effect.succeed(claudeJson),
        }).pipe(Effect.provideService(HttpClient.HttpClient, http.client));

        expect(http.requests).toEqual([]);
        expect(asked.called).toBe(false);
        expect(asked.reading).toMatchObject({
          account: "org-1:acct-1",
          accountLabel: "me@example.com (Cego)",
          plan: "team",
          problem: "Claude Code's login expired; it refreshes when Claude Code next runs",
        });
      }),
    ));

  test("a live login is sent as Claude Code sends it, and the answer read", () =>
    onTestClock(
      Effect.gen(function* () {
        const http = fakeHttp(200, asJson(claudeUsage));
        const asked = yield* askClaude({
          credentials: Effect.succeed(credentials(Number.MAX_SAFE_INTEGER)),
          claudeJson: Effect.succeed(claudeJson),
        }).pipe(Effect.provideService(HttpClient.HttpClient, http.client));

        expect(http.requests).toEqual([
          {
            url: "https://api.anthropic.com/api/oauth/usage",
            headers: expect.objectContaining({
              authorization: "Bearer token-1",
              "anthropic-beta": "oauth-2025-04-20",
            }),
          },
        ]);
        expect(asked.reading.source).toBe("claude-usage");
        expect(asked.reading.windows.map((window) => window.usedPercent)).toEqual([31, 88, 0]);
      }),
    ));

  test("a 429 asks to be left alone for its Retry-After", () =>
    onTestClock(
      Effect.gen(function* () {
        const http = fakeHttp(429, "{}", { "retry-after": "600" });
        const asked = yield* askClaude({
          credentials: Effect.succeed(credentials(Number.MAX_SAFE_INTEGER)),
          claudeJson: Effect.succeed(claudeJson),
        }).pipe(Effect.provideService(HttpClient.HttpClient, http.client));
        expect(asked.retryAfterMs).toBe(600_000);
        expect(asked.reading.problem).toContain("refusing calls");
      }),
    ));

  test("the credentials file is read and never written", () =>
    onTestClock(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const file = path.join(home, ".claude", ".credentials.json");
        yield* fs.makeDirectory(path.dirname(file));
        yield* fs.writeFileString(file, credentials(5_000));
        yield* fs.writeFileString(path.join(home, ".claude.json"), claudeJson);
        const before = yield* fs.stat(file);
        yield* TestClock.setTime(10_000);

        const login = yield* claudeLoginSource(readEnv({ HOME: home }));
        const http = fakeHttp(200, asJson(claudeUsage));
        const asked = yield* askClaude(login).pipe(
          Effect.provideService(HttpClient.HttpClient, http.client),
        );

        expect(asked.reading.account).toBe("org-1:acct-1");
        expect(yield* fs.readFileString(file)).toBe(credentials(5_000));
        expect((yield* fs.stat(file)).mtime).toEqual(before.mtime);
      }),
    ));
});

describe("ChatGPT", () => {
  test("Codex's two answers are one reading, keyed by its account id", () =>
    onTestClock(
      Effect.gen(function* () {
        const asked = yield* codexReading(
          Effect.succeed({ rateLimits: codexRateLimits.result, account: codexAccount.result }),
        );
        expect(asked.reading).toMatchObject({
          subscription: "chatgpt",
          account: "<redacted>",
          plan: "self_serve_business_prolite",
          source: "codex-app-server",
          problem: null,
        });
        expect(asked.reading.windows).toHaveLength(1);
      }),
    ));

  test("Codex not logged in, or not there, is a problem", () =>
    onTestClock(
      Effect.gen(function* () {
        const signedOut = yield* codexReading(
          Effect.succeed({ rateLimits: null, account: { account: null } }),
        );
        expect(signedOut.reading.problem).toBe(
          "Codex is not logged in on this Machine; run `codex login`",
        );
        const missing = yield* codexReading(
          Effect.fail(new Error("Codex is not installed on this Machine")),
        );
        expect(missing.reading.problem).toBe("Codex is not installed on this Machine");
      }),
    ));
});

describe("status-line samples", () => {
  const limits = {
    five_hour: { used_percentage: 64, resets_at: 1791457799 },
    seven_day: { used_percentage: 90, resets_at: 1791544799 },
  };
  const withModelWindow: UsageReading = {
    ...read("claude", 0, 31),
    windows: [
      ...read("claude", 0, 31).windows,
      {
        kind: "weekly-model",
        label: "Weekly Fable",
        model: "Fable",
        usedPercent: 5,
        resetsAt: null,
        reached: false,
      },
    ],
  };

  test("a sample newer than the endpoint's reading replaces its session and weekly windows", () =>
    onTestClock(
      Effect.gen(function* () {
        const usage = yield* makeUsage({
          ...quiet,
          claude: Effect.succeed({ reading: withModelWindow, called: true }),
          statusLine: Effect.succeed({ at: 60_000, limits }),
        });
        const [claude] = yield* usage.readings;
        expect(claude).toMatchObject({
          source: "claude-status-line",
          at: iso(60_000),
          plan: "max",
        });
        expect(claude?.windows.map((window) => [window.label, window.usedPercent])).toEqual([
          ["Session", 64],
          ["Weekly", 90],
          ["Weekly Fable", 5],
        ]);
      }),
    ));

  test("an older sample leaves the endpoint's reading alone", () =>
    onTestClock(
      Effect.gen(function* () {
        yield* TestClock.setTime(120_000);
        const usage = yield* makeUsage({
          ...quiet,
          claude: Effect.gen(function* () {
            const at = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
            return { reading: read("claude", at, 31), called: true };
          }),
          statusLine: Effect.succeed({ at: 60_000, limits }),
        });
        const [claude] = yield* usage.readings;
        expect(claude?.source).toBe("claude-usage");
        expect(claude?.windows[0]?.usedPercent).toBe(31);
      }),
    ));
});

describe("collie usage's lines", () => {
  test("one line per window with its reset, then the reading's age and source", () => {
    const now = epochMs("2026-10-08T08:46:00Z");
    const claude: UsageReading = {
      ...read("claude", now - 3 * 60_000, 31),
      plan: "team",
      accountLabel: "me@example.com",
    };
    const resetsAt = "2026-10-08T10:49:00Z";
    const lines = usageLines(
      [
        {
          ...claude,
          windows: [{ ...claude.windows[0]!, resetsAt }],
        },
        {
          ...read("chatgpt", now, 0),
          windows: [],
          problem: "Codex is not installed on this Machine",
        },
      ],
      now,
    ).split("\n");
    expect(lines[0]).toMatch(
      /^claude {2}team · me@example\.com {2}Session 31% · resets \d\d:\d\d \(in 2h 3m\)$/,
    );
    expect(lines.slice(1)).toEqual([
      "claude  read 3 minutes ago from claude-usage",
      "chatgpt Codex is not installed on this Machine",
    ]);
    const refused = usageLines([{ ...claude, problem: "refusing" }], now).split("\n");
    expect(refused.at(-1)).toBe("claude  refusing; read 3 minutes ago from claude-usage");
  });
});
