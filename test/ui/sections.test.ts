// How many cards fit across: a Setting, and the pane's width overrules it.

import { expect, test } from "bun:test";
import { columnsFor } from "../../src/ui/sections";

test("the grid is one column on a narrow pane, two comfortable and three compact", () => {
  expect(columnsFor(79, "comfortable")).toBe(1);
  expect(columnsFor(79, "compact")).toBe(1);
  expect(columnsFor(80, "comfortable")).toBe(2);
  expect(columnsFor(200, "comfortable")).toBe(2);
  expect(columnsFor(80, "compact")).toBe(3);
});
