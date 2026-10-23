// What the Flock chat runs on with nothing set, what every chat window is told of it, and what
// the harness, model and effort selects beside the message box show. No Bun-only import: the
// view bundles this.

import { Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS, resolveChoice } from "../../../src/harness-choice";
import type { DesktopSettings, DesktopSettingsChange } from "./flock";
import { DEFAULT_CHAT_HARNESS, harnessLabel } from "./flock-settings";

/** What a session runs on: no effort where its model takes none. */
export const Resolved = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type Resolved = typeof Resolved.Type;

/** A model a harness offers, with the efforts it takes and the one it runs at with none set. */
export const Offered = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String),
  unsetEffort: Schema.NullOr(Schema.String),
});
export type Offered = typeof Offered.Type;

/** A model as a harness lists it, before what it runs at unset is resolved. */
export type ListedModel = Omit<Offered, "unsetEffort">;

/**
 * What a harness offers, from its own list or Collie's table, and what it runs on with no
 * model or effort set; why its own list could not be read, where it could not.
 */
export const Listed = Schema.Struct({
  from: Schema.Literals(["harness", "table"]),
  why: Schema.optionalKey(Schema.String),
  unset: Resolved,
  models: Schema.Array(Offered),
  /** The set model, where `models` lacks it. */
  typed: Schema.optionalKey(Offered),
});
export type Listed = typeof Listed.Type;

/** What a harness offers, or that its own list is still being read. */
export const Offer = Schema.Union([Schema.Struct({ from: Schema.Literal("reading") }), Listed]);
export type Offer = typeof Offer.Type;

/** What the chat module knows: the harness its conversation is held on, its warm session and turn. */
export const ChatHeld = Schema.Struct({
  heldOn: Schema.String,
  /** What the warm session was opened on; null while none is warm. */
  runsOn: Schema.NullOr(Resolved),
  /** A turn is under way, the human's or Desktop's own. */
  turning: Schema.Boolean,
});
export type ChatHeld = typeof ChatHeld.Type;

/** What every chat window is told of what the chat holds, runs on and could run on. */
export const ChatChoices = Schema.Struct({
  ...ChatHeld.fields,
  harnesses: Schema.Array(
    Schema.Struct({
      harness: Schema.String,
      label: Schema.String,
      installed: Schema.Boolean,
      offered: Offer,
    }),
  ),
});
export type ChatChoices = typeof ChatChoices.Type;

/** What of Pi's own `settings.json` decides what it runs with nothing set. */
export const PiConfig = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.String),
  defaultThinkingLevel: Schema.optionalKey(Schema.String),
  modelThinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type PiConfig = typeof PiConfig.Type;

