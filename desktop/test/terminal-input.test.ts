// What the human does in a pane's terminal in Desktop, as herdr's controller is told it.

import { expect, test } from "bun:test";
import {
  isMouseReport,
  keyAction,
  linksIn,
  mouseOf,
  paneWhere,
  scrollOf,
} from "../src/shared/terminal-input";

/** 100 columns by 20 rows, each cell 8 by 16 pixels, drawn at (10, 50). */
const SCREEN = { left: 10, top: 50, width: 800, height: 320, cols: 100, rows: 20 };
const at = (
  clientX: number,
  clientY: number,
  held: Partial<Record<"shift" | "ctrl" | "alt", true>> = {},
) => ({
  clientX,
  clientY,
  shiftKey: held.shift === true,
  ctrlKey: held.ctrl === true,
  altKey: held.alt === true,
});
const key = (pressed: string, held: Partial<Record<"ctrl" | "meta" | "shift", true>> = {}) => ({
  key: pressed,
  ctrlKey: held.ctrl === true,
  metaKey: held.meta === true,
  shiftKey: held.shift === true,
});

test("the wheel scrolls the pane's own history at the cell under the pointer", () => {
  expect(scrollOf(-120, at(10 + 8 * 4 + 1, 50 + 16 * 2 + 1), SCREEN)).toEqual({
    type: "terminal.scroll",
    direction: "up",
    lines: 3,
    column: 4,
    row: 2,
    modifiers: 0,
  });
  expect(scrollOf(5, at(0, 0, { shift: true }), SCREEN)).toEqual({
    type: "terminal.scroll",
    direction: "down",
    lines: 1,
    column: 0,
    row: 0,
    modifiers: 1,
  });
  expect(scrollOf(0, at(20, 60), SCREEN)).toBeNull();
});

test("a click reaches the pane at its cell, with herdr's modifier bits, and off the edge is the edge", () => {
  expect(
    mouseOf("down", 0, at(10 + 8 * 99 + 7, 50 + 16 * 19, { ctrl: true, alt: true }), SCREEN),
  ).toEqual({
    type: "terminal.mouse",
    action: "down",
    button: "left",
    column: 99,
    row: 19,
    modifiers: 6,
  });
  expect(mouseOf("up", 2, at(2000, 2000), SCREEN)).toMatchObject({
    button: "right",
    column: 99,
    row: 19,
  });
  expect(mouseOf("drag", 1, at(-5, -5), SCREEN)).toMatchObject({
    button: "middle",
    column: 0,
    row: 0,
  });
  expect(mouseOf("down", 3, at(20, 60), SCREEN)).toBeNull();
});

test("xterm.js's own mouse reports are not typed into the pane, and everything else is", () => {
  expect(isMouseReport("\u001b[<0;5;3M")).toBe(true);
  expect(isMouseReport("\u001b[<0;5;3m")).toBe(true);
  expect(isMouseReport("\u001b[M !!")).toBe(true);
  expect(isMouseReport("\u001b")).toBe(false);
  expect(isMouseReport("\u001b[A")).toBe(false);
  expect(isMouseReport("\u001b[200~one\rtwo\u001b[201~")).toBe(false);
});

test("Ctrl+C interrupts the pane, and copies while there is a selection", () => {
  expect(keyAction(key("c", { ctrl: true }), false)).toBe("pane");
  expect(keyAction(key("c", { ctrl: true }), true)).toBe("copy");
  expect(keyAction(key("C", { ctrl: true, shift: true }), false)).toBe("copy");
  expect(keyAction(key("c", { meta: true }), true)).toBe("copy");
  expect(keyAction(key("Escape"), true)).toBe("pane");
  expect(keyAction(key("c"), true)).toBe("pane");
});

test("the platform's paste is the browser's, and a bare Ctrl+V is the pane's", () => {
  expect(keyAction(key("V", { ctrl: true, shift: true }), false)).toBe("paste");
  expect(keyAction(key("v", { meta: true }), false)).toBe("paste");
  expect(keyAction(key("v", { ctrl: true }), false)).toBe("pane");
});

test("a line's web links are found by the columns they span", () => {
  expect(linksIn("see https://gitlab.example/mr/1 now, or http://x.example.")).toEqual([
    { url: "https://gitlab.example/mr/1", start: 5, end: 31 },
    { url: "http://x.example.", start: 41, end: 57 },
  ]);
  expect(linksIn("no link, file:///etc/passwd")).toEqual([]);
});

test("a pane is said where it is, as the card says it", () => {
  expect(paneWhere("vm-mk", { session: null, workspace: "workspace 3", tab: "tab 2" })).toBe(
    "vm-mk › workspace 3 › tab 2",
  );
  expect(paneWhere("vm-mk", { session: "work", workspace: "workspace 3", tab: null })).toBe(
    "vm-mk › workspace 3",
  );
});
