// Where work starts when its preferred agent's Subscription is spent (ADR-0049 D7, D10).

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { AgentChoiceSchema } from "../src/agents";
import { foldCeiling, type Preferences, resolveWithRoom } from "../src/harness";
import { parseSetting } from "../src/settings";
import { epochMs } from "../src/time";
import { roomFor, type UsageReading, type UsageWindow } from "../src/usage-model";

const NOW = epochMs("2026-10-08T08:00:00Z");

const window = (usedPercent: number, over: Partial<UsageWindow> = {}): UsageWindow => ({
  kind: "session",
  label: "Session",
  model: null,
  usedPercent,
  resetsAt: "2026-10-08T10:00:00Z",
  reached: false,
  ...over,
});
const reading = (subscription: UsageReading["subscription"], windows: UsageWindow[]) =>
  ({
    subscription,
    account: "a",
    accountLabel: null,
    plan: null,
    windows,
    at: "2026-10-08T07:59:00Z",
    source: subscription === "claude" ? "claude-usage" : "codex-app-server",
    problem: null,
  }) satisfies UsageReading;

const opus: Preferences = { harness: "claude", model: "opus", effort: "xhigh" };
const claudeOut = reading("claude", [window(100)]);
const chatgptOut = reading("chatgpt", [window(100)]);

const resolved = (
  layers: ReadonlyArray<Preferences>,
  chain: ReadonlyArray<string>,
  readings: ReadonlyArray<UsageReading>,
) => {
  const result = resolveWithRoom(layers, chain, roomFor(readings, NOW));
  if (!result.ok) throw new Error(result.problem);
  return result.chosen;
};
const on = ({ choice }: ReturnType<typeof resolved>) =>
  `${choice.harness}/${choice.model}${choice.effort === null ? "" : ` ${choice.effort}`}`;

describe("resolveWithRoom", () => {
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
    // Below the ceiling, the primary.
    expect(on(resolved(layers, ["codex"], [reading("claude", [window(79)])]))).toBe(
      "claude/opus xhigh",
    );
    // An otherwise entry keeps its own ceiling, then the chain.
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
    Schema.decodeUnknownSync(AgentChoiceSchema)({ harness: "claude", model: "opus", effort: null }),
  ).toEqual({ harness: "claude", model: "opus", effort: null });
});