/** The chat's harness, model and effort as set. */
export interface ChatSet {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

const tableEfforts = (harness: string) => HARNESS_MODELS[harness]?.efforts ?? [];

/** What an unset effort runs at when nothing else decides it. */
const UNSET_EFFORT = "medium";

/** The efforts `model` takes: its own where it is offered, else the table's for its harness. */
export const effortsOf = (harness: string, model: string, models: ReadonlyArray<Offered>) =>
  models.find(({ id }) => id === model)?.efforts ?? tableEfforts(harness);

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `level` where `takes` lists it, else the next above it, else the next below, as Pi clamps. */
const clamped = (level: string, takes: ReadonlyArray<string>) => {
  if (takes.includes(level)) return level;
  const at = LEVELS.indexOf(level);
  if (at < 0) return takes[0]!;
  return (
    LEVELS.slice(at).find((one) => takes.includes(one)) ??
    LEVELS.slice(0, at).findLast((one) => takes.includes(one)) ??
    takes[0]!
  );
};

/**
 * What the chat runs on: the set model and effort, an unset model as the harness's default
 * (Pi's configured one, else its own) and an unset effort at medium (on Pi, its configured
 * level for that model), clamped to the levels the model takes, and no effort on a model
 * that takes none.
 */
export const resolveChat = (
  set: ChatSet,
  models: ReadonlyArray<Offered>,
  pi: PiConfig,
): Resolved => {
  const { harness } = set;
  const onPi = harness === "pi";
  const model =
    set.model ??
    (onPi && pi.defaultProvider && pi.defaultModel
      ? `${pi.defaultProvider}/${pi.defaultModel}`
      : (HARNESS_MODELS[harness]?.defaultModel ?? DEFAULT_MODEL));
  const takes = effortsOf(harness, model, models);
  if (takes.length === 0) return { harness, model, effort: null };
  if (set.effort !== undefined) return { harness, model, effort: set.effort };
  const level = onPi ? (pi.modelThinkingLevels?.[model] ?? pi.defaultThinkingLevel) : undefined;
  return { harness, model, effort: clamped(level ?? UNSET_EFFORT, takes) };
};

/** Whether the chat may offer `id` on `harness`: not the harness's own default, nor one the check refuses. */
const offerable = (harness: string, extras: ReadonlyArray<string>) => (id: string) =>
  id !== DEFAULT_MODEL && resolveChoice([{ harness, model: id }], { [harness]: extras }).ok;

/** `listed` offered from `from`, and `setModel` where it lacks it, each with what it runs at unset. */
const offerOf = (
  from: Listed["from"],
  harness: string,
  listed: ReadonlyArray<ListedModel>,
  pi: PiConfig,
  setModel?: string,
): Listed => {
  const unresolved = listed.map((model) => ({ ...model, unsetEffort: null }));
  const offered = (model: ListedModel): Offered => ({
    ...model,
    unsetEffort: resolveChat({ harness, model: model.id }, unresolved, pi).effort,
  });
  const models = listed.map(offered);
  const offer: Listed = { from, unset: resolveChat({ harness }, models, pi), models };
  return setModel === undefined || listed.some(({ id }) => id === setModel)
    ? offer
    : {
        ...offer,
        typed: offered({
          id: setModel,
          label: setModel,
          efforts: effortsOf(harness, setModel, []),
        }),
      };
};

/**
 * What Collie's table offers on `harness`: its models, the Flock's extras and the set model,
 * each with the table's efforts and named by its id, but none the change check would refuse.
 */
export const tableOffer = (
  harness: string,
  setModel: string | undefined,
  extras: ReadonlyArray<string>,
  pi: PiConfig,
): Listed => {
  const ids = [
    ...new Set([
      ...(HARNESS_MODELS[harness]?.models ?? []),
      ...extras,
      ...(setModel === undefined ? [] : [setModel]),
    ]),
  ].filter(offerable(harness, extras));
  const listed = ids.map((id) => ({ id, label: id, efforts: tableEfforts(harness) }));
  return offerOf("table", harness, listed, pi, setModel);
};

/** What `harness`'s own list offers: every model it lists but those the change check would refuse. */
export const harnessOffer = (
  harness: string,
  listed: ReadonlyArray<ListedModel>,
  extras: ReadonlyArray<string>,
  pi: PiConfig,
  setModel?: string,
): Listed =>
  offerOf(
    "harness",
    harness,
    listed.filter(({ id }) => offerable(harness, extras)(id)),
    pi,
    setModel,
  );

/** What `set` runs as, by the account: each unset choice as its harness resolved it. */
export const runsAs = (set: ChatSet, choices: ChatChoices): Resolved => {
  const { harness } = set;
  const offer = listedOn(harness, choices);
  const models = offer?.models ?? [];
  const model = set.model ?? offer?.unset.model ?? DEFAULT_MODEL;
  if (effortsOf(harness, model, models).length === 0) return { harness, model, effort: null };
  const level =
    offer === undefined
      ? UNSET_EFFORT
      : set.model === undefined
        ? offer.unset.effort
        : ([...models, ...(offer.typed === undefined ? [] : [offer.typed])].find(
            ({ id }) => id === model,
          )?.unsetEffort ?? offer.unset.effort);
  return { harness, model, effort: set.effort ?? level ?? null };
};

/** What `harness` offers, unless its own list is still being read. */
const listedOn = (harness: string, choices: ChatChoices): Listed | undefined => {
  const offer = choices.harnesses.find((one) => one.harness === harness)?.offered;
  return offer?.from === "reading" ? undefined : offer;
};

/** The value of a select's `Default · …` entry, which unsets it. */
export const DEFAULT_ENTRY = "default";

export interface ChoiceOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  /** Why it cannot be chosen. */
  readonly disabled?: string;
}

