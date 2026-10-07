// What a click, a double-click and Escape on the board do to the selected card.

import { expect, test } from "bun:test";
import { escapeLetsGo, placeOf } from "../src/shared/selection";

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

test("Escape on the board lets the card go", () => {
  expect(escapeLetsGo(element([]), page(null))).toBe(true);
  expect(escapeLetsGo(element(["[data-card]"]), page(null))).toBe(true);
});

test("Escape with a dialog, slideover, menu or popover open is the overlay's", () => {
  for (const role of ['[role="dialog"]', '[role="alertdialog"]', '[role="menu"]'])
    expect(escapeLetsGo(element([]), page(role))).toBe(false);
});

test("Escape typed in a field stays with the field", () => {
  for (const field of ["input", "textarea", "select"])
    expect(escapeLetsGo(element([field]), page(null))).toBe(false);
  expect(escapeLetsGo(element([], true), page(null))).toBe(false);
});
