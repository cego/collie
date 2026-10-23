// What the Flock chat runs on with nothing set, the account every chat window is pushed, and
// what the harness, model and effort selects beside the message box show of it.

import { expect, test } from "bun:test";
import { Effect, Stream, SubscriptionRef } from "effect";
import { chatChoicesOf, chatChoicesStream } from "../desktop/src/bun/chat-choices";
import type { Lists } from "../desktop/src/bun/harness-lists";
import { changeSettings } from "../desktop/src/bun/settings";
import {
  type ChatChoices,
  type ChatHeld,
  chatNotice,
  chatSelects,
  chosen,
  heldChoice,
  type ListedModel,
  type Offer,
  type Offered,
  type PiConfig,
  refusedChoice,
  resolveChat,
  searched,
  stayChange,
  tableOffer,
  typedEntry,
  typedModel,
} from "../desktop/src/shared/chat-choices";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import {
  type FlockSettings,
  NO_FLOCK_SETTINGS,
  takeFrom,
} from "../desktop/src/shared/flock-settings";

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const ids = (offer: Offer) => (offer.from === "reading" ? [] : offer.models.map(({ id }) => id));
const offered = (id: string, efforts: ReadonlyArray<string> = LEVELS): Offered => ({
  id,
  label: id,
  efforts,
  unsetEffort: efforts.length === 0 ? null : "medium",
});

test("unset on Claude Code, the chat runs opus at medium, and a model that lists no effort runs at none", () => {
  const models = [offered("opus"), offered("sonnet"), offered("claude-haiku-4-5", [])];
  expect(resolveChat({ harness: "claude" }, models, {})).toEqual({
    harness: "claude",
    model: "opus",
    effort: "medium",
  });
  expect(resolveChat({ harness: "claude", model: "sonnet" }, models, {})).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "medium",
  });
  expect(resolveChat({ harness: "claude", model: "sonnet", effort: "max" }, models, {})).toEqual({
    harness: "claude",
    model: "sonnet",
    effort: "max",
  });
  expect(resolveChat({ harness: "claude", model: "claude-haiku-4-5" }, models, {})).toEqual({
    harness: "claude",
    model: "claude-haiku-4-5",
    effort: null,
  });
  // A typed model off the list takes the table's efforts.
  expect(resolveChat({ harness: "claude", model: "claude-opus-5" }, models, {})).toEqual({
    harness: "claude",
    model: "claude-opus-5",
    effort: "medium",
  });
});

test("unset on Pi, the chat runs Pi's configured model at its configured level for each model", () => {
  const pi = {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
    defaultThinkingLevel: "high",
    modelThinkingLevels: { "openai-codex/gpt-5.5": "low" },
  };
  const models = [offered("openai-codex/gpt-5.5"), offered("openai-codex/gpt-6-astra")];
  expect(resolveChat({ harness: "pi" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6.1-sol",
    effort: "high",
  });
  expect(resolveChat({ harness: "pi", model: "openai-codex/gpt-5.5" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-5.5",
    effort: "low",
  });
  expect(resolveChat({ harness: "pi", model: "openai-codex/gpt-6-astra" }, models, pi)).toEqual({
    harness: "pi",
    model: "openai-codex/gpt-6-astra",
    effort: "high",
  });
  expect(
    resolveChat({ harness: "pi", model: "openai-codex/gpt-6-astra" }, models, {
      modelThinkingLevels: {},
    }),
  ).toEqual({ harness: "pi", model: "openai-codex/gpt-6-astra", effort: "medium" });
  // With none configured it is Pi's own default, which the driver is given no --model for.
  expect(resolveChat({ harness: "pi" }, models, { defaultThinkingLevel: "xhigh" })).toEqual({
    harness: "pi",
    model: "default",
    effort: "xhigh",
  });
  expect(
    resolveChat(
      { harness: "pi", model: "openai-codex/gpt-6-astra" },
      [offered("openai-codex/gpt-6-astra", [])],
      pi,
    ),
  ).toEqual({ harness: "pi", model: "openai-codex/gpt-6-astra", effort: null });
});

const extras = (harness: string, models: ReadonlyArray<string>): FlockSettings =>
  takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
    { key: `models.${harness}`, value: [...models], at: "2026-10-22T00:00:00Z" },
  ]).flock;

