// A web page opened in the human's default browser, where their sessions already are.

import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { homedir } from "node:os";
import { Effect, FileSystem } from "effect";
import { output } from "./machine";

const CHROMIUM = /chrom|brave|(^|[.-])edge|vivaldi/i;
const FIELD_CODE = /^(%[a-zA-Z]|@@u?)$/;

/** The `[Desktop Entry]` group's own command, as the desktop entry spec quotes it. */
const commandOf = (entry: string) => {
  let group = "";
  for (const line of Arr.map(Str.split(entry, "\n"), (one) => Str.trim(one)))
    if (pipe_(line, Str.startsWith("["))) group = line;
    else if (group === "[Desktop Entry]" && /^Exec\s*=/.test(line))
      return Arr.map(
        Arr.filter(
          Arr.map(
            [
              ...pipe_(
                line,
                Str.replace(/^Exec\s*=\s*/, ""),
                Str.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g),
              ),
            ],
            ([, quoted, plain]) =>
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(quoted), (present) =>
                  pipe_(present, Str.replace(/\\(.)/g, "$1")),
                ),
              ) ??
              plain ??
              "",
          ),
          (word) => !FIELD_CODE.test(word),
        ),
        (word) => pipe_(word, Str.replaceAll("%%", "%")),
      );
  return [];
};

/** How a Chromium-based browser opens `url` in a window of its own; null for any other. */
export const appWindow = (id: string, entry: string, url: string) => {
  const command = commandOf(entry);
  return CHROMIUM.test(id) && command.length > 0 ? [...command, `--app=${url}`] : null;
};

const dataDirs = () => [
  Bun.env.XDG_DATA_HOME || `${homedir()}/.local/share`,
  ...Str.split(Bun.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share", ":"),
];

/** How the default browser opens `url` as an app window; null where it has no such window. */
export const appWindowFor = (url: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const id = Str.trim(
      yield* output(["xdg-settings", "get", "default-web-browser"]).pipe(
        Effect.timeout("2 seconds"),
      ),
    );
    for (const dir of dataDirs()) {
      const entry = yield* fs.readFileString(`${dir}/applications/${id}`).pipe(Effect.option);
      if (entry._tag === "Some") return appWindow(id, entry.value, url);
    }
    return null;
  }).pipe(Effect.orElseSucceed(() => null));
