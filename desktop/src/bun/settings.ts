// What the human set in Desktop, kept on this computer beside the Flock chat's session.

import { Effect, FileSystem, Path, Schema } from "effect";
import { resolveChoice } from "../../../src/harness-choice";
import { isString } from "../../../src/schema";
import { DesktopSettings, type DesktopSettingsChange } from "../shared/flock";
import { CHAT_HARNESSES, DEFAULT_CHAT_HARNESS, type FlockSettings } from "../shared/flock-settings";

const SettingsFile = Schema.fromJsonString(DesktopSettings);
const FILE = "settings.json";

/** The saved settings, or the defaults where nothing is saved or it cannot be read. */
export const readSettings = Effect.fn("Settings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFile)),
    Effect.orElseSucceed(() => Schema.decodeUnknownSync(DesktopSettings)({})),
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
    Schema.encodeSync(SettingsFile)(settings),
  );
});

/** `change` over `settings`; another harness unsets a model chosen for the one before. */
export const applyChange = (
  settings: DesktopSettings,
  change: DesktopSettingsChange,
): DesktopSettings => {
  const { chatModel, ...rest } = { ...settings, ...change };
  const otherHarness =
    change.chatHarness !== undefined &&
    change.chatHarness !== (settings.chatHarness ?? DEFAULT_CHAT_HARNESS);
  const model = change.chatModel ?? (otherHarness ? undefined : chatModel);
  return model === undefined || model === "" ? rest : { ...rest, chatModel: model };
};

/** Extra models per harness, from the Flock's `models.<harness>`. */
export const extraModels = (flock: FlockSettings) =>
  Object.fromEntries(
    Object.entries(flock.settings).flatMap(([key, { value }]) =>
      key.startsWith("models.") && Array.isArray(value) && value.every(isString)
        ? [[key.slice("models.".length), value]]
        : [],
    ),
  );

/** The harness and model the Flock chat is set to, checked as a Run's are. */
export const chatChoice = (settings: DesktopSettings, flock: FlockSettings) => {
  const harness = settings.chatHarness ?? DEFAULT_CHAT_HARNESS;
  if (!CHAT_HARNESSES.includes(harness))
    return {
      ok: false as const,
      problem: `the Flock chat has no harness called "${harness}" (${CHAT_HARNESSES.join(", ")})`,
    };
  const resolved = resolveChoice([{ harness, model: settings.chatModel }], extraModels(flock));
  if (
    !resolved.ok &&
    harness === "pi" &&
    settings.chatModel !== undefined &&
    !settings.chatModel.includes("/")
  )
    return {
      ok: false as const,
      problem: `${resolved.problem}. Write provider/model, for example openai-codex/gpt-6.1-sol.`,
    };
  return resolved;
};

/** The settings `change` makes, or why it is refused; a change that leaves the chat alone is not checked. */
export const changeSettings = (
  settings: DesktopSettings,
  flock: FlockSettings,
  change: DesktopSettingsChange,
): DesktopSettings | { readonly refused: string } => {
  const changed = applyChange(settings, change);
  if (change.chatHarness === undefined && change.chatModel === undefined) return changed;
  const checked = chatChoice(changed, flock);
  return checked.ok ? changed : { refused: checked.problem };
};
