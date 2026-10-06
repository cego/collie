// A web page opened in the human's default browser, where their sessions already are.

import { homedir } from "node:os";
import { Effect, FileSystem } from "effect";
import { output } from "./machine";

const CHROMIUM = /chrom|brave|(^|[.-])edge|vivaldi/i;
const FIELD_CODE = /^(%[a-zA-Z]|@@u?)$/;

/** The `[Desktop Entry]` group's own command, as the desktop entry spec quotes it. */
const commandOf = (entry: string) => {
  let group = "";
  for (const line of entry.split("\n").map((one) => one.trim()))
    if (line.startsWith("[")) group = line;
    else if (group === "[Desktop Entry]" && /^Exec\s*=/.test(line))
      return [...line.replace(/^Exec\s*=\s*/, "").matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)]
        .map(([, quoted, plain]) => quoted?.replace(/\\(.)/g, "$1") ?? plain ?? "")
        .filter((word) => !FIELD_CODE.test(word))
        .map((word) => word.replaceAll("%%", "%"));
  return [];
};

/** How a Chromium-based browser opens `url` in a window of its own; null for any other. */
export const appWindow = (id: string, entry: string, url: string) => {
  const command = commandOf(entry);
  return CHROMIUM.test(id) && command.length > 0 ? [...command, `--app=${url}`] : null;
};

const dataDirs = () => [
  Bun.env.XDG_DATA_HOME || `${homedir()}/.local/share`,
  ...(Bun.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
];

/** How the default browser opens `url` as an app window; null where it has no such window. */
export const appWindowFor = (url: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const id = (yield* output(["xdg-settings", "get", "default-web-browser"]).pipe(
      Effect.timeout("2 seconds"),
    )).trim();
    for (const dir of dataDirs()) {
      const entry = yield* fs.readFileString(`${dir}/applications/${id}`).pipe(Effect.option);
      if (entry._tag === "Some") return appWindow(id, entry.value, url);
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));
