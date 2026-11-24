import { describe, expect, test } from "bun:test";
import { Schema, flow, Result } from "effect";
import { AgentChoiceSchema } from "../src/agents";
import { foldCeiling, hasAnyRoom, hasRoomFor, resolveWithRoom } from "../src/harness";
import type { Preferences } from "../src/harness";
import { parseSetting } from "../src/settings";
import { epochMs } from "../src/time";
import { codexUsage, roomFor } from "../src/usage-model";
import type { UsageReading, UsageWindow } from "../src/usage-model";
import codexRateLimits from "./fixtures/usage/codex-account-ratelimits-read.json";

const NOW = epochMs("2026-10-08T08:00:00Z");

const window: (usedPercent: number, over?: Partial<UsageWindow>) => UsageWindow = (
  usedPercent,
  over = {},
) => ({
  kind: "session",
  label: "Session",
  model: null,
  usedPercent,
  resetsAt: "2026-10-08T10:00:00Z",
  reached: false,
  ...over,
});
const reading: (
  subscription: UsageReading["subscription"],
  windows: Array<UsageWindow>,
) => UsageReading = (subscription, windows) => ({
  subscription,
  account: "a",
  accountLabel: null,
  plan: null,
  windows,
  at: "2026-10-08T07:59:00Z",
  source: subscription === "claude" ? "claude-usage" : "codex-app-server",
  problem: null,
});

const opus: Preferences = { harness: "claude", model: "opus", effort: "xhigh" };
const claudeOut = reading("claude", [window(100)]);
const chatgptOut = reading("chatgpt", [window(100)]);
const spentCreditCap = (
  over: {
    ordinaryUsageAllowed?: boolean;
    rateLimitReachedType?: string | null;
    weeklyPercent?: number;
  } = {},
) => ({
  ...codexRateLimits.result,
  ordinaryUsageAllowed: over.ordinaryUsageAllowed ?? true,
  rateLimits: {
    ...codexRateLimits.result.rateLimits,
    primary: {
      usedPercent: over.weeklyPercent ?? 2,
      windowDurationMins: 10_080,
      resetsAt: 1_791_973_608,
    },
    secondary: null,
    individualLimit: { limit: "5000", used: "5000.0", remainingPercent: 0 },
    spendControlReached: true,
    rateLimitReachedType: over.rateLimitReachedType ?? null,
  },
});

const resolved = (
  layers: ReadonlyArray<Preferences>,
  chain: ReadonlyArray<string>,
  readings: ReadonlyArray<UsageReading>,
) => {
  const result = resolveWithRoom(layers, chain, roomFor(readings, NOW));
  if (!result.ok) {
    throw new Error(result.problem);
  }
  return result.chosen;
};
const on = ({ choice }: ReturnType<typeof resolved>) =>
  `${choice.harness}/${choice.model}${choice.effort === null ? "" : ` ${choice.effort}`}`;

