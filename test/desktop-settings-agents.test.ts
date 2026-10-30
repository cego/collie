import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, Schema, flow, Result } from "effect";
import { CodexModelList, codexEntries, withAdded } from "../src/catalogue-model";
import codexModelList from "./fixtures/catalogue/codex-model-list.json";
import { epochMs } from "../src/time";
import { cataloguesOn } from "../desktop/src/bun/machine";
import {
  settingsAgentSelects,
  fallbackList,
  changeFallbacks,
  agentSettingChanges,
  rememberCatalogues,
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

test("an explicitly added hidden model is offered for the primary agent and fallbacks", () => {
  const added: ReadonlyArray<MachineCatalogue> = [
    {
      profile: "a",
      name: "laptop",
      problem: null,
      catalogues: [
        withAdded(
          {
            harness: "codex",
            at: "2026-10-29T12:00:00Z",
            table: null,
            entries: codexEntries(
              flow(Schema.decodeResult(CodexModelList), Result.getOrThrow)(codexModelList),
            ),
          },
          ["gpt-reserve"],
        ),
      ],
    },
  ];
  expect(
    Option.getOrUndefined(
      Arr.findFirst(
        settingsAgentSelects(added, ["a"], { harness: "codex" }).model.options,
        ({ value }) => value === "gpt-reserve",
      ),
    ),
  ).toMatchObject({
    value: "gpt-reserve",
    description: expect.stringContaining("Added by models.codex"),
  });
  expect(
    Arr.some(
      fallbackList("", added, ["a"], [], 0).add.options,
      ({ value }) => value === "codex/gpt-reserve",
    ),
  ).toBe(true);
});

test("a native-default model offers its reported efforts and preserves the configured choice", () => {
  const native: ReadonlyArray<MachineCatalogue> = [
    {
      profile: "a",
      name: "laptop",
      problem: null,
      catalogues: [
        {
          harness: "codex",
          at: "2026-10-29T12:00:00Z",
          table: null,
          entries: codexEntries(
            flow(Schema.decodeResult(CodexModelList), Result.getOrThrow)(codexModelList),
          ),
        },
      ],
    },
  ];
  for (const model of ["default", undefined]) {
    const view = settingsAgentSelects(native, ["a"], { harness: "codex", model, effort: "high" });
    expect(view.effort.disabled).toBe(false);
    expect(view.effort.label).toBe("high");
    expect(Arr.map(view.effort.options, ({ value }) => value)).toEqual([
      "",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  }
});

test("native defaults merge each Machine's capabilities and use reported efforts when no default is identified", () => {
  const entry = (model: string, efforts: string[], isDefault = false) => ({
    model,
    label: model,
    description: null,
    efforts,
    isDefault,
    defaultEffort: null,
    hidden: false,
    from: "harness" as const,
  });
  const machines: ReadonlyArray<MachineCatalogue> = [
    {
      profile: "a",
      name: "laptop",
      problem: null,
      catalogues: [
        {
          harness: "codex",
          at: "2026-10-29T12:00:00Z",
          table: null,
          entries: [entry("native-a", ["low"], true), entry("other", ["ultra"])],
        },
      ],
    },
    {
      profile: "b",
      name: "vm",
      problem: null,
      catalogues: [
        {
          harness: "codex",
          at: "2026-10-29T12:00:00Z",
          table: null,
          entries: [entry("unknown-a", ["high"]), entry("unknown-b", ["max"])],
        },
      ],
    },
  ];
  const view = settingsAgentSelects(machines, ["a", "b"], { harness: "codex", model: "default" });
  expect(Arr.map(view.effort.options, ({ value, description }) => [value, description])).toEqual([
    ["", undefined],
    ["low", "1 of 2 Machines"],
    ["high", "1 of 2 Machines"],
    ["max", "1 of 2 Machines"],
  ]);
});

test("Settings merges models and each effort across Machines without claiming universal availability", () => {
  const view = settingsAgentSelects(readings, ["a", "b"], {
    harness: "claude",
    model: "opus",
    effort: "max",
  });
  expect(
    Option.getOrUndefined(Arr.findFirst(view.model.options, ({ value }) => value === "sonnet"))
      ?.description,
  ).toContain("1 of 2 Machines");
  expect(
    Option.getOrUndefined(Arr.findFirst(view.model.options, ({ value }) => value === "opus"))
      ?.description,
  ).toContain("2 of 2 Machines");
  expect(
    Arr.map(
      Arr.filter(view.effort.options, ({ value }) => value !== ""),
      ({ value, description }) => [value, description],
    ),
  ).toEqual([
    ["high", "2 of 2 Machines"],
    ["max", "1 of 2 Machines"],
    ["low", "1 of 2 Machines"],
  ]);
  expect(
    Option.getOrUndefined(Arr.findFirst(view.model.options, ({ value }) => value === "proxy"))
      ?.description,
  ).toContain("Added by models.claude");
  expect(view.lead).toContain("12:00");
});

test("an unreachable Machine keeps its last catalogue count and names its older reading, while an unread Machine adds only to the total", () => {
  const machines = [
    { profile: "a", name: "laptop", state: "unreachable" as const },
    { profile: "b", name: "vm-gpu", state: "live" as const },
    { profile: "new", name: "old-mini", state: "connecting" as const },
  ];
  const remembered = rememberCatalogues(readings, [readings[1]!], machines);
  const view = settingsAgentSelects(
    remembered,
    ["a", "b", "new"],
    { harness: "claude", model: "opus" },
    epochMs("2026-10-29T13:00:00Z"),
  );
  expect(view.model.label).toContain("2 of 3 Machines");
  expect(view.lead).toContain("laptop's at");
  expect(view.lead).toContain("12:00");
  expect(view.lead).toContain("old-mini not read yet");
  expect(
    rememberCatalogues(
      remembered,
      readings,
      Arr.map(machines.slice(0, 2), (one) => ({ ...one, state: "live" as const })),
    )[0]?.problem,
  ).toBeNull();
});

test("picking a model clears an effort it cannot run, retaining one it reports", () => {
  const current = { harness: "claude", model: "opus", effort: "max" };
  expect(agentSettingChanges(readings, ["a", "b"], current, "model", "sonnet")).toEqual([
    { key: "harness", value: "claude" },
    { key: "model", value: "sonnet" },
    { key: "effort", value: "" },
  ]);
  expect(
    agentSettingChanges(readings, ["a", "b"], { ...current, effort: "low" }, "model", "sonnet"),
  ).toEqual([
    { key: "harness", value: "claude" },
    { key: "model", value: "sonnet" },
    { key: "effort", value: "low" },
  ]);
  expect(agentSettingChanges(readings, ["a", "b"], current, "harness", "pi")).toEqual([
    { key: "harness", value: "pi" },
    { key: "model", value: "default" },
    { key: "effort", value: "" },
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
      expect(view.lead).toContain("old-mini not read yet: Can't read its catalogues");
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
  expect(Arr.map(view.entries, ({ usage }) => Arr.map(usage, ({ text }) => text))).toEqual([
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
