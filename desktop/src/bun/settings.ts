// What the human set in Desktop, kept on this computer beside the Flock chat's session.

import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema, Semaphore, SubscriptionRef, flow, Result } from "effect";
import { DEFAULT_MODEL, HARNESS_MODELS, resolveChoice } from "../../../src/harness-choice";
import { isString } from "../../../src/schema";
import { effortsOf, type Offer } from "../shared/chat-choices";
import { ActionFailed, DesktopSettings, type DesktopSettingsChange } from "../shared/flock";
import {
  CHAT_HARNESSES,
  DEFAULT_CHAT_HARNESS,
  editSetting,
  type FlockSettings,
} from "../shared/flock-settings";
import { readFlockSettings, writeFlockSettings } from "./flock-settings";

const SettingsFile = Schema.fromJsonString(DesktopSettings);
const FILE = "settings.json";

/** The saved settings, or the defaults where nothing is saved or it cannot be read. */
export const readSettings = Effect.fn("Settings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFile)),
    Effect.orElseSucceed(() => flow(Schema.decodeResult(DesktopSettings), Result.getOrThrow)({})),
  );
});

export const writeSettings = Effect.fn("Settings.write")(function* (
  dir: string,
  settings: DesktopSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, FILE),
    yield* Schema.encodeEffect(SettingsFile)(settings).pipe(Effect.orDie),
  );
});

/**
 * Carries the Machine rule and a quiet Flock chat an earlier Desktop kept as its own into the
 * Flock's settings, as Desktop's edits at `now`, then drops Desktop's copy so it happens once.
 */
export const carryIntoFlock = Effect.fn("Settings.carryIntoFlock")(function* (
  dir: string,
  now: string,
) {
  const { proactive, machineRule, ...own } = yield* readSettings(dir);
  const flock = yield* readFlockSettings(dir);
  if (proactive === undefined && machineRule === undefined) return flock;
  const carried = Arr.reduce(
    [
      ["machine_rule", machineRule ?? ""],
      ["flock_chat.proactive", proactive === false ? "false" : ""],
    ] as const,
    flock,
    (held, [key, typed]) => {
      if (typed === "" || held.settings[key] !== undefined) return held;
      const edited = editSetting(held, key, typed, now);
      return "refused" in edited ? held : edited;
    },
  );
  yield* writeFlockSettings(dir, carried);
  yield* writeSettings(dir, own);
  return carried;
});

/** What each harness offers, by harness. */
export type Offers = Readonly<Record<string, Offer>>;

const modelOf = (settings: DesktopSettings, offers: Offers) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  const offer = offers[harness];
  const id =
    settings.chatModel === DEFAULT_MODEL
      ? offer?.unset.model
      : (settings.chatModel ?? offer?.unset.model);
  return {
    label:
      Option.getOrUndefined(
        Option.flatMap(Option.fromNullishOr(offer), (present) =>
          Option.map(
            Option.fromNullishOr(
              Option.getOrUndefined(Arr.findFirst(present.models, (model) => model.id === id)),
            ),
            (present_) => present_.label,
          ),
        ),
      ) ??
      id ??
      harness,
    efforts:
      id === undefined
        ? (HARNESS_MODELS[harness]?.efforts ?? [])
        : effortsOf(harness, id, offer?.models ?? []),
  };
};

/**
 * `change` over `settings`. Another harness unsets a model and an effort chosen for the one
 * before; another model keeps the effort only where it lists it.
 */
export const applyChange = (
  settings: DesktopSettings,
  change: DesktopSettingsChange,
  offers: Offers = {},
): DesktopSettings => {
  const { chatModel, chatEffort, chatWidth, ...rest } = { ...settings, ...change };
  const otherHarness =
    change.chatHarness !== undefined &&
    change.chatHarness !== (settings.chatHarness ?? DEFAULT_CHAT_HARNESS);
  const kept = (changed: string | undefined, held: string | undefined) => {
    const value = changed ?? (otherHarness ? undefined : held);
    return value === "" ? undefined : value;
  };
  const model = kept(change.chatModel, chatModel);
  const effort = kept(change.chatEffort, chatEffort);
  const dropsEffort =
    !otherHarness &&
    change.chatModel !== undefined &&
    change.chatEffort === undefined &&
    effort !== undefined &&
    !modelOf(
      { ...rest, ...(model !== undefined && { chatModel: model }) },
      offers,
    ).efforts.includes(effort);
  return {
    ...rest,
    ...(model !== undefined && { chatModel: model }),
    ...(effort !== undefined && !dropsEffort && { chatEffort: effort }),
    ...(chatWidth != null && { chatWidth }),
  };
};

