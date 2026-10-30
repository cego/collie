import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { FlowStrip } from "../src/board-model";
import { cardFlow } from "../desktop/src/shared/flow-strip";

const glyph = (title: string, state: FlowStrip["glyphs"][number]["state"] = "expected") => ({
  title,
  state,
});

test.each([
  ["Build", "Slice 4 of 6"],
  ["Spec", "Asked 12 min ago"],
  ["Checks", "test failed"],
])("the strip names %s and its current fact", (title, said) => {
  const strip = cardFlow({
    glyphs: [glyph("Scope", "done"), glyph(title, "running"), glyph("MR")],
    release: 0,
    current: { title, said },
  });
  expect(strip?.label).toBe(`${title} · ${said}`);
  expect(strip?.name).toBe(`Flow: ${title}, ${said}. 1 of 3 Steps done.`);
});

test("a finished strip says Done and an older host draws nothing", () => {
  const strip = cardFlow({
    glyphs: [glyph("Spec", "done"), glyph("Build", "done")],
    release: 0,
    current: null,
  });
  expect(strip?.label).toBe("Done");
  expect(strip?.name).toBe("Flow: 2 of 2 Steps done.");
  expect(cardFlow(undefined)).toBeNull();
});

test("more than ten Run glyphs fold done Steps together without folding the release", () => {
  const strip = cardFlow({
    glyphs: [
      ...Array.from({ length: 9 }, (_, i) => glyph(`Step ${i}`, "done")),
      glyph("Build", "running"),
      glyph("Review"),
      glyph("MR"),
      glyph("CI", "done"),
      glyph("Merged"),
      glyph("In prod"),
    ],
    release: 3,
    current: { title: "Build", said: "Slice 4 of 6" },
  })!;
  expect(Arr.map(strip.run, (one) => one.title)).toEqual(["9 done", "Build", "Review", "MR"]);
  expect(Arr.map(strip.release, (one) => one.title)).toEqual(["CI", "Merged", "In prod"]);
  expect(strip.name).toBe("Flow: Build, Slice 4 of 6. 9 of 12 Steps done.");
});

test("ten Run glyphs stay separate even with release glyphs", () => {
  const strip = cardFlow({
    glyphs: [
      ...Array.from({ length: 10 }, (_, i) => glyph(`Step ${i}`, "done")),
      glyph("CI"),
      glyph("Merged"),
      glyph("In prod"),
    ],
    release: 3,
    current: null,
  })!;
  expect(strip.run).toHaveLength(10);
  expect(strip.run[0]?.title).toBe("Step 0");
  expect(strip.release).toHaveLength(3);
});
