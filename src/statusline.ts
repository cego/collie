// The line under the chat prompt: what the board has selected, so chat and board agree on
// what "it" means.
//
// Claude Code's `statusLine` is a command it runs and prints the output of, and it is
// configured in the human's own settings — which is why this is `setup.sh`'s step and
// never `prepare.sh`'s, exactly as the keybindings are. Two rules follow from it being
// their editor rather than Collie's: a status line somebody else put there is reported and
// left alone, and everything else in the file survives being written to.

import { Effect, FileSystem, Path, Schema } from "effect";
import { selfCommand, type PluginEnv } from "./env";
import { shellQuote } from "./naming";
import { isString } from "./schema";
import { promptLine, readSelection, selectionLine, selectionPath } from "./selection";
import { herdOf } from "./steering";
import { YamlMapSchema, isYamlMap } from "./yaml";

/** What the configured command ends in, which is also how Collie recognises its own. */
export const STATUS_LINE_ARGS = ["chat", "status-line"] as const;

// Indented, because this is a file the human opens and edits by hand.
const SettingsJson = Schema.fromJsonString(YamlMapSchema, { space: 2 });
const encode = Schema.encodeSync(SettingsJson);
const decode = Schema.decodeUnknownOption(SettingsJson);

export const claudeSettingsPath = Effect.fn("StatusLine.settingsPath")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  const dir = env.raw["CLAUDE_CONFIG_DIR"] ?? path.join(env.home, ".claude");
  return path.join(dir, "settings.json");
});

/**
 * What the settings ask Claude Code to run, pointed at this binary rather than at a name
 * on PATH: the line has to keep working in a pane whose PATH is not the installer's.
 */
export function statusLineCommand(self: ReadonlyArray<string> = selfCommand()): string {
  return [self.map(shellQuote).join(" "), ...STATUS_LINE_ARGS].join(" ");
}

/**
 * What Claude Code prints. Empty outside a Herd, because the setting is the human's own
 * and applies to every Claude Code they open: a session nowhere near a board must not
 * carry a line about one.
 */
export const statusLineFor = Effect.fn("StatusLine.for")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return "";
  return selectionLine(yield* readSelection(yield* selectionPath(env.stateDir, key)));
});

/**
 * What the chat's `UserPromptSubmit` hook prints: the selection, or nothing to attach.
 *
 * The one exception is the first prompt after a card closes, which says so: the previous
 * message still carries "this card is open", and an absence is easy for a model to miss
 * where a sentence is not. Remembered in one marker file beside the selection, so it is
 * said once and never again.
 */
export const promptLineFor = Effect.fn("StatusLine.prompt")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return "";
  const fs = yield* FileSystem.FileSystem;
  const file = yield* selectionPath(env.stateDir, key);
  const told = `${file}.told`;
  const on = yield* readSelection(file);
  if (on !== null) {
    yield* fs.writeFileString(told, "").pipe(Effect.ignore);
    return promptLine(on);
  }
  if (!(yield* fs.exists(told).pipe(Effect.catch(() => Effect.succeed(false))))) return "";
  yield* fs.remove(told, { force: true }).pipe(Effect.ignore);
  return "Board: no card open now; questions are about the whole Herd unless one is named.";
});

export type StatusLine =
  /** Collie's own, whatever path it names. */
  | { readonly kind: "ours"; readonly command: string }
  /** Somebody else's, which is theirs to keep. */
  | { readonly kind: "theirs"; readonly command: string }
  | { readonly kind: "none" };

const NONE: StatusLine = { kind: "none" };

/** What Claude Code is configured to print, read from the human's own settings. */
export const readStatusLine = Effect.fn("StatusLine.read")(function* (env: PluginEnv) {
  const settings = yield* readSettings(yield* claudeSettingsPath(env));
  const line = settings?.["statusLine"];
  if (!isYamlMap(line)) return NONE;
  const command = line["command"];
  if (!isString(command)) return NONE;
  return command.includes(STATUS_LINE_ARGS.join(" "))
    ? ({ kind: "ours", command } satisfies StatusLine)
    : ({ kind: "theirs", command } satisfies StatusLine);
});

/**
 * Configures it, or says why it did not. Re-runnable: the recorded command is refreshed
 * where it is Collie's, because the binary it points at moves when the installation does.
 */
export const installStatusLine = Effect.fn("StatusLine.install")(function* (env: PluginEnv) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* claudeSettingsPath(env);
  const found = yield* readStatusLine(env);
  const command = statusLineCommand();
  if (found.kind === "theirs")
    return `Claude Code already prints a status line of its own (${found.command}); Collie left it alone. To show the board's selection instead, set statusLine.command in ${file} to: ${command}`;
  if (found.kind === "ours" && found.command === command)
    return `Claude Code already prints the board's selection; ${file} is already configured.`;
  const settings = yield* readSettings(file);
  // Refused rather than replaced: these are the human's own Claude Code settings, and a
  // file half-edited by hand is one where writing a fresh document loses all of it.
  if (settings === null)
    return `Collie could not read ${file}, so it changed nothing. Fix the JSON, or set statusLine.command in it to: ${command}`;
  settings["statusLine"] = { type: "command", command, padding: 0 };
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encode(settings)}\n`);
  return `Claude Code now prints the board's selection as its status line (${file}).`;
});

/**
 * The whole settings document, an empty one where there is no file, and `null` for one
 * that is there and will not decode — three states, because only the third is a reason
 * not to write.
 */
const readSettings = Effect.fn("StatusLine.readSettings")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  if (raw.trim() === "") return {};
  const found = decode(raw);
  return found._tag === "Some" ? { ...found.value } : null;
});
