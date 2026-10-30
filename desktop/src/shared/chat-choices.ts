// Chat defaults and the account each window renders beside its message box.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { QueuedMessage } from "@tanstack/ai-client";
import { Option, Schema } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS } from "../../../src/harness-choice";
import { isString } from "../../../src/schema";
import { type Attached, attachedIn } from "./attachments";
import { About, harnessName } from "./chat-view";
import type { DesktopSettings, DesktopSettingsChange } from "./flock";
import { DEFAULT_CHAT_HARNESS } from "./flock-settings";

/** A harness, model and effort as a session is opened on them; `default` is the harness's own model. */
export const Resolved = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
});
export type Resolved = typeof Resolved.Type;

/** A model a harness offers, with the efforts it lists and the one an unset effort runs at. */
export const Offered = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  efforts: Schema.Array(Schema.String),
  unsetEffort: Schema.NullOr(Schema.String),
});
export type Offered = typeof Offered.Type;

/** What a harness offers, and what its unset model and effort run as. */
export const Offer = Schema.Struct({
  from: Schema.Literals(["harness", "table"]),
  why: Schema.optionalKey(Schema.String),
  unset: Resolved,
  /** The set model's defaults when it is absent from the harness list. */
  typed: Schema.optionalKey(Resolved),
  models: Schema.Array(Offered),
});
export type Offer = typeof Offer.Type;

/** The account of the chat every window is pushed. */
export const ChatChoices = Schema.Struct({
  /** The harness the current conversation is held on. */
  heldOn: Schema.String,
  /** What the warm session was opened on; null while none is warm. */
  runsOn: Schema.NullOr(Resolved),
  /** A turn is under way, the human's or Desktop's own. */
  turning: Schema.Boolean,
  harnesses: Schema.Array(
    Schema.Struct({
      harness: Schema.String,
      label: Schema.String,
      installed: Schema.Boolean,
      offered: Schema.Union([Schema.Struct({ from: Schema.Literal("reading") }), Offer]),
    }),
  ),
});
export type ChatChoices = typeof ChatChoices.Type;

