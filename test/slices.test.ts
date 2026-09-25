// A list of work, as both a declared `each:` and a written loop take one.
//
// Two rules and nothing else: an item is known by an identity that survives the list
// being reordered or edited, and what the items before it left is a few lines of fact.
// Both are here rather than in the engine because a module writing its own loop needs
// the same answers — and two readings of "which result is this item's" is one too many.

import { expect, test } from "bun:test";
import { identityProblem, renderProgress, type Handed } from "../src/slices";

const handed = (over: Partial<Handed>): Handed => ({
  item: "01-api.md",
  title: "Serve the thing",
  commits: ["Serve the thing"],
  verifications: ["test: pass"],
  ...over,
});

test("the first item is told it is the first, rather than shown an empty list", () => {
  expect(renderProgress([])).toBe("(this is the first ticket)");
});

test("what an item left behind is its commits and what was verified while it ran", () => {
  expect(renderProgress([handed({})])).toBe(
    "- 01-api.md — Serve the thing\n    Serve the thing\n    verified: test: pass",
  );
});

test("an item that committed nothing and verified nothing says so, rather than nothing", () => {
  expect(renderProgress([handed({ commits: [], verifications: [] })])).toBe(
    "- 01-api.md — Serve the thing\n    (no commit)\n    verified: nothing",
  );
});

test("the items are rendered in the order they were handed over", () => {
  const text = renderProgress([
    handed({ item: "01-api.md", title: "one" }),
    handed({ item: "02-ui.md", title: "two" }),
  ]);
  expect(text.indexOf("01-api.md")).toBeLessThan(text.indexOf("02-ui.md"));
});

test("distinct identities are what a list of work needs, and nothing more", () => {
  expect(identityProblem(["01-api.md", "02-ui.md"])).toBeNull();
});

test("the same identity twice is refused, because one result would answer for both", () => {
  expect(identityProblem(["01-api.md", "02-ui.md", "01-api.md"])).toBe(
    'two items of work are called "01-api.md", so one result would answer for both',
  );
});

test("an identity that is not a name of its own is refused before any work starts", () => {
  expect(identityProblem(["../escape"])).toBe(
    '"../escape" cannot identify work: it contains a path separator',
  );
  expect(identityProblem([""])).toBe('"" cannot identify work: it is empty');
});