describe("resolveWithRoom", () => {
  test("a fallback carries an effort its model reports, even when Collie's table does not", () => {
    const listed = (harness: string, model: string) => ({
      harness,
      at: "2026-10-29T09:00:00.000Z",
      table: null,
      entries: [
        {
          model,
          label: model,
          description: null,
          efforts: ["high"],
          defaultEffort: null,
          hidden: false,
          from: "harness",
        },
      ],
    });
    const resolved = resolveWithRoom(
      [{ harness: "claude", model: "opus", effort: "high" }],
      ["codex/new-model"],
      (on) => (on.harness === "codex" ? { room: true } : { room: false, why: "Claude is spent" }),
      {},
      { machine: "vm-gpu", harnesses: [listed("claude", "opus"), listed("codex", "new-model")] },
    );
    expect(resolved.ok && resolved.chosen.choice).toEqual({
      harness: "codex",
      model: "new-model",
      effort: "high",
    });
  });
  test("Claude fallbacks keep their subagent policy and other harnesses clear it", () => {
    const policy = { model: "haiku", maxDepth: 1 };
    const result = resolveWithRoom(
      [{ ...opus, claudeSubagents: policy }],
      ["claude/sonnet"],
      (choice) =>
        choice.model === "sonnet" ? { room: true } : { room: false, why: "Opus is spent" },
    );
    expect(result.ok && result.chosen.choice.claudeSubagents).toEqual(policy);
    expect(
      resolved([{ ...opus, claudeSubagents: policy }], ["codex"], [claudeOut]).choice
        .claudeSubagents,
    ).toBeUndefined();
  });

  test("the primary while it has room, with nothing to say", () => {
    const chosen = resolved([opus], ["codex"], [reading("claude", [window(40)])]);
    expect(on(chosen)).toBe("claude/opus xhigh");
    expect(chosen.from).toBeNull();
    expect(chosen.why).toBeNull();
  });

  test("the first chain entry once the primary is Exhausted, saying the window and reset", () => {
    const chosen = resolved([opus], ["codex"], [claudeOut]);
    expect(on(chosen)).toBe("codex/default");
    expect(chosen.from).toEqual({ harness: "claude", model: "opus", effort: "xhigh" });
    expect(chosen.why).toMatch(/^session 100%, resets \S+$/);
  });

  test("a versioned GPT model in the chain is accepted without a configured extra model", () => {
    const chosen = resolved([opus], ["codex/gpt-6.1-sol"], [claudeOut]);
    expect(on(chosen)).toBe("codex/gpt-6.1-sol");
    expect(chosen.skipped).toEqual([]);
  });

  test("a chain entry on the same Exhausted Subscription is skipped", () => {
    const out = resolved(
      [opus],
      ["pi/openai-codex/gpt-5.6-sol", "opencode/openrouter/qwen3"],
      [claudeOut, chatgptOut],
    );
    expect(on(out)).toBe("opencode/openrouter/qwen3");
  });

  test("effort carries onto a harness that takes it, and is dropped where it has none", () => {
    expect(on(resolved([opus], ["pi/openrouter/qwen3"], [claudeOut]))).toBe(
      "pi/openrouter/qwen3 xhigh",
    );
    expect(on(resolved([opus], ["codex"], [claudeOut]))).toBe("codex/default");
  });

  test("upTo and otherwise come before the chain, and { effort } keeps the primary's harness and model", () => {
    const busy = [reading("claude", [window(85)])];
    const layers = [{ ...opus, upTo: 80, otherwise: [{ effort: "medium" }] }];
    const chosen = resolved(layers, ["codex"], busy);
    expect(on(chosen)).toBe("claude/opus medium");
    expect(chosen.why).toMatch(/^session 85%, over its 80%, resets/);
    expect(on(resolved(layers, ["codex"], [reading("claude", [window(79)])]))).toBe(
      "claude/opus xhigh",
    );
    const twice = [{ ...opus, upTo: 80, otherwise: [{ effort: "medium", upTo: 84 }] }];
    expect(on(resolved(twice, ["codex"], busy))).toBe("codex/default");
  });

  test("a bad otherwise entry is refused, and a bad chain entry skipped with its reason", () => {
    const refused = resolveWithRoom(
      [{ ...opus, otherwise: [{ harness: "codex", effort: "high" }] }],
      [],
      roomFor([], NOW),
    );
    expect(refused).toEqual({
      ok: false,
      problem: 'otherwise entry 1: codex takes no effort, so "high" cannot be asked of it',
    });
    expect(resolveWithRoom([{ ...opus, upTo: 0 }], [], roomFor([], NOW))).toEqual({
      ok: false,
      problem: "upTo is a percentage from 1 to 100, not 0",
    });
    const chosen = resolved([opus], ["claude/nonsense", "codex"], [claudeOut]);
    expect(on(chosen)).toBe("codex/default");
    expect(chosen.skipped).toEqual([
      expect.stringMatching(
        /^fallback claude\/nonsense skipped: "nonsense" is not a model claude takes/,
      ),
    ]);
  });

  test("when nothing has room, the primary, with when each Subscription resets", () => {
    const chosen = resolved([opus], ["codex"], [claudeOut, chatgptOut]);
    expect(on(chosen)).toBe("claude/opus xhigh");
    expect(chosen.from).toBeNull();
    expect(chosen.why).toMatch(
      /^nothing has room; claude\/opus xhigh: session 100%, resets \S+; codex\/default: session 100%, resets \S+$/,
    );
  });

  test("any room is a choice with room, the primary's or a fallback's", () => {
    const defaults = { harness: "claude", model: "opus", effort: "xhigh", fallbacks: ["codex"] };
    expect(hasAnyRoom(defaults, [claudeOut, chatgptOut], NOW)).toBe(false);
    expect(hasAnyRoom(defaults, [claudeOut], NOW)).toBe(true);
    expect(hasAnyRoom(defaults, [chatgptOut], NOW)).toBe(true);
    expect(hasAnyRoom({ harness: "codex", model: "default" }, [chatgptOut], NOW)).toBe(false);
    expect(
      hasAnyRoom({ harness: "codex", model: "default", fallbacks: ["claude"] }, [chatgptOut], NOW),
    ).toBe(true);
    expect(hasAnyRoom({ ...defaults, harness: "codex", model: "default" }, [chatgptOut], NOW)).toBe(
      true,
    );
  });

  test("a Run is owed room on the agents it ran, not on the Machine's defaults", () => {
    const defaults = { harness: "codex", model: "default" };
    const ranOn = { harness: "claude", model: "opus" };
    // WARNING: the Machine's own Codex account has room, which is not this Claude Run's to spend.
    expect(hasAnyRoom(defaults, [claudeOut], NOW)).toBe(true);
    expect(hasRoomFor(defaults, ranOn, [claudeOut], NOW)).toBe(false);
    expect(hasRoomFor(defaults, ranOn, [chatgptOut], NOW)).toBe(true);
    // WARNING: a Run with no launch yet is judged on the defaults, since that is what its first agent gets.
    expect(hasRoomFor(defaults, null, [chatgptOut], NOW)).toBe(false);
  });

  test("a default model is judged as the model it pins", () => {
    const opusOut = reading("claude", [
      window(10),
      window(100, { kind: "weekly-model", label: "Weekly Opus", model: "Opus" }),
    ]);
    expect(on(resolved([{ harness: "claude" }], ["codex"], [opusOut]))).toBe("codex/default");
  });

  test("an unread Subscription has room", () => {
    expect(on(resolved([opus], ["codex"], []))).toBe("claude/opus xhigh");
  });
  test("a spent credit cap keeps work on Codex, with nothing to say", () => {
    const chosen = resolved(
      [{ harness: "codex", otherwise: [{ harness: "claude" }] }],
      [],
      [reading("chatgpt", codexUsage(spentCreditCap()).windows)],
    );
    expect(on(chosen)).toBe("codex/default");
    expect(chosen.from).toBeNull();
    expect(chosen.why).toBeNull();
  });
  test("Codex's own block signals still move work off it", () => {
    for (const cap of [
      spentCreditCap({ ordinaryUsageAllowed: false }),
      spentCreditCap({ rateLimitReachedType: "workspace_member_credits_depleted" }),
      spentCreditCap({ weeklyPercent: 100 }),
    ]) {
      const chosen = resolved(
        [{ harness: "codex", otherwise: [{ harness: "claude" }] }],
        [],
        [reading("chatgpt", codexUsage(cap).windows)],
      );
      expect(on(chosen)).toBe("claude/default");
      expect(chosen.from?.harness).toBe("codex");
      expect(chosen.why).toMatch(/^weekly 100%/);
    }
  });
});

