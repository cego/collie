// What the drawer makes of a Run's evidence: terminal colours, and its files sorted into
// a gallery of before/after pairs, videos, reports and logs.

import { expect, test } from "bun:test";
import { ansiLines, ansiSpans } from "../src/shared/ansi";
import { sortEvidence } from "../src/shared/evidence";

test("terminal colours become styled spans, and a reset ends them", () => {
  expect(ansiSpans("ok \x1b[31;1mFAIL\x1b[0m done")).toEqual([
    { text: "ok ", style: {} },
    { text: "FAIL", style: { color: "var(--ansi-1)", fontWeight: "bold" } },
    { text: " done", style: {} },
  ]);
});

test("256-colour and true-colour codes keep their colour, and a background is its own", () => {
  expect(ansiSpans("\x1b[38;5;208ma\x1b[38;2;1;2;3;44mb\x1b[39;49mc")).toEqual([
    { text: "a", style: { color: "rgb(255, 135, 0)" } },
    { text: "b", style: { color: "rgb(1, 2, 3)", backgroundColor: "var(--ansi-4)" } },
    { text: "c", style: {} },
  ]);
});

test("bright colours, and codes that are not colours, are understood or dropped", () => {
  expect(ansiSpans("\x1b[92mgreen\x1b[22;3mx\x1b[2Ky\x1b[m")).toEqual([
    { text: "green", style: { color: "var(--ansi-10)" } },
    { text: "x", style: { color: "var(--ansi-10)", fontStyle: "italic" } },
    { text: "y", style: { color: "var(--ansi-10)", fontStyle: "italic" } },
  ]);
});

test("a colour carries across the lines it spans", () => {
  expect(ansiLines("\x1b[31mone\ntwo\x1b[0m\nthree")).toEqual([
    [{ text: "one", style: { color: "var(--ansi-1)" } }],
    [{ text: "two", style: { color: "var(--ansi-1)" } }],
    [{ text: "three", style: {} }],
  ]);
});

const file = (name: string) => ({ name, bytes: 10 });

test("before and after shots of one view are paired, whatever side of the name says which", () => {
  const { gallery } = sortEvidence(
    ["home.before.png", "home.after.png", "after-cart.jpg", "before-cart.jpg", "lone.webp"].map(
      file,
    ),
  );
  expect(
    gallery.map((item) => [
      item.before?.name ?? null,
      item.after?.name ?? null,
      item.alone?.name ?? null,
    ]),
  ).toEqual([
    ["before-cart.jpg", "after-cart.jpg", null],
    ["home.before.png", "home.after.png", null],
    [null, null, "lone.webp"],
  ]);
});

test("a half of a pair with no other half stands alone", () => {
  const { gallery } = sortEvidence([file("login_before.png")]);
  expect(gallery).toEqual([{ key: "login_before.png", alone: file("login_before.png") }]);
});

test("videos, HTML reports, logs and everything else are kept apart", () => {
  const sorted = sortEvidence(
    ["run.webm", "demo.MP4", "lighthouse.html", "suite.log", "data.bin", "junit.xml"].map(file),
  );
  expect(sorted.videos.map((one) => one.name)).toEqual(["demo.MP4", "run.webm"]);
  expect(sorted.reports.map((one) => one.name)).toEqual(["lighthouse.html"]);
  expect(sorted.logs.map((one) => one.name)).toEqual(["junit.xml", "suite.log"]);
  expect(sorted.others.map((one) => one.name)).toEqual(["data.bin"]);
});
