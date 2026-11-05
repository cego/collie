import { expect, test } from "bun:test";
import {
  FIRST_STEPS,
  LATER_STEPS,
  firstWindow,
  grownWindow,
  wholeWindow,
  type StepWindow,
} from "../src/shared/flow-window";

test("a Flow no larger than a first frame's Steps is drawn whole at once", () => {
  expect(firstWindow(40, 30)).toEqual({ from: 0, to: 40 });
  expect(wholeWindow(firstWindow(40, 30), 40)).toBe(true);
});

test("a large Flow's first frame draws the Steps around where the work is, kept inside the Flow", () => {
  expect(firstWindow(220, 0)).toEqual({ from: 0, to: FIRST_STEPS });
  expect(firstWindow(220, 100)).toEqual({ from: 100 - FIRST_STEPS / 2, to: 100 + FIRST_STEPS / 2 });
  expect(firstWindow(220, 210)).toEqual({ from: 220 - FIRST_STEPS, to: 220 });
});

test("each frame after draws a few more Steps on both sides until every Step is drawn", () => {
  let window: StepWindow = firstWindow(220, 100);
  let frames = 0;
  while (!wholeWindow(window, 220)) {
    const next = grownWindow(window, 220);
    expect(next.from).toBeLessThanOrEqual(window.from);
    expect(next.to).toBeGreaterThanOrEqual(window.to);
    expect(window.from - next.from + (next.to - window.to)).toBe(
      Math.min(LATER_STEPS, window.from + 220 - window.to),
    );
    window = next;
    frames++;
  }
  expect(window).toEqual({ from: 0, to: 220 });
  expect(frames).toBe(Math.ceil((220 - FIRST_STEPS) / LATER_STEPS));
});

test("a Flow that lost Steps keeps its window inside what is left", () => {
  expect(grownWindow({ from: 100, to: 200 }, 150)).toEqual({
    from: 100 - LATER_STEPS,
    to: 150,
  });
});