export interface ChoiceSelect {
  readonly value: string;
  /** What its trigger reads. */
  readonly label: string;
  /** Its accessible name, carrying its value. */
  readonly name: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  /** The menu's last line. */
  readonly note: string | null;
  /** What the menu opens with, above its entries. */
  readonly warning: string | null;
  /** Its entries are still being read, which the note says. */
  readonly reading: boolean;
  /** Why it cannot be opened. */
  readonly disabled: string | null;
}

const EFFORT_LABELS = new Map([
  ["off", "Off"],
  ["minimal", "Minimal"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
]);
const effortLabel = (effort: string) => EFFORT_LABELS.get(effort) ?? effort;

/** The harness, model and effort selects, as the settings and the account have them. */
export const chatSelects = (settings: DesktopSettings, choices: ChatChoices) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  const offer = listedOn(harness, choices);
  const models = offer?.models ?? [];
  const unset = offer?.unset ?? { harness, model: DEFAULT_MODEL, effort: null };
  const harnessName = harnessLabel(harness);
  const named = (model: string) =>
    models.find(({ id }) => id === model)?.label ??
    (model === DEFAULT_MODEL ? `${harnessName}'s own default` : model);
  const select = (
    value: string | undefined,
    label: string,
    title: string,
    rest: Pick<ChoiceSelect, "options" | "note"> &
      Partial<Pick<ChoiceSelect, "warning" | "reading">>,
  ): ChoiceSelect => ({
    value: value ?? DEFAULT_ENTRY,
    label,
    name: `${title}: ${label}`,
    disabled: null,
    warning: null,
    reading: false,
    ...rest,
  });

  const unsetModel = `Default · ${named(unset.model)}`;
  const model = select(
    settings.chatModel,
    settings.chatModel === undefined ? unsetModel : named(settings.chatModel),
    "Model",
    {
      options: [
        {
          value: DEFAULT_ENTRY,
          label: unsetModel,
          description: "What the chat runs with no model set",
        },
        ...models.map(({ id, label, description, efforts }) => {
          const said = [description, efforts.length === 0 ? "takes no effort" : undefined]
            .filter((part): part is string => part !== undefined)
            .join(" · ");
          return said === "" ? { value: id, label } : { value: id, label, description: said };
        }),
        ...(settings.chatModel === undefined || models.some(({ id }) => id === settings.chatModel)
          ? []
          : [{ value: settings.chatModel, label: settings.chatModel }]),
      ],
      ...(offer === undefined
        ? {
            note: `Reading ${harnessName}'s models… You can still type a model id.`,
            reading: true,
          }
        : offer.from === "harness"
          ? { note: `Listed by ${harnessName} on this computer` }
          : offer.why === undefined
            ? { note: "Collie's table lists these, so each model is named by its id." }
            : {
                note: null,
                warning: `${harnessName}'s list could not be read: ${offer.why}. Showing Collie's table, so models are named by id.`,
              }),
    },
  );

  const runs = settings.chatModel ?? unset.model;
  const takes = effortsOf(harness, runs, models);
  const noEffort = `${named(runs)} takes no effort`;
  const unsetLevel = runsAs({ harness, model: settings.chatModel }, choices).effort;
  const unsetEffort = `Default · ${effortLabel(unsetLevel ?? "")}`;
  const effort: ChoiceSelect =
    takes.length === 0
      ? {
          value: DEFAULT_ENTRY,
          label: noEffort,
          name: `Effort: none. ${noEffort}`,
          options: [],
          note: null,
          warning: null,
          reading: false,
          disabled: noEffort,
        }
      : select(
          settings.chatEffort,
          settings.chatEffort === undefined ? unsetEffort : effortLabel(settings.chatEffort),
          "Effort",
          {
            options: [
              {
                value: DEFAULT_ENTRY,
                label: unsetEffort,
                description: "What the chat runs with no effort set",
              },
              ...takes.map((level) => ({ value: level, label: effortLabel(level) })),
            ],
            note: `The levels ${named(runs)} takes`,
          },
        );

  return {
    harness: select(harness, harnessLabel(harness), "Harness", {
      options: choices.harnesses.map(({ harness, label, installed }) =>
        installed
          ? { value: harness, label }
          : { value: harness, label, disabled: "not installed on this computer" },
      ),
      note: "Another harness starts a new conversation with your next message.",
    }),
    model,
    effort,
  };
};

