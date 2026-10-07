// A board click and Escape, decided over fake elements.

import { expect, test } from "bun:test";
import { escapeBacksOut, opensOnDoubleClick, placeOf } from "../src/shared/board-clicks";

/** An element, by the selectors it or one of its ancestors matches. */
const element = (matches: ReadonlyArray<string>, isContentEditable = false) => ({
  isContentEditable,
  closest: (selectors: string) =>
    selectors.split(",").some((one) => matches.includes(one.trim())) ? {} : null,
});

/** A window with an overlay of this role open, or none. */
const page = (open: string | null) => ({
  querySelector: (selectors: string) =>
    open !== null && selectors.includes('[data-state="open"]') && selectors.includes(open)
      ? {}
      : null,
});

test("a click on a card's body is the card's, and on one of its controls the control's", () => {
  expect(placeOf(element(["[data-card]"]))).toBe("card");
  for (const control of ["button", "a", "input", "label", "form"])
    expect(placeOf(element([control, "[data-card]"]))).toBe("control");
});

test("a click between cards or on a heading is the board's, and the Finished summary is a control", () => {
  expect(placeOf(element([]))).toBe("board");
  expect(placeOf(element(["summary"]))).toBe("control");
  expect(placeOf(null)).toBe("board");
});

test("a double-click on a card's body opens it, unless its Machine dropped", () => {
  expect(opensOnDoubleClick(element(["[data-card]"]), null)).toBe(true);
  expect(opensOnDoubleClick(element(["[data-card]"]), 1_700_000_000_000)).toBe(false);
  expect(opensOnDoubleClick(element(["button", "[data-card]"]), null)).toBe(false);
  expect(opensOnDoubleClick(element([]), null)).toBe(false);
});

test("Escape closes an open record, and on the board lets the card go", () => {
  expect(escapeBacksOut(element([]), page(null), true)).toBe("close-record");
  expect(escapeBacksOut(element([]), page(null), false)).toBe("let-go");
  expect(escapeBacksOut(element(["[data-card]"]), page(null), false)).toBe("let-go");
});

test("Escape with a dialog, slideover, popover, menu or select open is the overlay's", () => {
  for (const role of [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
  ])
    for (const recordOpen of [true, false])
      expect(escapeBacksOut(element([]), page(role), recordOpen)).toBe("nothing");
});

test("Escape typed in a field, such as the Log search, stays with the field", () => {
  for (const recordOpen of [true, false]) {
    for (const field of ["input", "textarea", "select"])
      expect(escapeBacksOut(element([field]), page(null), recordOpen)).toBe("nothing");
    expect(escapeBacksOut(element([], true), page(null), recordOpen)).toBe("nothing");
  }
});
