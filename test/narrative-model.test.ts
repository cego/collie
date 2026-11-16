import { expect, test } from "bun:test";
import * as Str from "effect/String";
import { concise } from "../src/narrative-model";

test.each([
  "Waiting for memory on vm-mk: 2.1 of 62.0 GB available.",
  "Waiting for CI and a teammate's approval on group/app!345.",
  "0 of 2 merged; app!12 is open; api!7 waits on app!12.",
  "Its Driver died because /srv/project/repair.workflow.ts does not load: Unexpected token.",
])("a concise status preserves punctuation within its sentence: %s", (status) => {
  expect(concise(status)).toBe(status);
});

test("a concise summary keeps two complete sentences with internal punctuation", () => {
  expect(
    concise(
      "Waiting for CI on group/app!345. Memory has 2.1 GB available. Another attempt follows.",
    ),
  ).toBe("Waiting for CI on group/app!345. Memory has 2.1 GB available.");
});

test("a concise summary normalizes whitespace and bounds Unicode characters", () => {
  expect(concise(" \n Waiting\tfor memory: 2.1 GB available. \n")).toBe(
    "Waiting for memory: 2.1 GB available.",
  );
  expect(concise(Str.repeat(400)("🦊"))).toBe(`${Str.repeat(359)("🦊")}…`);
  expect(concise(" \n\t ")).toBe("");
});
