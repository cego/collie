// Agent-written markdown as styled terminal text: Comark parses and renders it to ANSI,
// and its SGR codes become OpenTUI chunks, because a <text> draws escapes literally.

import { renderAnsi } from "@comark/ansi";
import security from "comark/plugins/security";
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import { C } from "./sections";

const SANITISED = [security({ blockedTags: ["script", "style", "iframe", "object", "embed"] })];

/** SGR's black, red, green, yellow, blue, magenta, cyan and white, in the board's palette. */
const COLOURS = [C.dim, C.red, C.green, C.amber, C.blue, C.purple, C.blue, C.text].map((hex) =>
  RGBA.fromHex(hex),
);

/** How many arguments an extended colour code's mode (`5` or `2`) takes. */
const EXTENDED = new Map([
  [5, 1],
  [2, 3],
]);

const SETS = new Map([
  [1, TextAttributes.BOLD],
  [2, TextAttributes.DIM],
  [3, TextAttributes.ITALIC],
  [4, TextAttributes.UNDERLINE],
  [9, TextAttributes.STRIKETHROUGH],
]);

const CLEARS = new Map([
  [22, TextAttributes.BOLD | TextAttributes.DIM],
  [23, TextAttributes.ITALIC],
  [24, TextAttributes.UNDERLINE],
  [29, TextAttributes.STRIKETHROUGH],
]);

/**
 * ANSI text as chunks; a chunk with no colour takes the text's own.
 * ponytail: 256- and true-colour codes are skipped, so highlighted code stays uncoloured
 * until a plugin such as Shiki is added and they are mapped.
 */
export function ansiText(ansi: string): StyledText {
  const chunks: TextChunk[] = [];
  let fg: RGBA | undefined;
  let attributes = 0;
  for (const [index, part] of ansi.split(/\x1b\[([\d;]*)m/).entries()) {
    if (index % 2 === 0) {
      if (part !== "") chunks.push({ __isChunk: true, text: part, fg, attributes });
      continue;
    }
    const codes = part === "" ? [0] : part.split(";").map(Number);
    for (let at = 0; at < codes.length; at++) {
      const code = codes[at]!;
      if (code === 38 || code === 48) at += 1 + (EXTENDED.get(codes[at + 1]!) ?? 0);
      else if (code === 0) [fg, attributes] = [undefined, 0];
      else if (SETS.has(code)) attributes |= SETS.get(code)!;
      else if (CLEARS.has(code)) attributes &= ~CLEARS.get(code)!;
      else if (code === 39) fg = undefined;
      else if (code >= 30 && code <= 37) fg = COLOURS[code - 30]!;
      else if (code >= 90 && code <= 97) fg = COLOURS[code - 90]!;
    }
  }
  return new StyledText(chunks);
}

/** Markdown drawn `width` columns wide; `null` when Comark could not render it. */
export const styledMarkdown = (markdown: string, width: number): Promise<StyledText | null> =>
  renderAnsi(markdown, { plugins: SANITISED, width }).then(ansiText, () => null);
