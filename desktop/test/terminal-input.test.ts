// What the human does in a pane's terminal in Desktop.

import { expect, test } from "bun:test";
import { isMouseReport, keyAction, linksIn, paneWhere } from "../src/shared/terminal-input";

const key = (pressed: string, held: Partial<Record<"ctrl" | "meta" | "shift", true>> = {}) => ({
  key: pressed,
  ctrlKey: held.ctrl === true,
  metaKey: held.meta === true,
  shiftKey: held.shift === true,
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
