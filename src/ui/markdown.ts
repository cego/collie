import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { renderAnsi } from "@comark/ansi";
import security from "comark/plugins/security";
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";
import { C } from "./sections";

const SANITISED = [security({ blockedTags: ["script", "style", "iframe", "object", "embed"] })];

const COLOURS = Arr.map([C.dim, C.red, C.green, C.amber, C.blue, C.purple, C.blue, C.text], (hex) =>
  RGBA.fromHex(hex),
);

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

export function ansiText(ansi: string) {
  const chunks: TextChunk[] = [];
  let fg: RGBA | undefined;
  let attributes = 0;
  // oxlint-disable-next-line no-control-regex -- ANSI SGR sequences begin with the ESC control byte.
  for (const [index, part] of Str.split(ansi, /\u001b\[([\d;]*)m/).entries()) {
    if (index % 2 === 0) {
      if (part !== "") chunks.push({ __isChunk: true, text: part, fg, attributes });
      continue;
    }
    const codes = part === "" ? [0] : Arr.map(Str.split(part, ";"), Number);
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

export const styledMarkdown = (markdown: string, width: number) =>
  renderAnsi(markdown, { plugins: SANITISED, width, colors: true }).then(ansiText, () => null);
