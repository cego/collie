// ADR-draft-a-forge-is-asked-over-http-with-its-clis-login D1: only `src/forge/` imports `forges`.

const IMPORTS = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']forges(?:\/[^"']*)?["']/;

/** Each file, by its text, that imports `forges` outside the forge directory. */
export const forgesImportsIn = (files: ReadonlyMap<string, string>) =>
  [...files]
    .filter(([file, text]) => !file.startsWith("src/forge/") && IMPORTS.test(text))
    .map(([file]) => `${file} imports forges`);
