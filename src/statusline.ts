import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Path, Result, Schema, flow } from "effect";
import { CommandLine } from "effect/process";
import { selfCommand, type PluginEnv } from "./env";
import { isString } from "./schema";
import { promptLine, readSelection, selectionLine, selectionPath } from "./selection";
import { machineHerd } from "./steering";
import { standingDirectionOn } from "./config";
import { standingDirectionContext } from "./standing-direction";
import { YamlMapSchema, isYamlMap } from "./yaml";

export const STATUS_LINE_ARGS = ["chat", "status-line"] as const;

const SettingsJson = Schema.fromJsonString(YamlMapSchema, { space: 2 });
const encode = flow(Schema.encodeResult(SettingsJson), Result.getOrThrow);
const decode = Schema.decodeUnknownOption(SettingsJson);

export const claudeSettingsPath = Effect.fn("StatusLine.settingsPath")(function* (env: PluginEnv) {
  const path = yield* Path.Path;
  const dir = env.raw["CLAUDE_CONFIG_DIR"] ?? path.join(env.home, ".claude");
  return path.join(dir, "settings.json");
});

// WARNING: points at this binary, not a PATH name: a pane's PATH is not the installer's.
export function statusLineCommand(self: ReadonlyArray<string> = selfCommand()) {
  return Result.getOrThrow(CommandLine.join([...self, ...STATUS_LINE_ARGS]));
}

export const statusLineFor = Effect.fn("StatusLine.for")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return "";
  return selectionLine(yield* readSelection(yield* selectionPath(env.stateDir, key)));
});

export const promptLineFor = Effect.fn("StatusLine.prompt")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return "";
  const fs = yield* FileSystem.FileSystem;
  const file = yield* selectionPath(env.stateDir, key);
  const told = `${file}.told`;
  const on = yield* readSelection(file);
  if (on !== null) {
    yield* fs.writeFileString(told, "").pipe(Effect.ignore);
    return promptLine(on);
  }
  if (!(yield* fs.exists(told).pipe(Effect.orElseSucceed(() => false)))) return "";
  yield* fs.remove(told, { force: true }).pipe(Effect.ignore);
  return "Board: no card open now; questions are about the whole Herd unless one is named.";
});

export const chatContextFor = Effect.fn("StatusLine.chatContext")(function* (env: PluginEnv) {
  const standing = yield* standingDirectionOn(env.userDir).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return Arr.join(
    Arr.filter(
      [standingDirectionContext(standing) ?? "", yield* promptLineFor(env)],
      (part) => part !== "",
    ),
    "\n\n",
  );
});

export type StatusLine =
  | { readonly kind: "ours"; readonly command: string }
  | { readonly kind: "theirs"; readonly command: string }
  | { readonly kind: "none" };

const NONE: StatusLine = { kind: "none" };

export const readStatusLine = Effect.fn("StatusLine.read")(function* (env: PluginEnv) {
  const settings = yield* readSettings(yield* claudeSettingsPath(env));
  const line = settings?.["statusLine"];
  if (!isYamlMap(line)) return NONE;
  const command = line["command"];
  if (!isString(command)) return NONE;
  return command.includes(Arr.join(STATUS_LINE_ARGS, " "))
    ? ({ kind: "ours", command } satisfies StatusLine)
    : ({ kind: "theirs", command } satisfies StatusLine);
});

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
  // WARNING: refused rather than replaced: a file half-edited by hand loses all of it when rewritten.
  if (settings === null)
    return `Collie could not read ${file}, so it changed nothing. Fix the JSON, or set statusLine.command in it to: ${command}`;
  settings["statusLine"] = { type: "command", command, padding: 0 };
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encode(settings)}\n`);
  return `Claude Code now prints the board's selection as its status line (${file}).`;
});

const readSettings = Effect.fn("StatusLine.readSettings")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  if (Str.trim(raw) === "") return {};
  const found = decode(raw);
  return found._tag === "Some" ? { ...found.value } : null;
});