/** Pi's model and effort defaults. */
export const PiConfig = Schema.Struct({
  defaultProvider: Schema.optionalKey(Schema.String),
  defaultModel: Schema.optionalKey(Schema.String),
  defaultThinkingLevel: Schema.optionalKey(Schema.String),
  modelThinkingLevels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export type PiConfig = typeof PiConfig.Type;

/** The chat's choice as set, each part unset where it is undefined. */
export interface SetChoice {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** The efforts `model` lists: its offered entry's, else the table's for its harness. */
export const effortsOf = (
  harness: string,
  model: string,
  offered: ReadonlyArray<Pick<Offered, "id" | "efforts">>,
): ReadonlyArray<string> =>
  Option.getOrUndefined(Arr.findFirst(offered, ({ id }) => id === model))?.efforts ??
  HARNESS_MODELS[harness]?.efforts ??
  [];

const unsetModel = (harness: string, pi: PiConfig) =>
  harness === "pi"
    ? pi.defaultProvider && pi.defaultModel
      ? `${pi.defaultProvider}/${pi.defaultModel}`
      : DEFAULT_MODEL
    : (HARNESS_MODELS[harness]?.defaultModel ?? DEFAULT_MODEL);

const piLevel = (configured: string, available: ReadonlyArray<string>): string | null => {
  if (available.includes(configured)) return configured;
  const order = HARNESS_MODELS.pi?.efforts ?? [];
  const at = order.indexOf(configured);
  if (at < 0) return available[0] ?? null;
  return (
    Option.getOrUndefined(Arr.findFirst(order.slice(at), (level) => available.includes(level))) ??
    Option.getOrUndefined(Arr.findLast(order.slice(0, at), (level) => available.includes(level))) ??
    available[0] ??
    null
  );
};

/** What a choice runs as: an unset model and effort as its harness, or Pi's configuration, has them. */
export const runsAs = (
  set: SetChoice,
  offered: ReadonlyArray<Pick<Offered, "id" | "efforts">>,
  pi: PiConfig,
): Resolved => {
  const model =
    set.model === undefined || set.model === DEFAULT_MODEL
      ? unsetModel(set.harness, pi)
      : set.model;
  const unsetEffort =
    set.harness === "pi"
      ? (pi.modelThinkingLevels?.[model] ?? pi.defaultThinkingLevel ?? "medium")
      : "medium";
  const efforts = effortsOf(set.harness, model, offered);
  return {
    harness: set.harness,
    model,
    effort:
      efforts.length === 0
        ? null
        : (set.effort ?? (set.harness === "pi" ? piLevel(unsetEffort, efforts) : unsetEffort)),
  };
};

/** What a set choice runs as, by the resolver's answers in what its harness offers. */
export const runsAsOffered = (set: SetChoice, offer: Offer): Resolved => {
  const model =
    set.model === undefined || set.model === DEFAULT_MODEL ? offer.unset.model : set.model;
  return {
    harness: set.harness,
    model,
    effort:
      effortsOf(set.harness, model, offer.models).length === 0
        ? null
        : (set.effort ??
          Option.getOrUndefined(Arr.findFirst(offer.models, ({ id }) => id === model))
            ?.unsetEffort ??
          (offer.typed?.model === model ? offer.typed.effort : undefined) ??
          offer.unset.effort ??
          "medium"),
  };
};

/** One entry of a select; a disabled one says why in its description. */
export interface ChoiceOption {
  /** Empty is the select's default, which unsets it. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: true;
}

/** A select beside the message box, as its trigger and menu show it. */
export interface ChoiceSelect {
  readonly value: string;
  /** The trigger's text. */
  readonly label: string;
  /** The trigger's accessible name, carrying its value. */
  readonly name: string;
  readonly options: ReadonlyArray<ChoiceOption>;
  /** The menu's last line; null where it has none. */
  readonly note: string | null;
  readonly reading?: true;
  readonly warning?: string;
  readonly disabled: boolean;
}

export const effortLabel = (effort: string) =>
  effort === "xhigh"
    ? "Extra high"
    : `${Str.toUpperCase(Option.getOrElse(Str.charAt(effort, 0), () => ""))}${pipe(effort, Str.slice(1))}`;

const select = (
  name: string,
  value: string,
  label: string,
  options: ReadonlyArray<ChoiceOption>,
  note: string | null,
): ChoiceSelect => ({ value, label, name: `${name}: ${label}`, options, note, disabled: false });

/** The harness, model and effort selects, as the settings and the chat's account have them. */
export const chatSelects = (settings: DesktopSettings, choices: ChatChoices | null) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  const entry = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(choices), (present) =>
      Option.getOrUndefined(Arr.findFirst(present.harnesses, (one) => one.harness === harness)),
    ),
  );
  const harnessSelect = select(
    "Harness",
    harness,
    entry?.label ?? harnessName(harness),
    Arr.map(choices?.harnesses ?? [], ({ harness, label, installed }) =>
      installed
        ? { value: harness, label }
        : {
            value: harness,
            label,
            description: "Not installed on this computer",
            disabled: true as const,
          },
    ),
    "Another harness starts a new conversation with your next message.",
  );
  const set = settings.chatModel;
  const effortSet = settings.chatEffort;
  if (entry === undefined || entry.offered.from === "reading")
    return {
      harness: harnessSelect,
      model: {
        ...select(
          "Model",
          set ?? "",
          set ?? "Default",
          [
            { value: "", label: "Default" },
            ...(set === undefined ? [] : [{ value: set, label: set }]),
          ],
          entry === undefined
            ? null
            : `Reading ${entry.label}'s models… You can still type a model id.`,
        ),
        ...(entry !== undefined && { reading: true as const }),
      },
      effort: select(
        "Effort",
        effortSet ?? "",
        effortSet === undefined ? "Default" : effortLabel(effortSet),
        [],
        null,
      ),
    };
  const offer = entry.offered;
  const modelLabel = (id: string) =>
    Option.getOrUndefined(Arr.findFirst(offer.models, (model) => model.id === id))?.label ??
    (id === DEFAULT_MODEL ? `${entry.label}'s own` : id);
  const unsetModel = `Default · ${modelLabel(offer.unset.model)}`;
  const model: ChoiceSelect = {
    ...select(
      "Model",
      set ?? "",
      set === undefined ? unsetModel : modelLabel(set),
      [
        { value: "", label: unsetModel, description: "What the chat runs with no model set" },
        ...Arr.map(offer.models, ({ id, label, description }) =>
          description === undefined ? { value: id, label } : { value: id, label, description },
        ),
        ...(set === undefined || Arr.some(offer.models, ({ id }) => id === set)
          ? []
          : [{ value: set, label: set }]),
      ],
      offer.from === "table"
        ? "Collie's table, so models are named by id"
        : `Listed by ${entry.label} on this computer`,
    ),
    ...(offer.from === "table" &&
      offer.why !== undefined && {
        warning: `${entry.label}'s list could not be read: ${pipe(offer.why, Str.replace(/\.$/, ""))}. Showing Collie's table, so models are named by id.`,
      }),
  };
  const runs = runsAsOffered({ harness, model: set }, offer);
  if (runs.effort === null) {
    const none = `${modelLabel(runs.model)} takes no effort`;
    return {
      harness: harnessSelect,
      model,
      effort: {
        value: "",
        label: none,
        name: `Effort: none. ${none}`,
        options: [],
        note: null,
        disabled: true,
      },
    };
  }
  const unsetEffort = `Default · ${effortLabel(runs.effort)}`;
  return {
    harness: harnessSelect,
    model,
    effort: select(
      "Effort",
      effortSet ?? "",
      effortSet === undefined ? unsetEffort : effortLabel(effortSet),
      [
        { value: "", label: unsetEffort, description: "What the chat runs with no effort set" },
        ...Arr.map(effortsOf(harness, runs.model, offer.models), (effort) => ({
          value: effort,
          label: effortLabel(effort),
        })),
      ],
      `The levels ${modelLabel(runs.model)} takes`,
    ),
  };
};

/** A typed id offered to save, where it is not already an option. */
export const typedEntry = (search: string, model: ChoiceSelect): ChoiceOption | null => {
  const id = Str.trim(search);
  return id === "" || Arr.some(model.options, ({ value }) => value === id)
    ? null
    : { value: id, label: `Use ${id}` };
};

export const modelMenu = (search: string, model: ChoiceSelect) => {
  const query = Str.trim(search);
  const [first, ...rest] = model.options;
  const typed = typedEntry(query, model);
  const groups: Array<Array<ChoiceOption & { readonly typed?: string }>> = [
    ...(first === undefined ? [] : [[first]]),
    rest,
    ...(typed === null ? [] : [[{ ...typed, typed: typed.value }]]),
  ];
  return {
    query,
    groups,
  };
};

/** A refused choice, as the alert above the message box says it. */
export const refusalSaid = (reason: string) =>
  `${pipe(reason, Str.replace(/\.$/, ""))}. Nothing was saved.`;

const setChoice = (settings: DesktopSettings): SetChoice => ({
  harness: settings.chatHarness ?? DEFAULT_CHAT_HARNESS,
  model: settings.chatModel,
  effort: settings.chatEffort,
});

/** The last choice this window saw set on the conversation's harness. */
export const rememberChoice = (
  remembered: SetChoice | null,
  settings: DesktopSettings,
  choices: ChatChoices | null,
): SetChoice | null => {
  if (choices === null) return remembered;
  const set = setChoice(settings);
  return set.harness === choices.heldOn
    ? set
    : remembered?.harness === choices.heldOn
      ? remembered
      : null;
};

/** The ordinary settings change Stay sends through the choice check. */
export const stayOn = (
  choices: ChatChoices,
  remembered: SetChoice | null,
): DesktopSettingsChange => ({
  chatHarness: choices.heldOn,
  ...(remembered?.harness === choices.heldOn && {
    chatModel: remembered.model ?? "",
    chatEffort: remembered.effort ?? "",
  }),
});

const resolvedLabel = (runs: Resolved, choices: ChatChoices) => {
  const entry = Option.getOrUndefined(
    Arr.findFirst(choices.harnesses, ({ harness }) => harness === runs.harness),
  );
  const offer = entry?.offered;
  const fallback =
    runs.model === DEFAULT_MODEL
      ? `${entry?.label ?? harnessName(runs.harness)}'s own`
      : runs.model;
  const model =
    offer === undefined || offer.from === "reading"
      ? fallback
      : (Option.getOrUndefined(Arr.findFirst(offer.models, ({ id }) => id === runs.model))?.label ??
        fallback);
  return runs.effort === null ? model : `${model} · ${effortLabel(runs.effort)}`;
};

/** What a choice will do before the next message. */
export const choiceNotices = (settings: DesktopSettings, choices: ChatChoices | null) => {
  const set = setChoice(settings);
  const waiting =
    choices === null || set.harness === choices.heldOn
      ? null
      : {
          text: `Your next message starts a new conversation on ${harnessName(set.harness)}.`,
          stayLabel: `Stay on ${harnessName(choices.heldOn)}`,
        };
  const offer = Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(choices), (present_) =>
      Option.map(
        Option.fromNullishOr(
          Option.getOrUndefined(
            Arr.findFirst(present_.harnesses, ({ harness }) => harness === set.harness),
          ),
        ),
        (present__) => present__.offered,
      ),
    ),
  );
  if (
    !choices?.turning ||
    choices.runsOn === null ||
    offer === undefined ||
    offer.from === "reading"
  )
    return { waiting, reply: null };
  const next = runsAsOffered(set, offer);
  const runs = choices.runsOn;
  if (runs.harness === next.harness && runs.model === next.model && runs.effort === next.effort)
    return { waiting, reply: null };
  const current = resolvedLabel(runs, choices);
  const label = resolvedLabel(next, choices);
  return {
    waiting,
    reply: {
      current,
      next: label,
      text: `This reply finishes on ${current}. Your next message runs on ${label}.`,
    },
  };
};

