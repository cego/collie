// ADR-draft-a-forge-is-asked-over-http-with-its-clis-login D1: only `src/forge/` imports `forges`.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
const IMPORTS = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']forges(?:\/[^"']*)?["']/;

/** Each file, by its text, that imports `forges` outside the forge directory. */
export const forgesImportsIn = (files: ReadonlyMap<string, string>) =>
  Arr.map(
    Arr.filter(
      [...files],
      ([file, text]) => !pipe(file, Str.startsWith("src/forge/")) && IMPORTS.test(text),
    ),
    ([file]) => `${file} imports forges`,
  );
