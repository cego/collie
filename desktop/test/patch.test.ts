// A file's patch as the record draws it: hunks of numbered lines, paired for side by side.

import { expect, test } from "bun:test";
import { parsePatch, sideBySide, sides } from "../src/shared/patch";

const PATCH = [
  "diff --git a/src/seed.ts b/src/seed.ts",
  "index 1111111..2222222 100644",
  "--- a/src/seed.ts",
  "+++ b/src/seed.ts",
  "@@ -1,4 +1,5 @@ export const seed",
  " /* every brand,",
  "-   once */",
  "+   once,",
  "+   and again */",
  " const a = 1;",
  "-const b = 2;",
  "\\ No newline at end of file",
  "@@ -10,2 +11,2 @@",
  " const x = 1;",
  "+const y = 2;",
  "",
].join("\n");

test("a patch is its hunks, each line numbered on the side it is on", () => {
  const hunks = parsePatch(PATCH);
  expect(hunks.map((hunk) => hunk.header)).toEqual([
    "@@ -1,4 +1,5 @@ export const seed",
    "@@ -10,2 +11,2 @@",
  ]);
  expect(hunks[0]!.lines).toEqual([
    { kind: "context", old: 1, new: 1, text: "/* every brand," },
    { kind: "del", old: 2, new: null, text: "   once */" },
    { kind: "add", old: null, new: 2, text: "   once," },
    { kind: "add", old: null, new: 3, text: "   and again */" },
    { kind: "context", old: 3, new: 4, text: "const a = 1;" },
    { kind: "del", old: 4, new: null, text: "const b = 2;" },
  ]);
  expect(hunks[1]!.lines).toEqual([
    { kind: "context", old: 10, new: 11, text: "const x = 1;" },
    { kind: "add", old: null, new: 12, text: "const y = 2;" },
  ]);
});

test("a binary file's patch has no hunks", () => {
  expect(
    parsePatch("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n"),
  ).toEqual([]);
});

test("side by side, a removal sits beside the addition that replaced it", () => {
  const [hunk] = parsePatch(PATCH);
  const rows = sideBySide(hunk!).map(({ left, right }) => [
    left?.text ?? null,
    right?.text ?? null,
  ]);
  expect(rows).toEqual([
    ["/* every brand,", "/* every brand,"],
    ["   once */", "   once,"],
    [null, "   and again */"],
    ["const a = 1;", "const a = 1;"],
    ["const b = 2;", null],
  ]);
});

test("each side is the file as it was and as it is, so a comment highlights across its lines", () => {
  const { old, new: now } = sides(parsePatch(PATCH));
  expect(old.map((line) => line.text)).toEqual([
    "/* every brand,",
    "   once */",
    "const a = 1;",
    "const b = 2;",
    "const x = 1;",
  ]);
  expect(now.map((line) => line.text)).toEqual([
    "/* every brand,",
    "   once,",
    "   and again */",
    "const a = 1;",
    "const x = 1;",
    "const y = 2;",
  ]);
});
