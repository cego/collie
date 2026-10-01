// Comark's ANSI output as the drawer's chunks: styles, colours and what the agent wrote.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { RGBA, TextAttributes } from "@opentui/core";
import { runEffect } from "../support/effect";
import { ansiText, styledMarkdown } from "../../src/ui/markdown";
import { C } from "../../src/ui/sections";

const RED = RGBA.fromHex(C.red);

test("SGR codes become attributes and the board's colours, and a reset clears both", () => {
  const chunks = ansiText(
    "\x1b[1;31mbad\x1b[22mstill red\x1b[0mplain\x1b[38;2;1;3;4mrgb\x1b[39m",
  ).chunks;
  expect(chunks.map((c) => [c.text, c.attributes, c.fg])).toEqual([
    ["bad", TextAttributes.BOLD, RED],
    ["still red", 0, RED],
    ["plain", 0, undefined],
    // A true-colour code's components are its arguments, never styles of their own.
    ["rgb", 0, undefined],
  ]);
});

test("an escape the agent wrote is text, never a style", () =>
  runEffect(
    Effect.gen(function* () {
      const styled = yield* Effect.promise(() => styledMarkdown("\x1b[1mloud", 40));
      const chunks = styled?.chunks ?? [];
      expect(chunks.some((c) => c.text.includes("\x1b"))).toBe(false);
      expect(chunks.some((c) => (c.attributes ?? 0) & TextAttributes.BOLD)).toBe(false);
    }),
  ));