test("a harness's list from Collie's table holds its models, the Flock's extras and the set model, each with the table's efforts, and nothing the check would refuse", () => {
  const claude = tableOffer("claude", "claude-opus-5", ["proxy-large"], {});
  expect(claude.from).toBe("table");
  expect(claude.models.map(({ id }) => id)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
    "proxy-large",
    "claude-opus-5",
  ]);
  expect(claude.models[1]).toEqual({
    id: "opus",
    label: "opus",
    efforts: LEVELS,
    unsetEffort: "medium",
  });
  expect(claude.unset).toEqual({ harness: "claude", model: "opus", effort: "medium" });

  const pi = tableOffer("pi", "gpt-5.5", ["openai-codex/gpt-6.1-sol"], {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-6.1-sol",
    modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "xhigh" },
  });
  // "gpt-5.5" names no provider, which the check refuses.
  expect(pi.models).toEqual([
    {
      id: "openai-codex/gpt-6.1-sol",
      label: "openai-codex/gpt-6.1-sol",
      efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      unsetEffort: "xhigh",
    },
  ]);
  expect(pi.unset).toEqual({ harness: "pi", model: "openai-codex/gpt-6.1-sol", effort: "xhigh" });
});

test("the account names each harness, whether it is installed, and what it offers, and the set model only on the set harness", () => {
  const held: ChatHeld = { heldOn: "claude", runsOn: null, turning: false };
  const choices = chatChoicesOf(
    held,
    { claude: true, pi: false },
    { proactive: true, chatHarness: "claude", chatModel: "claude-opus-5" },
    extras("pi", ["openai-codex/gpt-5.5"]),
    {},
  );
  expect(choices).toMatchObject({ heldOn: "claude", runsOn: null, turning: false });
  expect(
    choices.harnesses.map(({ harness, label, installed, offered }) => ({
      harness,
      label,
      installed,
      models: ids(offered),
    })),
  ).toEqual([
    {
      harness: "claude",
      label: "Claude Code",
      installed: true,
      models: ["fable", "opus", "sonnet", "haiku", "opusplan", "claude-opus-5"],
    },
    { harness: "pi", label: "Pi", installed: false, models: ["openai-codex/gpt-5.5"] },
  ]);
});

test("the account is sent when subscribed, and again on every change to what the chat holds, to Settings and to the Flock's models", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = yield* SubscriptionRef.make<ChatHeld>({
        heldOn: "claude",
        runsOn: null,
        turning: false,
      });
      const settings = yield* SubscriptionRef.make<DesktopSettings>({ proactive: true });
      const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
      const sent: ChatChoices[] = [];
      yield* chatChoicesStream({
        held: SubscriptionRef.changes(held),
        settings: SubscriptionRef.changes(settings),
        flock: SubscriptionRef.changes(flock),
        installed: { claude: true, pi: true },
        pi: Effect.succeed({}),
      }).pipe(
        Stream.runForEach((choices) => Effect.sync(() => sent.push(choices))),
        Effect.forkChild,
      );
      /** Lets the stream catch up, then sees it sent `count` accounts so far. */
      const told = (count: number) =>
        Effect.gen(function* () {
          for (let turn = 0; turn < 1000 && sent.length < count + 1; turn++) yield* Effect.yieldNow;
          expect(sent).toHaveLength(count);
        });
      yield* told(1);
      yield* SubscriptionRef.set(held, { heldOn: "claude", runsOn: null, turning: true });
      yield* told(2);
      yield* SubscriptionRef.set(settings, { proactive: true, chatModel: "sonnet" });
      yield* told(3);
      // Another setting of the Flock's changes no harness's models.
      yield* SubscriptionRef.set(
        flock,
        takeFrom(NO_FLOCK_SETTINGS, "vm-a", [
          { key: "effort", value: "high", at: "2026-10-22T00:00:00Z" },
        ]).flock,
      );
      yield* told(3);
      yield* SubscriptionRef.set(flock, extras("pi", ["openai-codex/gpt-5.5"]));
      yield* told(4);
      yield* SubscriptionRef.set(held, {
        heldOn: "claude",
        runsOn: { harness: "claude", model: "sonnet", effort: "medium" },
        turning: false,
      });
      yield* told(5);
      const pi = (choices: ChatChoices) =>
        ids(choices.harnesses.find(({ harness }) => harness === "pi")!.offered);
      expect(sent.map(({ turning }) => turning)).toEqual([false, true, true, true, false]);
      expect(sent.map(pi)).toEqual([
        [],
        [],
        [],
        ["openai-codex/gpt-5.5"],
        ["openai-codex/gpt-5.5"],
      ]);
      expect(ids(sent[2]!.harnesses[0]!.offered)).toContain("sonnet");
      expect(sent[4]!.runsOn).toEqual({ harness: "claude", model: "sonnet", effort: "medium" });
    }).pipe(Effect.scoped),
  ));

