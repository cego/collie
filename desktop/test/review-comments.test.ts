// Review comments: a Run's drafts, where each is about, and the one message they become.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { processFile } from "@pierre/diffs";
import {
  addDraft,
  clearSent,
  compose,
  diffAnchor,
  type DiffAnchor,
  type Draft,
  editDraft,
  inHunks,
  planAnchor,
  removeDraft,
} from "../src/shared/review-comments";

const plan = (id: string, file: string, quote: string, text: string): Draft => ({
  id,
  anchor: { _tag: "Plan", file, quote },
  text,
});

test("a selection that is empty or only whitespace is no anchor", () => {
  expect(planAnchor("SPEC.md", "")).toBeNull();
  expect(planAnchor("SPEC.md", " \n\t ")).toBeNull();
  expect(planAnchor("issues/01-a.md", "  the words  ")).toEqual({
    _tag: "Plan",
    file: "issues/01-a.md",
    quote: "  the words  ",
  });
});

test("drafts are added in order, edited and removed by id", () => {
  const one = plan("a", "SPEC.md", "x", "first");
  const two = plan("b", "SPEC.md", "y", "second");
  const drafts = addDraft(addDraft([], one), two);
  expect(Arr.map(drafts, (draft) => draft.id)).toEqual(["a", "b"]);
  expect(editDraft(drafts, "b", "sharper")[1]!.text).toBe("sharper");
  expect(removeDraft(drafts, "a")).toEqual([two]);
});

test("a send clears only the drafts it carried, as they were sent", () => {
  const drafts = [plan("a", "SPEC.md", "x", "1"), plan("b", "SPEC.md", "y", "2")];
  const meanwhile = plan("c", "SPEC.md", "z", "3");
  const edited = editDraft(drafts, "b", "2, sharper");
  expect(clearSent([...edited, meanwhile], drafts)).toEqual([edited[1]!, meanwhile]);
});

test("the message numbers each comment in the order written, with its place, quote and words", () => {
  const words = "Drop this.\n\n  Keep *that*, exactly as I typed it  ";
  expect(
    compose([
      plan("a", "SPEC.md", "The tab reads\nthe files again", "Is this true?"),
      plan("b", "issues/02-plan.md", "stamp", words),
    ]),
  ).toBe(
    Arr.join(
      [
        "2 review comments from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.",
        "",
        "1. the plan's `SPEC.md`",
        "> The tab reads",
        "> the files again",
        "",
        "Is this true?",
        "",
        "2. the plan's `issues/02-plan.md`",
        "> stamp",
        "",
        words,
        "",
        "Revise the plan and tickets where these comments call for changes. Preserve the Run's scope and constraints. Leave its next-choice menu unanswered.",
      ],
      "\n",
    ),
  );
});

test("a plan revision instruction preserves exact comments and does not select an implementation choice", () => {
  const words = "  Start with DEV only.\nDo not lose this whitespace.  ";
  const message = compose([plan("p", "SPEC.md", "STAGE", words)]);
  expect(message).toContain(words);
  expect(message).toContain("Revise the plan and tickets");
  expect(message).toContain("Leave its next-choice menu unanswered.");
});

test("one comment is said as one", () => {
  expect(Str.split(compose([plan("a", "SPEC.md", "q", "c")]), "\n")[0]).toBe(
    "1 review comment from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.",
  );
});

test("a long quote keeps its start and end, 300 characters in all", () => {
  const quote = `${pipe("a", Str.repeat(200))}${pipe("b", Str.repeat(200))}`;
  const said = Str.split(compose([plan("a", "SPEC.md", quote, "c")]), "\n")[3]!;
  expect(said).toBe(`> ${pipe("a", Str.repeat(150))}…${pipe("b", Str.repeat(149))}`);
  const short = pipe("c", Str.repeat(300));
  expect(Str.split(compose([plan("a", "SPEC.md", short, "c")]), "\n")[3]).toBe(`> ${short}`);
});

const changed = processFile(
  `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@
 one
-two
+TWO
 three
 four
@@ -20,3 +20,5 @@ fn
 twenty
+inserted
+again
 twentyone
 twentytwo
`,
  { isGitDiff: true },
)!;

const deleted = processFile(
  `diff --git a/old.txt b/old.txt
deleted file mode 100644
index 1111111..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
`,
  { isGitDiff: true },
)!;

test("a diff anchor quotes a line range on either side", () => {
  const ranges: ReadonlyArray<{
    range: Parameters<typeof diffAnchor>[1];
    anchor: Omit<DiffAnchor, "_tag" | "path">;
  }> = [
    {
      range: { start: 21, end: 21, side: "additions" },
      anchor: { side: "additions", first: 21, last: 21, lines: ["inserted"] },
    },
    {
      range: { start: 22, end: 20, side: "additions" },
      anchor: { side: "additions", first: 20, last: 22, lines: ["twenty", "inserted", "again"] },
    },
    {
      range: { start: 2, end: 2, side: "deletions" },
      anchor: { side: "deletions", first: 2, last: 2, lines: ["two"] },
    },
    {
      range: { start: 1, end: 3, side: "deletions", endSide: "deletions" },
      anchor: { side: "deletions", first: 1, last: 3, lines: ["one", "two", "three"] },
    },
  ];
  for (const { range, anchor } of ranges)
    expect(diffAnchor("src/a.ts", range, changed)).toEqual({
      _tag: "Diff",
      path: "src/a.ts",
      ...anchor,
    });
});

test("a range from one side to the other is only its first line, so no line is misquoted", () => {
  expect(
    diffAnchor("src/a.ts", { start: 2, end: 3, side: "deletions", endSide: "additions" }, changed),
  ).toEqual({
    _tag: "Diff",
    path: "src/a.ts",
    side: "deletions",
    first: 2,
    last: 2,
    lines: ["two"],
  });
});

test("a range with no side is on the file as it is", () => {
  expect(diffAnchor("src/a.ts", { start: 2, end: 2 }, changed)).toMatchObject({
    side: "additions",
    lines: ["TWO"],
  });
});

test("a line is in the hunks only where the patch shows it, on the side asked", () => {
  expect(inHunks(changed, 2, "additions")).toBe(true);
  expect(inHunks(changed, 24, "additions")).toBe(true);
  expect(inHunks(changed, 10, "additions")).toBe(false);
  expect(inHunks(changed, 25, "additions")).toBe(false);
  expect(inHunks(changed, 22, "deletions")).toBe(true);
  expect(inHunks(changed, 23, "deletions")).toBe(false);
  expect(inHunks(deleted, 2, "deletions")).toBe(true);
  expect(inHunks(deleted, 1, "additions")).toBe(false);
});

test("a diff draft is located by its path and lines, and by the side as it was for removed ones", () => {
  const diff = (id: string, range: Parameters<typeof diffAnchor>[1]): Draft => ({
    id,
    anchor: diffAnchor("src/a.ts", range, changed),
    text: id,
  });
  const said = compose([
    diff("one", { start: 21, end: 21, side: "additions" }),
    diff("many", { start: 20, end: 22, side: "additions" }),
    diff("was", { start: 1, end: 2, side: "deletions" }),
    diff("was-one", { start: 2, end: 2, side: "deletions" }),
  ]);
  expect(Arr.filter(Str.split(said, "\n"), (line) => /^\d+\. /.test(line))).toEqual([
    "1. `src/a.ts:21`",
    "2. `src/a.ts:20-22`",
    "3. `src/a.ts:1-2` (as it was)",
    "4. `src/a.ts:2` (as it was)",
  ]);
  expect(said).toContain("> twenty\n> inserted\n> again");
});
