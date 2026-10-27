import { describe, expect, test } from "bun:test";
import { harnessNames } from "../src/harness";
import { NOTIFICATION_KINDS } from "../src/notify";
import {
  parseSetting,
  SETTING_GROUPS,
  SETTINGS,
  settingOf,
  settingShown,
  settingStored,
} from "../src/settings";

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
        "idle_close_ms",
        "memory_hold",
        "board_quiet_ms",
        "compact_at_tokens",
        "claude_auto_compact_window",
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
    expect(
      parseSetting("claude_subagents", '{"model":"sonnet","forceModel":false,"cacheTtl":"1h"}'),
    ).toEqual({ value: '{"model":"sonnet","forceModel":false,"cacheTtl":"1h"}' });
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
    expect(parseSetting("claude_subagents", '{"maxConcurrent":0}')).toHaveProperty("refused");
    expect(parseSetting("claude_subagents", '{"enabeld":false}')).toHaveProperty("refused");
    expect(parseSetting("claude_subagents", "[]")).toHaveProperty("refused");
  });
});

describe("Claude Code's auto-compact window", () => {
  const RANGE =
    "claude_auto_compact_window has to be a whole number of tokens from 100000 to 1000000, or auto";

  test("is 400000 tokens until set, and says it is Claude Code's alone", () => {
    const window = settingOf("claude_auto_compact_window")!;
    expect(window).toMatchObject({ kind: "text", fallback: "400000", unit: "tokens" });
    expect(window.label).toContain("Claude Code");
    expect(window.description).toContain("Claude Code");
    expect(window.description).toContain("auto");
    expect(window.description).toContain("100000");
    expect(window.description).toContain("1000000");
  });

  test("takes a whole number in the range as a number, and auto as itself", () => {
    expect(parseSetting("claude_auto_compact_window", "100000")).toEqual({ value: 100000 });
    expect(parseSetting("claude_auto_compact_window", "1000000")).toEqual({ value: 1000000 });
    expect(parseSetting("claude_auto_compact_window", " 400000 ")).toEqual({ value: 400000 });
    expect(parseSetting("claude_auto_compact_window", "auto")).toEqual({ value: "auto" });
    expect(parseSetting("claude_auto_compact_window", "")).toEqual({ value: null });
  });

  test("refuses anything else, Claude Code's shorthands included, naming the range", () => {
    for (const typed of ["99999", "1000001", "500k", "1M", "-5", "400000.5", "big"])
      expect(parseSetting("claude_auto_compact_window", typed)).toEqual({
        refused: `${RANGE}, not "${typed}"`,
      });
  });
});

describe("Each setting explains itself", () => {
  const PLACED = {
    Agents: [
      "harness",
      "model",
      "effort",
      ...harnessNames().map((harness) => `models.${harness}`),
      "fallbacks",
      "permissions",
      "trust",
      "compact_at_tokens",
      "claude_auto_compact_window",
      "quiet_ms",
      "idle_close_ms",
      "agent_profile",
      "claude_subagents",
    ],
    Runs: ["max_iterations", "handoff_timeout_ms", "memory_hold"],
    Board: ["scope", "density", "board_quiet_ms"],
    Chat: ["proactive"],
    Notifications: ["questions", ...NOTIFICATION_KINDS.map((kind) => `notifications.${kind}`)],
    "GitLab and credentials": ["gitlab_host"],
  };

  test("under a group, with a plain name and a sentence on what it changes", () => {
    expect<ReadonlyArray<string>>(SETTING_GROUPS).toEqual(Object.keys(PLACED));
    for (const [group, placed] of Object.entries(PLACED))
      expect(
        SETTINGS.filter((setting) => setting.group === group)
          .map(({ key }) => key)
          .sort(),
      ).toEqual([...placed].sort());
    for (const setting of SETTINGS) {
      expect(setting.label).not.toBe("");
      expect(setting.description).not.toBe("");
    }
    const descriptions = SETTINGS.map((setting) => setting.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  test("saying what 0 or unset means, and whose board or chat it changes", () => {
    const said = (key: string) => settingOf(key)!.description;
    expect(said("quiet_ms")).toContain("double");
    expect(said("quiet_ms")).toContain("triple");
    expect(said("quiet_ms")).toContain("0 waits");
    expect(said("compact_at_tokens")).toContain("0 turns compaction off");
    expect(said("idle_close_ms")).toContain("0 never closes one");
    expect(said("effort")).toContain("Unset");
    for (const key of ["scope", "density", "questions"]) expect(said(key)).toContain("TUI");
    expect(said("proactive")).toContain("Native chat");
    expect(said("proactive")).toContain("Flock chat");
  });

  test("a duration is shown and typed in minutes, and stored in milliseconds", () => {
    expect(settingOf("quiet_ms")!.unit).toBe("minutes");
    expect(settingShown("quiet_ms", "600000")).toBe("10");
    expect(settingShown("quiet_ms", "90000")).toBe("1.5");
    expect(settingShown("quiet_ms", "")).toBe("");
    expect(settingStored("quiet_ms", "10")).toEqual({ stored: "600000" });
    expect(settingStored("handoff_timeout_ms", "1.5")).toEqual({ stored: "90000" });
    expect(settingStored("quiet_ms", "")).toEqual({ stored: "" });
    expect(settingStored("quiet_ms", ".5")).toEqual({ stored: "30000" });
    expect(parseSetting("quiet_ms", "900000")).toEqual({ value: 900000 });
    for (const typed of ["-1", "ten"])
      expect(settingStored("board_quiet_ms", typed)).toEqual({
        refused: `board_quiet_ms has to be a number of minutes, not "${typed}"`,
      });
  });

  test("an idle agent closes after an hour by default, and 0 is never", () => {
    const idle = settingOf("idle_close_ms")!;
    expect(idle).toMatchObject({ group: "Agents", label: "Close an idle agent after" });
    expect(idle.unit).toBe("minutes");
    expect(settingShown("idle_close_ms", idle.fallback)).toBe("60");
    expect(settingStored("idle_close_ms", "0")).toEqual({ stored: "0" });
    expect(parseSetting("idle_close_ms", "0")).toEqual({ value: 0 });
  });

  test("new work is held below a tenth free by default, and 0 never holds it", () => {
    const hold = settingOf("memory_hold")!;
    expect(hold).toMatchObject({
      group: "Runs",
      label: "Hold new work below free memory",
      unit: "percent",
    });
    expect(settingShown("memory_hold", hold.fallback)).toBe("10");
    expect(hold.description).toContain("waits");
    expect(hold.description).toContain("0 never holds, and turns the pressure rule off too");
    expect(settingStored("memory_hold", "0")).toEqual({ stored: "0" });
    expect(parseSetting("memory_hold", "0")).toEqual({ value: 0 });
  });

  test("a unit that is only a label changes nothing", () => {
    expect(settingOf("compact_at_tokens")!.unit).toBe("tokens");
    expect(settingShown("compact_at_tokens", "372000")).toBe("372000");
    expect(settingStored("compact_at_tokens", "1000")).toEqual({ stored: "1000" });
    expect(settingStored("max_iterations", "eight")).toEqual({ stored: "eight" });
  });
});