/** Errors leave Send available; only the human's active reply offers Stop. */
export const replyButton = (status: string, desktopSpeaking = false) =>
  !desktopSpeaking && (status === "submitted" || status === "streaming")
    ? { status, name: "Stop the reply" }
    : { status: "ready" as const, name: "Send" };

export interface ChatStatus {
  readonly replying: boolean;
  readonly notices: ReadonlyArray<string>;
}

/** A status change spoken once, without a completion message over the finished reply. */
export const chatAnnouncement = (before: ChatStatus | null, after: ChatStatus, stopped = false) =>
  Arr.join(
    [
      ...(stopped ? ["Reply stopped"] : after.replying && !before?.replying ? ["Replying…"] : []),
      ...Arr.filter(after.notices, (notice) => !before?.notices.includes(notice)),
    ],
    " ",
  );

export interface ChatDraft {
  readonly text: string;
  readonly files: ReadonlyArray<Attached>;
  readonly about: About | null;
}

const decodeAbout = Schema.decodeUnknownOption(About);

/** What Stop recovers before the chat client discards its queue. */
export const stopDraft = (
  queue: ReadonlyArray<Pick<QueuedMessage, "content">>,
  draft: ChatDraft,
): ChatDraft => {
  const words: string[] = [];
  const files: Attached[] = [];
  let about = draft.about;
  for (const { content } of queue) {
    const said = isString(content) ? content : content.content;
    const text = isString(said)
      ? said
      : Arr.join(
          Arr.flatMap(said, (part) => (part.type === "text" ? [part.content] : [])),
          "\n",
        );
    if (text !== "") words.push(text);
    if (!isString(said))
      files.push(...Arr.flatMap(said, (part) => Option.toArray(attachedIn(part))));
    if (about === null && !isString(content))
      about = Option.getOrNull(decodeAbout(content.metadata?.about));
  }
  if (draft.text !== "") words.push(draft.text);
  const seen = new Set<string>();
  return {
    text: Arr.join(words, "\n\n"),
    files: Arr.filter([...files, ...draft.files], ({ id }) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
    about,
  };
};
