import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
const IMPORTS = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']forges(?:\/[^"']*)?["']/;

export const forgesImportsIn = (files: ReadonlyMap<string, string>) =>
  Arr.map(
    Arr.filter(
      [...files],
      ([file, text]) => !pipe(file, Str.startsWith("src/forge/")) && IMPORTS.test(text),
    ),
    ([file]) => `${file} imports forges`,
  );
