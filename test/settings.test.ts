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

describe("Each setting explains itself", () => {
  const PLACED = {
    Agents: [
      "harness",
      "model",
      "effort",
      ...harnessNames().map((harness) => `models.${harness}`),
      "permissions",
      "trust",
      "compact_at_tokens",
      "quiet_ms",
    ],
    Runs: ["max_iterations", "handoff_timeout_ms"],
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
    expect(parseSetting("quiet_ms", "900000")).toEqual({ value: 900000 });
    for (const typed of ["-1", "ten"])
      expect(settingStored("board_quiet_ms", typed)).toEqual({
        refused: `board_quiet_ms has to be a number of minutes, not "${typed}"`,
      });
  });

  test("a unit that is only a label changes nothing", () => {
    expect(settingOf("compact_at_tokens")!.unit).toBe("tokens");
    expect(settingShown("compact_at_tokens", "372000")).toBe("372000");
    expect(settingStored("compact_at_tokens", "1000")).toEqual({ stored: "1000" });
    expect(settingStored("max_iterations", "eight")).toEqual({ stored: "eight" });
  });
});
