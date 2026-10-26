// What a Desktop terminal's size changes tell herdr's controller, which resizes the agent's pane.

import { expect, test } from "bun:test";
import { settledResizes, type Timers } from "../desktop/src/shared/terminal-size";
import { keyAction } from "../desktop/src/shared/terminal-input";

const world = () => {
  const sent: Array<[number, number]> = [];
  let due: (() => void) | null = null;
  const timers: Timers<() => void> = {
    set: (run) => {
      due = run;
      return run;
    },
    clear: (handle) => {
      if (handle === due) due = null;
    },
  };
  const sizes = settledResizes((cols, rows) => sent.push([cols, rows]), timers);
  const settle = () => {
    const run = due;
    due = null;
    run?.();
  };
  return { sent, sizes, settle, pending: () => due !== null };
};

test("a drag through many sizes resizes the pane once, at the size it settles at", () => {
  const { sent, sizes, settle } = world();
  sizes.resized(80, 24);
  sizes.resized(92, 24);
  sizes.resized(131, 38);
  expect(sent).toEqual([]);
  settle();
  expect(sent).toEqual([[131, 38]]);
});

test("settling back at the size the pane already has sends nothing", () => {
  const { sent, sizes, settle } = world();
  sizes.opened(80, 24);
  sizes.resized(120, 30);
  sizes.resized(80, 24);
  settle();
  expect(sent).toEqual([[80, 24]]);
});

test("a controller that opens is told its size at once, and a resize still settling is dropped", () => {
  const { sent, sizes, pending } = world();
  sizes.opened(80, 24);
  sizes.resized(100, 30);
  sizes.opened(100, 30);
  expect(sent).toEqual([
    [80, 24],
    [100, 30],
  ]);
  expect(pending()).toBe(false);
});

test("a terminal that goes away sends no resize it was still settling", () => {
  const { sent, sizes, pending } = world();
  sizes.resized(100, 30);
  sizes.stop();
  expect(pending()).toBe(false);
  expect(sent).toEqual([]);
});

const press = (pressed: string, held: { ctrl?: true; meta?: true; shift?: true }) => ({
  key: pressed,
  ctrlKey: held.ctrl === true,
  metaKey: held.meta === true,
  shiftKey: held.shift === true,
});

test("Ctrl or Cmd with Shift and F is Focus, not the pane's, and plain Ctrl+F is the pane's", () => {
  expect(keyAction(press("F", { ctrl: true, shift: true }), false)).toBe("focus");
  expect(keyAction(press("F", { meta: true, shift: true }), false)).toBe("focus");
  expect(keyAction(press("f", { ctrl: true }), false)).toBe("pane");
  expect(keyAction(press("F", { shift: true }), false)).toBe("pane");
});