describe("folding upTo and otherwise", () => {
  const ceiling = { upTo: 80, otherwise: [{ effort: "medium" }] };

  test("the nearest layer that names either one wins: definition, seat, scope, call", () => {
    const definition = { harness: "claude", ...ceiling };
    expect(foldCeiling([definition, { model: "opus" }, {}, {}])).toEqual(ceiling);
    expect(foldCeiling([definition, { upTo: 90 }, {}, {}])).toEqual({ upTo: 90 });
    expect(foldCeiling([definition, {}, { otherwise: [{ model: "sonnet" }] }, {}])).toEqual({
      otherwise: [{ model: "sonnet" }],
    });
    expect(foldCeiling([definition, {}, {}, { upTo: 50 }])).toEqual({ upTo: 50 });
  });

  test("a layer that switches harness clears both", () => {
    expect(foldCeiling([{ harness: "claude", ...ceiling }, { harness: "codex" }])).toEqual({});
    expect(foldCeiling([{ harness: "claude", ...ceiling }, { harness: "claude" }])).toEqual(
      ceiling,
    );
  });
});

describe("the fallbacks setting", () => {
  test("entries are harness or harness/model, split at the first slash", () => {
    expect(parseSetting("fallbacks", "codex, pi/openai-codex/gpt-5.6-sol")).toEqual({
      value: ["codex", "pi/openai-codex/gpt-5.6-sol"],
    });
  });

  test("an unknown harness is refused with what is allowed, and empty unsets it", () => {
    expect(parseSetting("fallbacks", "codex, kodex")).toEqual({
      refused: 'fallbacks: "kodex" names no harness Collie has (claude, codex, opencode, pi)',
    });
    expect(parseSetting("fallbacks", " ")).toEqual({ value: null });
  });
});

test("a choice recorded by an earlier build decodes, saying it fell back from nothing", () => {
  expect(
    flow(
      Schema.decodeResult(AgentChoiceSchema),
      Result.getOrThrow,
    )({ harness: "claude", model: "opus", effort: null }),
  ).toEqual({ harness: "claude", model: "opus", effort: null });
});
