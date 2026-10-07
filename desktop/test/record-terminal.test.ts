// What a card's record decides about its Terminal tab.

import { expect, test } from "bun:test";
import { offersTerminal, opensHerdrWithoutPane } from "../src/shared/record-terminal";

test("the Terminal tab is offered on a reached Machine and kept while shown after it drops", () => {
  expect(offersTerminal(null, undefined)).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "terminal")).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "log")).toBe(false);
});

test("only Go to pane falls back to herdr's own client where there is no pane", () => {
  expect(opensHerdrWithoutPane("terminal")).toBe(true);
  expect(opensHerdrWithoutPane("diff")).toBe(false);
});