/** The account as the table offers it, with both harnesses installed unless said otherwise. */
const account = (
  settings: DesktopSettings,
  installed: Readonly<Record<string, boolean>> = { claude: true, pi: true },
) =>
  chatChoicesOf(
    { heldOn: "claude", runsOn: null, turning: false },
    installed,
    settings,
    NO_FLOCK_SETTINGS,
    {},
  );

test("the harness select names each harness, and one not installed is disabled saying so", () => {
  const settings = { proactive: true };
  const { harness } = chatSelects(settings, account(settings, { claude: true, pi: false }));
  expect(harness.label).toBe("Claude Code");
  expect(harness.name).toBe("Harness: Claude Code");
  expect(harness.options).toEqual([
    { value: "claude", label: "Claude Code" },
    { value: "pi", label: "Pi", disabled: "not installed on this computer" },
  ]);
  expect(harness.note).toBe("Another harness starts a new conversation with your next message.");
});

test("the model select starts with the default, named by what it runs as, then the offered models, and shows the set model even when it is not offered", () => {
  const unset = { proactive: true };
  const { model } = chatSelects(unset, account(unset));
  expect(model.options[0]).toEqual({
    value: "default",
    label: "Default · opus",
    description: "What the chat runs with no model set",
  });
  expect(model.options.slice(1).map(({ value }) => value)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
  ]);
  expect(model.label).toBe("Default · opus");
  expect(model.name).toBe("Model: Default · opus");

  const pi = { proactive: true, chatHarness: "pi" };
  expect(chatSelects(pi, account(pi)).model.options[0]!.label).toBe("Default · Pi's own default");

  const sonnet = { proactive: true, chatModel: "sonnet" };
  const described: ChatChoices = {
    ...account(sonnet),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [{ ...offered("opus"), label: "Opus 5.5", description: "For the hardest work" }],
        },
      },
    ],
  };
  const shown = chatSelects(sonnet, described).model;
  expect(shown.options).toEqual([
    {
      value: "default",
      label: "Default · Opus 5.5",
      description: "What the chat runs with no model set",
    },
    { value: "opus", label: "Opus 5.5", description: "For the hardest work" },
    { value: "sonnet", label: "sonnet" },
  ]);
  expect(shown.name).toBe("Model: sonnet");
  expect(typedModel("openai-codex/gpt-5.5")).toBe("Use openai-codex/gpt-5.5");
});

test("the model menu offers to use a typed id it does not offer, even one part of another's name, and nothing else", () => {
  const unset = { proactive: true };
  const { model } = chatSelects(unset, {
    ...account(unset),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: tableOffer("claude", undefined, ["claude-opus-5-20261001"], {}),
      },
    ],
  });
  expect(typedEntry(model, " claude-opus-5 ")).toBe("claude-opus-5");
  expect(typedEntry(model, "claude-opus-5-20261001")).toBeNull();
  expect(typedEntry(model, "default")).toBeNull();
  expect(typedEntry(model, "  ")).toBeNull();
});

