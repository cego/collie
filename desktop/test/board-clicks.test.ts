// Where a board click landed and what an Escape found, read over fake elements.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { escapeOn, inField, landedOn } from "../src/shared/board-clicks";

/** An element, by the selectors it or one of its ancestors matches; a card has key `pc:a`. */
const element = (matches: ReadonlyArray<string>, isContentEditable = false) => ({
  isContentEditable,
  closest: (selectors: string) =>
    Arr.some(Str.split(selectors, ","), (one) => matches.includes(Str.trim(one)))
      ? {
          getAttribute: (name: string) => (name === "data-card" ? "pc:a" : null),
          hasAttribute: (name: string) => matches.includes(`[${name}]`),
        }
      : null,
});

/** A window with an overlay of this role open, or none. */
const page = (open: string | null) => ({
  querySelector: (selectors: string) =>
    open !== null &&
    pipe(selectors, Str.includes('[data-state="open"]')) &&
    pipe(selectors, Str.includes(open))
      ? {}
      : null,
});

test("a click on a card's body is the card's, and on one of its controls the control's", () => {
  expect(landedOn(element(["[data-card]"]))).toEqual({ on: "card", card: "pc:a", asOf: false });
  for (const control of ["button", "a", "input", "label", "form"])
    expect(landedOn(element([control, "[data-card]"]))).toEqual({ on: "control" });
});

test("a card whose Machine dropped says so", () => {
  expect(landedOn(element(["[data-card]", "[data-as-of]"]))).toEqual({
    on: "card",
    card: "pc:a",
    asOf: true,
  });
});

test("a click between cards or on a heading is the background, and the Finished summary is a control", () => {
  expect(landedOn(element([]))).toEqual({ on: "background" });
  expect(landedOn(element(["summary"]))).toEqual({ on: "control" });
  expect(landedOn(null)).toEqual({ on: "background" });
});

test("Escape finds no overlay and no field on the board", () => {
  expect(escapeOn(element([]), page(null))).toEqual({
    kind: "escape",
    overlay: false,
    typing: false,
  });
  expect(escapeOn(null, page(null))).toEqual({ kind: "escape", overlay: false, typing: false });
});

test("Escape inside an open Flow inspector belongs to the Flow", () => {
  expect(escapeOn(element(["[data-escape-scope]"]), page(null))).toMatchObject({ overlay: true });
});

test("Escape finds a dialog, slideover, popover, menu or select open", () => {
  for (const role of [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="listbox"]',
  ])
    expect(escapeOn(element([]), page(role))).toMatchObject({ overlay: true });
});

test("Escape typed in a field, such as the Log search, is typing", () => {
  for (const field of ["input", "textarea", "select"])
    expect(escapeOn(element([field]), page(null))).toMatchObject({ typing: true });
  expect(escapeOn(element([], true), page(null))).toMatchObject({ typing: true });
});

test("focus in a field, or in what is editable, is in a field; anywhere else is not", () => {
  for (const field of ["input", "textarea", "select"]) expect(inField(element([field]))).toBe(true);
  expect(inField(element([], true))).toBe(true);
  expect(inField(element(["button"]))).toBe(false);
  expect(inField(null)).toBe(false);
});
