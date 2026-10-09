// What the record's markdown keeps of what an agent wrote: no styling, and `file:line` as a jump.

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

test("nothing can be made a popover, which no box contains", () => {
  expect(
    confine([
      ["button", { popovertarget: "p", popovertargetaction: "show" }, "Open"],
      ["div", { id: "p", ":popover": "true", popover: "" }, "over all"],
    ]),
  ).toEqual([
    ["button", {}, "Open"],
    ["div", { id: "p" }, "over all"],
  ]);
});

test("nothing can open a dialog by command", () => {
  expect(
    confine([
      ["button", { commandfor: "d", command: "show-modal" }, "Open"],
      ["div", { closedby: "none" }, "held"],
    ]),
  ).toEqual([
    ["button", {}, "Open"],
    ["div", {}, "held"],
  ]);
});

test("nothing inside a block, a link or code keeps a style, popover or command either", () => {
  expect(
    confine([
      ["pre", {}, ["div", { popover: "manual", id: "p", style: "position:fixed" }, "over"]],
      ["a", { href: "#" }, ["button", { popovertarget: "p", command: "show-popover" }, "go"]],
      ["code", {}, ["span", { ":popover": "true" }, "x"]],
    ]),
  ).toEqual([
    ["pre", {}, ["div", { id: "p" }, "over"]],
    ["a", { href: "#" }, ["button", {}, "go"]],
    ["code", {}, ["span", {}, "x"]],
  ]);
});

test("no attribute keeps a script URL, whatever a component calls it", () => {
  expect(
    confine([
      ["prose-card", { to: "javascript:window.pwned=true", title: "a card" }],
      ["prose-a", { ":to": '" JaVa\tScRiPt:alert(1)"' }, "go"],
      ["prose-callout", { ":ui": '{"base":"javascript:x"}', icon: "i-lucide-info" }, "note"],
      ["prose-card", { ":to": '"\\u006aavascript:x()"' }],
      ["prose-card", { ":to": "frontmatter.away" }],
      ["input", { type: "checkbox", ":checked": "true" }],
    ]),
  ).toEqual([
    ["prose-card", { title: "a card" }],
    ["prose-a", {}, "go"],
    ["prose-callout", { icon: "i-lucide-info" }, "note"],
    ["prose-card", {}],
    ["prose-card", {}],
    ["input", { type: "checkbox", ":checked": "true" }],
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

const LONG =
  "https://gitlab.cego.dk/some-group/some-project/-/merge_requests/1234/diffs?commit_id=0123456789abcdef0123456789abcdef01234567";

test("a link that is its own URL is drawn short, with the whole URL on hover", () => {
  expect(confine([["p", {}, ["a", { href: LONG }, LONG]]])).toEqual([
    [
      "p",
      {},
      [
        "a",
        { href: LONG, title: LONG },
        "gitlab.cego.dk/some-group/some-project/-…9abcdef01234567",
      ],
    ],
  ]);
});

test("a markdown link keeps the words it was given", () => {
  const kept: Array<Node> = [["p", {}, ["a", { href: LONG }, "the MR"]]];
  expect(confine(structuredClone(kept))).toEqual(kept);
});

test("inline code that is only a web URL is a link to it, and a script URL is not", () => {
  expect(
    confine([
      ["p", {}, ["code", {}, "https://example.com/a/"], ["code", {}, "javascript:alert(1)"]],
      ["pre", {}, ["code", {}, "https://example.com/b"]],
    ]),
  ).toEqual([
    [
      "p",
      {},
      [
        "a",
        { href: "https://example.com/a/", title: "https://example.com/a/" },
        ["code", {}, "example.com/a"],
      ],
      ["code", {}, "javascript:alert(1)"],
    ],
    ["pre", {}, ["code", {}, "https://example.com/b"]],
  ]);
});

test("a link is its own URL however the parser encoded its address", () => {
  const href = "https://example.com/%C3%A6ble?a=b%7Cc%20d";
  expect(confine([["a", { href }, "https://example.com/æble?a=b|c d"]])).toEqual([
    ["a", { href, title: href }, "example.com/æble?a=b|c d"],
  ]);
});