/** Extra models per harness, from the Flock's `models.<harness>`. */
export const extraModels = (flock: FlockSettings) =>
  Rec.fromEntries(
    Arr.flatMap(Rec.toEntries(flock.settings), ([key, { value }]) =>
      pipe_(key, Str.startsWith("models.")) && Arr.isArray(value) && Arr.every(value, isString)
        ? [[pipe_(key, Str.slice("models.".length)), value]]
        : [],
    ),
  );

/** The harness, model and effort the Flock chat is set to, checked as a Run's are. */
export const chatChoice = (
  settings: DesktopSettings,
  flock: FlockSettings,
  offers: Offers = {},
) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  if (!CHAT_HARNESSES.includes(harness))
    return {
      ok: false as const,
      problem: `the Flock chat has no harness called "${harness}" (${Arr.join(CHAT_HARNESSES, ", ")})`,
    };
  const resolved = resolveChoice(
    [
      {
        harness,
        model:
          settings.chatModel === undefined || settings.chatModel === DEFAULT_MODEL
            ? offers[harness]?.unset.model
            : settings.chatModel,
        effort: settings.chatEffort,
      },
    ],
    extraModels(flock),
    offers[harness] === undefined
      ? undefined
      : {
          machine: "this computer",
          harnesses: Arr.map(Rec.toEntries(offers), ([harness, offer]) => ({
            harness,
            table: offer.from === "harness" ? null : (offer.why ?? "the harness has not been read"),
            entries: Arr.map(offer.models, ({ id, efforts }) => ({ model: id, efforts })),
          })),
        },
  );
  if (
    !resolved.ok &&
    harness === "pi" &&
    settings.chatModel !== undefined &&
    !pipe_(settings.chatModel, Str.includes("/"))
  )
    return {
      ok: false as const,
      problem: `${resolved.problem}. Write provider/model, for example openai-codex/gpt-6.1-sol.`,
    };
  return resolved;
};

/**
 * The settings `change` makes, or why it is refused; a change that leaves the chat alone is
 * not checked. An effort is checked against the efforts its model lists in `offers`.
 */
export const changeSettings = (
  settings: DesktopSettings,
  flock: FlockSettings,
  change: DesktopSettingsChange,
  offers: Offers = {},
): DesktopSettings | { readonly refused: string } => {
  const changed = applyChange(settings, change, offers);
  if (
    change.chatHarness === undefined &&
    change.chatModel === undefined &&
    change.chatEffort === undefined
  )
    return changed;
  const checked = chatChoice(changed, flock, offers);
  return checked.ok ? changed : { refused: checked.problem };
};

/** Desktop's settings, saved one change at a time through the check and told to whoever follows them. */
export const heldSettings = Effect.fn("Settings.held")(function* (
  dir: string,
  flock: () => FlockSettings,
  offers: (
    settings: DesktopSettings,
  ) => Effect.Effect<Offers, never, FileSystem.FileSystem | Path.Path> = () => Effect.succeed({}),
) {
  const held = yield* SubscriptionRef.make(yield* readSettings(dir));
  const writing = yield* Semaphore.make(1);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  return {
    now: () => SubscriptionRef.getUnsafe(held),
    /** The settings now, then each saved change. */
    changes: SubscriptionRef.changes(held),
    /** What was saved, or why the change was refused and nothing kept. */
    save: (change: DesktopSettingsChange) =>
      Effect.gen(function* () {
        const now = SubscriptionRef.getUnsafe(held);
        const changed = changeSettings(now, flock(), change, yield* offers(now));
        if ("refused" in changed) return yield* new ActionFailed({ reason: changed.refused });
        yield* writeSettings(dir, changed).pipe(
          Effect.mapError((error) => new ActionFailed({ reason: error.message })),
        );
        yield* SubscriptionRef.set(held, changed);
        return changed;
      }).pipe(writing.withPermits(1), Effect.provideContext(services)),
  };
});
