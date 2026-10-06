// Lines of one file highlighted together with Shiki, so a construct spanning lines, such
// as a block comment, is coloured on every line it covers.

import { type BundledLanguage, bundledLanguages, codeToTokens } from "shiki";

export interface Token {
  readonly content: string;
  readonly style: Record<string, string>;
}

const isLanguage = (name: string): name is BundledLanguage => name in bundledLanguages;

/** Shiki's language for a file, by its extension, or by its whole name (`Dockerfile`). */
const languageOf = (path: string): BundledLanguage | "text" => {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const ext = name.split(".").at(-1) ?? name;
  return isLanguage(ext) ? ext : "text";
};

/** Each line's tokens, in the colours of the light and the dark theme. */
export const highlightLines = (
  lines: ReadonlyArray<string>,
  path: string,
): Promise<ReadonlyArray<ReadonlyArray<Token>>> =>
  codeToTokens(lines.join("\n"), {
    lang: languageOf(path),
    themes: { light: "github-light", dark: "github-dark" },
  }).then(({ tokens }) =>
    tokens.map((line) =>
      line.map((token) => ({ content: token.content, style: token.htmlStyle ?? {} })),
    ),
  );
