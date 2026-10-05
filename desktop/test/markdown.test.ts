// What the drawer's markdown keeps of what an agent wrote: no styling, and `file:line` as a jump.

import { expect, test } from "bun:test";
import type { Node } from "comark";
import { confined } from "../src/shared/markdown";

const confine = (nodes: Array<Node>) => {
  const tree = { nodes, frontmatter: {}, meta: {} };
  void confined().post?.({ markdown: "", tree, options: {}, tokens: [] });
  return tree.nodes;
};

test("no element keeps a style of its own", () => {
  expect(confine([["div", { style: "position:fixed" }, ["span", { style: "a" }, "hi"]]])).toEqual([
    ["div", {}, ["span", {}, "hi"]],
  ]);
});

test("a file:line in text is a reference, and the text around it stays", () => {
  expect(confine([["p", {}, "See src/seed.ts:12, and README.md:3."]])).toEqual([
    [
      "p",
      {},
      "See ",
      ["file-ref", { file: "src/seed.ts", line: "12" }, "src/seed.ts:12"],
      ", and ",
      ["file-ref", { file: "README.md", line: "3" }, "README.md:3"],
      ".",
    ],
  ]);
});

test("inline code that is only a file:line is a reference too", () => {
  expect(confine([["p", {}, ["code", {}, "src/a.ts:7"]]])).toEqual([
    ["p", {}, ["file-ref", { file: "src/a.ts", line: "7" }, "src/a.ts:7"]],
  ]);
});

test("a port, a time, code blocks and links are not references", () => {
  const kept: Array<Node> = [
    ["p", {}, "On localhost:8080 at 10:30, see https://x.dk/a.ts:4"],
    ["pre", {}, ["code", {}, "src/a.ts:7"]],
    ["p", {}, ["a", {}, "src/b.ts:2"]],
  ];
  expect(confine(structuredClone(kept))).toEqual(kept);
});