test("the effort select starts with the default level, then the levels the set model takes", () => {
  const settings = { proactive: true, chatModel: "sonnet", chatEffort: "high" };
  const choices: ChatChoices = {
    ...account(settings),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [
            offered("opus"),
            { ...offered("sonnet", ["low", "high"]), label: "Sonnet 5.5", unsetEffort: "low" },
          ],
        },
      },
    ],
  };
  const { effort } = chatSelects(settings, choices);
  expect(effort.options).toEqual([
    {
      value: "default",
      label: "Default · Low",
      description: "What the chat runs with no effort set",
    },
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ]);
  expect(effort.label).toBe("High");
  expect(effort.name).toBe("Effort: High");
  expect(effort.disabled).toBeNull();
  expect(effort.note).toBe("The levels Sonnet 5.5 takes");

  const unset = { proactive: true };
  const opus = chatSelects(unset, account(unset)).effort;
  expect(opus.options.map(({ label }) => label)).toEqual([
    "Default · Medium",
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Max",
  ]);
  expect(opus.name).toBe("Effort: Default · Medium");
  expect(opus.note).toBe("The levels opus takes");
});

test("for a model that lists no effort, the effort select is disabled and says the model takes none", () => {
  const settings = { proactive: true, chatModel: "claude-haiku-4-5" };
  const choices: ChatChoices = {
    ...account(settings),
    harnesses: [
      {
        harness: "claude",
        label: "Claude Code",
        installed: true,
        offered: {
          from: "table",
          unset: { harness: "claude", model: "opus", effort: "medium" },
          models: [{ ...offered("claude-haiku-4-5", []), label: "Haiku 4.5" }],
        },
      },
    ],
  };
  const { effort } = chatSelects(settings, choices);
  expect(effort.disabled).toBe("Haiku 4.5 takes no effort");
  expect(effort.label).toBe("Haiku 4.5 takes no effort");
  expect(effort.name).toBe("Effort: none. Haiku 4.5 takes no effort");
  expect(effort.options).toEqual([]);
});

/** Claude Code's own list, as its reader gives it. */
const CLAUDE_LISTED: ReadonlyArray<ListedModel> = [
  {
    id: "opus",
    label: "Opus 5.5",
    description: "For complex work and everyday tasks",
    efforts: LEVELS,
  },
  {
    id: "sonnet",
    label: "Sonnet 5.5",
    description: "Most efficient for simpler tasks",
    efforts: LEVELS,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    description: "Fastest for quick answers",
    efforts: [],
  },
];

/** The account with Claude Code's list as `lists` hold it. */
const listedAccount = (settings: DesktopSettings, lists: Lists) =>
  chatChoicesOf(
    { heldOn: "claude", runsOn: null, turning: false },
    { claude: true, pi: true },
    settings,
    NO_FLOCK_SETTINGS,
    {},
    lists,
  );

