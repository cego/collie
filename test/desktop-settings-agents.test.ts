import { expect, test } from "bun:test";
import { Effect } from "effect";
import { epochMs } from "../src/time";
import { cataloguesOn } from "../desktop/src/bun/machine";
import {
  settingsAgentSelects,
  fallbackList,
  changeFallbacks,
  agentSettingChanges,
  type MachineCatalogue,
} from "../desktop/src/shared/settings-agents";
import { editSetting, NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";

const readings: ReadonlyArray<MachineCatalogue> = [
  {
    profile: "a",
    name: "laptop",
    problem: null,
    catalogues: [
      {
        harness: "claude",
        at: "2026-10-29T12:00:00Z",
        table: null,
        entries: [
          {
            model: "opus",
            label: "Opus",
            description: null,
            efforts: ["high", "max"],
            defaultEffort: "high",
            hidden: false,
            from: "harness",
          },
          {
            model: "sonnet",
            label: "Sonnet",
            description: null,
            efforts: ["low"],
            defaultEffort: "low",
            hidden: false,
            from: "harness",
          },
        ],
      },
    ],
  },
  {
    profile: "b",
    name: "vm",
    problem: null,
    catalogues: [
      {
        harness: "claude",
        at: "2026-10-29T12:01:00Z",
        table: null,
        entries: [
          {
            model: "opus",
            label: "Opus",
            description: null,
            efforts: ["low", "high"],
            defaultEffort: "high",
            hidden: false,
            from: "harness",
          },
          {
            model: "proxy",
            label: "proxy",
            description: null,
            efforts: [],
            defaultEffort: null,
            hidden: false,
            from: "added",
          },
        ],
      },
    ],
  },
];

test("Settings merges models and each effort across Machines without claiming universal availability", () => {
  const view = settingsAgentSelects(readings, ["a", "b"], {
    harness: "claude",
    model: "opus",
    effort: "max",
  });
  expect(view.model.options.find(({ value }) => value === "sonnet")?.description).toContain(
    "1 of 2 Machines",
  );
  expect(view.model.options.find(({ value }) => value === "opus")?.description).toContain(
    "2 of 2 Machines",
  );
  expect(
    view.effort.options
      .filter(({ value }) => value !== "")
      .map(({ value, description }) => [value, description]),
  ).toEqual([
    ["high", "2 of 2 Machines"],
    ["max", "1 of 2 Machines"],
    ["low", "1 of 2 Machines"],
  ]);
  expect(view.model.options.find(({ value }) => value === "proxy")?.description).toContain(
    "Added by models.claude",
  );
  expect(view.lead).toContain("12:00");
});

test("picking a model clears an effort it cannot run, retaining one it reports", () => {
  const current = { harness: "claude", model: "opus", effort: "max" };
  expect(agentSettingChanges(readings, ["a", "b"], current, "model", "sonnet")).toEqual([
    { key: "effort", value: "" },
    { key: "model", value: "sonnet" },
  ]);
  expect(
    agentSettingChanges(readings, ["a", "b"], { ...current, effort: "low" }, "model", "sonnet"),
  ).toEqual([{ key: "model", value: "sonnet" }]);
  expect(agentSettingChanges(readings, ["a", "b"], current, "harness", "pi")).toEqual([
    { key: "effort", value: "" },
    { key: "model", value: "default" },
    { key: "harness", value: "pi" },
  ]);
});

test("an older or failed Machine catalogue is explained and cannot hold back the others", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const read = yield* cataloguesOn(
        { profile: "old", name: "old-mini" },
        { models: () => Effect.die("Unknown request tag models") },
      );
      expect(read).toEqual({
        profile: "old",
        name: "old-mini",
        catalogues: [],
        problem: "Can't read its catalogues; upgrade this Machine.",
      });
      const view = settingsAgentSelects([...readings, read], ["a", "b", "old"], {
        harness: "claude",
        model: "opus",
      });
      expect(view.model.label).toContain("2 of 3 Machines");
      expect(view.lead).toContain("old-mini: Can't read its catalogues");
    }),
  ));

test("fallback order is saved and entries carry their Subscription usage without assigning one to other providers", () => {
  const value = "claude/sonnet, codex, pi/google/gemini";
  const changed = changeFallbacks(value, { at: 1, move: "up" });
  const saved = editSetting(NO_FLOCK_SETTINGS, "fallbacks", changed, "2026-10-29T12:00:00Z");
  expect(saved).not.toHaveProperty("refused");
  if ("refused" in saved) throw new Error(saved.refused);
  expect(saved.settings.fallbacks?.value).toEqual(["codex", "claude/sonnet", "pi/google/gemini"]);
  const view = fallbackList(
    value,
    readings,
    ["a", "b"],
    [
      {
        profile: "a",
        name: "laptop",
        problem: null,
        readings: [
          {
            subscription: "claude",
            account: "one",
            accountLabel: null,
            plan: null,
            at: "2026-10-29T12:00:00Z",
            source: "claude-usage",
            problem: null,
            windows: [
              {
                kind: "session",
                label: "Session",
                model: null,
                usedPercent: 72,
                resetsAt: null,
                reached: false,
              },
            ],
          },
          {
            subscription: "chatgpt",
            account: "two",
            accountLabel: null,
            plan: null,
            at: "2026-10-29T12:00:00Z",
            source: "codex-app-server",
            problem: null,
            windows: [
              {
                kind: "session",
                label: "Session",
                model: null,
                usedPercent: 21,
                resetsAt: null,
                reached: false,
              },
            ],
          },
        ],
      },
    ],
    epochMs("2026-10-29T12:01:00Z"),
  );
  expect(view.entries.map(({ usage }) => usage.map(({ text }) => text))).toEqual([
    ["Claude 72%"],
    ["ChatGPT 21%"],
    [],
  ]);
  expect(changeFallbacks(value, { at: 0, move: "down" })).toBe(
    "codex, claude/sonnet, pi/google/gemini",
  );
  expect(changeFallbacks(value, { at: 1, move: "remove" })).toBe("claude/sonnet, pi/google/gemini");
  expect(changeFallbacks(value, { add: "claude/sonnet" })).toBe(value);
  expect(changeFallbacks("", { add: "pi/google/gemini" })).toBe("pi/google/gemini");
});
