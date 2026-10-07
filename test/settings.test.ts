import { describe, expect, test } from "bun:test";
import { harnessNames } from "../src/harness";
import { NOTIFICATION_KINDS } from "../src/notify";
import { parseSetting, SETTINGS } from "../src/settings";

const keys = SETTINGS.map((setting) => setting.key);

describe("Collie's settings", () => {
  test("are every default a Run reads, the per-harness models and every notification", () => {
    expect(keys).toEqual(
      expect.arrayContaining([
        "harness",
        "model",
        "effort",
        "trust",
        "permissions",
        "scope",
        "questions",
        "density",
        "gitlab_host",
        "max_iterations",
        "handoff_timeout_ms",
        "quiet_ms",
        "board_quiet_ms",
        "compact_at_tokens",
        "proactive",
        ...harnessNames().map((harness) => `models.${harness}`),
        ...NOTIFICATION_KINDS.map((kind) => `notifications.${kind}`),
      ]),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("offer a closed set as choices, with the default among them", () => {
    const harness = SETTINGS.find((setting) => setting.key === "harness")!;
    expect(harness.kind).toBe("choice");
    expect([...harness.choices].sort()).toEqual(harnessNames());
    expect(harness.fallback).toBe("claude");
    for (const setting of SETTINGS.filter((one) => one.kind === "choice"))
      expect(setting.choices).toContain(setting.fallback);
  });

  test("parse what was typed into the value written", () => {
    expect(parseSetting("max_iterations", " 7 ")).toEqual({ value: 7 });
    expect(parseSetting("scope", "all")).toEqual({ value: "all" });
    expect(parseSetting("proactive", "false")).toEqual({ value: false });
    expect(parseSetting("notifications.run-done", "true")).toEqual({ value: true });
    expect(parseSetting("models.claude", "claude-x, claude-y,")).toEqual({
      value: ["claude-x", "claude-y"],
    });
    expect(parseSetting("model", "  sonnet ")).toEqual({ value: "sonnet" });
    // Empty is unset, never a configured empty string.
    expect(parseSetting("harness", "  ")).toEqual({ value: null });
  });

  test("refuse what no Run could use, saying what would do", () => {
    expect(parseSetting("max_iterations", "five")).toEqual({
      refused: 'max_iterations has to be a whole number, not "five"',
    });
    expect(parseSetting("scope", "everywhere")).toEqual({
      refused: 'scope has to be one of local, all, not "everywhere"',
    });
    expect(parseSetting("gitlab_host", "not a host")).toHaveProperty("refused");
    expect(parseSetting("proactive", "maybe")).toHaveProperty("refused");
    expect(parseSetting("linear.team", "CEG")).toEqual({
      refused: "linear.team is not one of Collie's settings",
    });
  });
});