test("with Claude Code's own list, the selects show its labels and descriptions, and say Claude Code listed them", () => {
  const unset = { proactive: true };
  const lists: Lists = { claude: { from: "harness", models: CLAUDE_LISTED } };
  const { model, effort } = chatSelects(unset, listedAccount(unset, lists));
  expect(model.label).toBe("Default · Opus 5.5");
  expect(model.options).toEqual([
    {
      value: "default",
      label: "Default · Opus 5.5",
      description: "What the chat runs with no model set",
    },
    { value: "opus", label: "Opus 5.5", description: "For complex work and everyday tasks" },
    { value: "sonnet", label: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
    {
      value: "claude-haiku-4-5-20251001",
      label: "Haiku 4.5",
      description: "Fastest for quick answers · takes no effort",
    },
  ]);
  expect(model.note).toBe("Listed by Claude Code on this computer");
  expect(model.warning).toBeNull();
  expect(model.reading).toBe(false);
  expect(effort.label).toBe("Default · Medium");

  const haiku = { proactive: true, chatModel: "claude-haiku-4-5-20251001" };
  const none = chatSelects(haiku, listedAccount(haiku, lists)).effort;
  expect(none.disabled).toBe("Haiku 4.5 takes no effort");
  expect(none.name).toBe("Effort: none. Haiku 4.5 takes no effort");
});

test("while Claude Code's list is read, the model menu says so and still offers the set model", () => {
  const set = { proactive: true, chatModel: "claude-opus-5" };
  const reading = listedAccount(set, { claude: { from: "reading" } });
  expect(reading.harnesses[0]!.offered).toEqual({ from: "reading" });
  const { model, effort } = chatSelects(set, reading);
  expect(model.reading).toBe(true);
  expect(model.note).toBe("Reading Claude Code's models… You can still type a model id.");
  expect(model.options.map(({ value }) => value)).toEqual(["default", "claude-opus-5"]);
  expect(model.label).toBe("claude-opus-5");
  expect(effort.label).toBe("Default · Medium");
});

test("a list that could not be read opens the model menu with why, over Collie's table", () => {
  const unset = { proactive: true };
  const table = listedAccount(unset, {
    claude: { from: "table", why: "Claude Code is not logged in" },
  });
  const offer = table.harnesses[0]!.offered;
  expect(offer.from === "table" && offer.why).toBe("Claude Code is not logged in");
  const { model } = chatSelects(unset, table);
  expect(model.warning).toBe(
    "Claude Code's list could not be read: Claude Code is not logged in. Showing Collie's table, so models are named by id.",
  );
  expect(model.reading).toBe(false);
  expect(model.options.slice(1).map(({ label }) => label)).toEqual([
    "fable",
    "opus",
    "sonnet",
    "haiku",
    "opusplan",
  ]);
});

/** Pi's own list as its reader gives it: levels differ by model. */
const PI_LISTED: ReadonlyArray<ListedModel> = [
  {
    id: "openai-codex/gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "openai-codex/gpt-5.5",
    label: "GPT-5.5",
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
  },
  { id: "openai/gpt-4o-mini", label: "GPT-4o mini", efforts: [] },
];

test("on Pi, an unset effort runs at the configured level where the model takes it, else at the nearest it takes, as Pi clamps", () => {
  const models = PI_LISTED.map((model) => ({ ...model, unsetEffort: null }));
  const resolve = (model: string, pi: PiConfig) =>
    resolveChat({ harness: "pi", model }, models, pi);
  expect(resolve("openai-codex/gpt-5.5", { defaultThinkingLevel: "high" }).effort).toBe("high");
  expect(resolve("openai-codex/gpt-5.5", { defaultThinkingLevel: "max" }).effort).toBe("xhigh");
  expect(
    resolve("openai-codex/gpt-6.1-sol", {
      modelThinkingLevels: { "openai-codex/gpt-6.1-sol": "off" },
    }).effort,
  ).toBe("minimal");
  expect(resolve("openai/gpt-4o-mini", { defaultThinkingLevel: "max" }).effort).toBeNull();
  // A level the human set is theirs, not clamped.
  expect(
    resolveChat({ harness: "pi", model: "openai-codex/gpt-5.5", effort: "low" }, models, {
      defaultThinkingLevel: "max",
    }).effort,
  ).toBe("low");
});

test("the model menu finds a model by its id as well as its name, and a found id is not offered again to type", () => {
  const set = { proactive: true, chatHarness: "pi" };
  const { model } = chatSelects(
    set,
    chatChoicesOf(
      { heldOn: "pi", runsOn: null, turning: false },
      { claude: true, pi: true },
      set,
      NO_FLOCK_SETTINGS,
      {},
      { pi: { from: "harness", models: PI_LISTED } },
    ),
  );
  const found = (search: string) => searched(model, search).map(({ value }) => value);
  expect(found("openai-codex/gpt-5.5")).toEqual(["openai-codex/gpt-5.5"]);
  expect(found("Sol")).toEqual(["openai-codex/gpt-6.1-sol"]);
  expect(found("4O-MINI")).toEqual(["openai/gpt-4o-mini"]);
  expect(found("anthropic/")).toEqual([]);
  expect(found("")).toEqual(model.options.map(({ value }) => value));
  expect(typedEntry(model, "openai-codex/gpt-5.5")).toBeNull();
});

test("with Pi's own list, the selects offer each model only its own levels, and the unset level as Pi runs it", () => {
  const set = { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" };
  const account = chatChoicesOf(
    { heldOn: "pi", runsOn: null, turning: false },
    { claude: true, pi: true },
    set,
    NO_FLOCK_SETTINGS,
    { defaultThinkingLevel: "max" },
    { pi: { from: "harness", models: PI_LISTED } },
  );
  const { model, effort } = chatSelects(set, account);
  expect(model.note).toBe("Listed by Pi on this computer");
  expect(model.options.slice(1)).toEqual([
    { value: "openai-codex/gpt-6.1-sol", label: "GPT-6.1 Sol" },
    { value: "openai-codex/gpt-5.5", label: "GPT-5.5" },
    { value: "openai/gpt-4o-mini", label: "GPT-4o mini", description: "takes no effort" },
  ]);
  expect(effort.options.map(({ label }) => label)).toEqual([
    "Default · Extra high",
    "Off",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "Extra high",
  ]);
  const sol = { ...set, chatModel: "openai-codex/gpt-6.1-sol" };
  expect(chatSelects(sol, account).effort.options.map(({ value }) => value)).toEqual([
    "default",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("a typed model Pi's list lacks says the level Pi has configured for it, not the default model's", () => {
  const set = { proactive: true, chatHarness: "pi", chatModel: "ollama/typed" };
  const account = chatChoicesOf(
    { heldOn: "pi", runsOn: null, turning: false },
    { claude: true, pi: true },
    set,
    NO_FLOCK_SETTINGS,
    {
      defaultProvider: "openai-codex",
      defaultModel: "gpt-5.5",
      defaultThinkingLevel: "low",
      modelThinkingLevels: { "ollama/typed": "high" },
    },
    { pi: { from: "harness", models: PI_LISTED } },
  );
  expect(chatSelects(set, account).effort.label).toBe("Default · High");
});

test("choosing a select's default unsets it, and any other entry sets it", () => {
  expect(chosen("model", "default")).toEqual({ chatModel: "" });
  expect(chosen("effort", "default")).toEqual({ chatEffort: "" });
  expect(chosen("model", "sonnet")).toEqual({ chatModel: "sonnet" });
  expect(chosen("effort", "high")).toEqual({ chatEffort: "high" });
  expect(chosen("harness", "pi")).toEqual({ chatHarness: "pi" });
});

test("a refused choice is said with its reason, ending that nothing was saved", () => {
  expect(refusedChoice('"max" is not an effort sonnet takes (low, high)')).toBe(
    '"max" is not an effort sonnet takes (low, high). Nothing was saved.',
  );
  expect(
    refusedChoice(
      '"gpt-5.5" is not a model pi takes. Write provider/model, for example openai-codex/gpt-6.1-sol.',
    ),
  ).toBe(
    '"gpt-5.5" is not a model pi takes. Write provider/model, for example openai-codex/gpt-6.1-sol. Nothing was saved.',
  );
});

/** The account with Claude Code's own list, as `held` says the chat holds and runs. */
const heldAccount = (settings: DesktopSettings, held: ChatHeld) =>
  chatChoicesOf(
    held,
    { claude: true, pi: true },
    settings,
    NO_FLOCK_SETTINGS,
    {},
    { claude: { from: "harness", models: CLAUDE_LISTED } },
  );
const IDLE: ChatHeld = { heldOn: "claude", runsOn: null, turning: false };

test("while the set harness is not the one held, the window says the next message starts a new conversation on it, with Stay on the held one", () => {
  const onPi = { proactive: true, chatHarness: "pi" };
  expect(chatNotice(onPi, heldAccount(onPi, IDLE))).toEqual({
    kind: "switch",
    said: "Your next message starts a new conversation on Pi.",
    stay: "Stay on Claude Code",
  });
  const turning = {
    ...IDLE,
    runsOn: { harness: "claude", model: "opus", effort: "high" },
    turning: true,
  };
  expect(chatNotice(onPi, heldAccount(onPi, turning))?.kind).toBe("switch");
  const held = { proactive: true, chatModel: "sonnet" };
  expect(chatNotice(held, heldAccount(held, IDLE))).toBeNull();
});

test("Stay restores the harness, model and effort last seen while the set harness was held, through the same check as any choice", () => {
  const set = { proactive: true, chatModel: "sonnet", chatEffort: "high" };
  const seen = heldChoice(null, set, IDLE.heldOn);
  const onPi = { proactive: true, chatHarness: "pi" };
  expect(heldChoice(seen, onPi, IDLE.heldOn)).toEqual(seen);
  const change = stayChange(heldChoice(seen, onPi, IDLE.heldOn), IDLE.heldOn);
  expect(changeSettings(onPi, NO_FLOCK_SETTINGS, change)).toEqual({
    proactive: true,
    chatHarness: "claude",
    chatModel: "sonnet",
    chatEffort: "high",
  });
  // What was unset is put back unset.
  const unset = heldChoice(null, { proactive: true }, IDLE.heldOn);
  const piSet = { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" };
  expect(changeSettings(piSet, NO_FLOCK_SETTINGS, stayChange(unset, IDLE.heldOn))).toEqual({
    proactive: true,
    chatHarness: "claude",
  });
});

test("a window that never saw the held harness set, as one opened after the switch, restores the harness alone", () => {
  const onPi = { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" };
  const seen = heldChoice(null, onPi, "claude");
  expect(seen).toBeNull();
  expect(stayChange(seen, "claude")).toEqual({ chatHarness: "claude" });
  expect(changeSettings(onPi, NO_FLOCK_SETTINGS, stayChange(seen, "claude"))).toEqual({
    proactive: true,
    chatHarness: "claude",
  });
});

test("a choice last seen on another harness than the one now held is not put back, so Stay keeps the held harness", () => {
  const onClaude = { proactive: true, chatModel: "sonnet", chatEffort: "high" };
  const seen = heldChoice(null, onClaude, "claude");
  const heldOnPi = heldChoice(seen, onClaude, "pi");
  expect(heldOnPi).toBeNull();
  expect(changeSettings(onClaude, NO_FLOCK_SETTINGS, stayChange(heldOnPi, "pi"))).toEqual({
    proactive: true,
    chatHarness: "pi",
  });
});

test("during a turn, a set choice that runs as something else says what the reply finishes on and what the next message runs on, by their offered labels", () => {
  const set = { proactive: true, chatModel: "sonnet" };
  const turning: ChatHeld = {
    heldOn: "claude",
    runsOn: { harness: "claude", model: "opus", effort: "high" },
    turning: true,
  };
  expect(chatNotice(set, heldAccount(set, turning))).toEqual({
    kind: "reply",
    finishes: "Opus 5.5 · High",
    next: "Sonnet 5.5 · Medium",
    said: "This reply finishes on Opus 5.5 · High. Your next message runs on Sonnet 5.5 · Medium.",
  });
  const haiku = { proactive: true, chatModel: "claude-haiku-4-5-20251001" };
  expect(chatNotice(haiku, heldAccount(haiku, turning))).toMatchObject({ next: "Haiku 4.5" });
  // Once the turn is over, the next message runs on the set choice and nothing is said.
  expect(chatNotice(set, heldAccount(set, { ...turning, turning: false }))).toBeNull();
});

test("no notice is shown during a turn when the set choice only resolves to what runs", () => {
  const unset = { proactive: true };
  const turning: ChatHeld = {
    heldOn: "claude",
    runsOn: { harness: "claude", model: "opus", effort: "medium" },
    turning: true,
  };
  expect(chatNotice(unset, heldAccount(unset, turning))).toBeNull();
  const same = { proactive: true, chatModel: "opus", chatEffort: "medium" };
  expect(chatNotice(same, heldAccount(same, turning))).toBeNull();
});