/** The model menu's entry for an id typed into its search. */
export const typedModel = (id: string) => `Use ${id}`;

export const searched = (select: ChoiceSelect, search: string): ChoiceSelect["options"] => {
  const term = search.trim().toLowerCase();
  return select.options.filter(({ value, label }) =>
    [value, label].some((field) => field.toLowerCase().includes(term)),
  );
};

/** The id the model menu offers to use for `search`, unless it offers that id already. */
export const typedEntry = (select: ChoiceSelect, search: string): string | null => {
  const id = search.trim();
  return id === "" || select.options.some(({ value }) => value === id) ? null : id;
};

/** What choosing `value` in a select saves. */
export const chosen = (
  which: "harness" | "model" | "effort",
  value: string,
): DesktopSettingsChange => {
  if (which === "harness") return { chatHarness: value };
  const unset = value === DEFAULT_ENTRY ? "" : value;
  return which === "model" ? { chatModel: unset } : { chatEffort: unset };
};

/** What the message box says of a choice the change check refused. */
export const refusedChoice = (reason: string) =>
  `${reason}${reason.endsWith(".") ? "" : "."} Nothing was saved.`;

/** What the window says above the message box of what a choice will do. */
export type ChatNotice =
  | { readonly kind: "switch"; readonly said: string; readonly stay: string }
  | {
      readonly kind: "reply";
      readonly said: string;
      readonly finishes: string;
      readonly next: string;
    };

/** `resolved` by the labels its harness offers, as `Opus 5.5 · High`. */
const resolvedLabel = ({ harness, model, effort }: Resolved, choices: ChatChoices) => {
  const label = listedOn(harness, choices)?.models.find(({ id }) => id === model)?.label ?? model;
  return effort === null ? label : `${label} · ${effortLabel(effort)}`;
};

/**
 * A harness switch waiting for the next message, else, during a turn, a set choice that runs
 * as something other than the reply; null where the next message runs on what runs now.
 */
export const chatNotice = (settings: DesktopSettings, choices: ChatChoices): ChatNotice | null => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  if (harness !== choices.heldOn)
    return {
      kind: "switch",
      said: `Your next message starts a new conversation on ${harnessLabel(harness)}.`,
      stay: `Stay on ${harnessLabel(choices.heldOn)}`,
    };
  const { runsOn } = choices;
  if (!choices.turning || runsOn === null) return null;
  const next = runsAs({ harness, model: settings.chatModel, effort: settings.chatEffort }, choices);
  if (next.model === runsOn.model && next.effort === runsOn.effort) return null;
  const finishes = resolvedLabel(runsOn, choices);
  const nextLabel = resolvedLabel(next, choices);
  return {
    kind: "reply",
    said: `This reply finishes on ${finishes}. Your next message runs on ${nextLabel}.`,
    finishes,
    next: nextLabel,
  };
};

/** The choice Stay puts back: the settings while their harness is held, else the last seen while it was held. */
export const heldChoice = (
  previous: ChatSet | null,
  settings: DesktopSettings,
  heldOn: string,
): ChatSet | null => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  if (harness === heldOn)
    return { harness, model: settings.chatModel, effort: settings.chatEffort };
  return previous?.harness === heldOn ? previous : null;
};

/** What Stay saves: the held choice, unset where it was unset, or the held harness alone. */
export const stayChange = (held: ChatSet | null, heldOn: string): DesktopSettingsChange =>
  held === null
    ? { chatHarness: heldOn }
    : { chatHarness: held.harness, chatModel: held.model ?? "", chatEffort: held.effort ?? "" };
