// What a Desktop terminal's size changes tell herdr's controller, which resizes the agent's pane.

import { expect, test } from "bun:test";
import { settledResizes, type Timers } from "../desktop/src/shared/terminal-size";
import { keyAction } from "../desktop/src/shared/terminal-input";

const world = () => {
  const sent: Array<[number, number]> = [];
  let now = 0;
  let made = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: Timers<number> = {
    set: (run, ms) => {
      made += 1;
      due.set(made, { at: now + ms, run });
      return made;
    },
    clear: (handle) => {
      due.delete(handle);
    },
  };
  const sizes = settledResizes((cols, rows) => sent.push([cols, rows]), timers);
  const advance = (ms: number) => {
    now += ms;
    for (const [handle, timer] of [...due].sort((one, other) => one[1].at - other[1].at))
      if (timer.at <= now) {
        due.delete(handle);
        timer.run();
      }
  };
  return { sent, sizes, advance, pending: () => due.size > 0 };
};

test("a drag through many sizes resizes the pane once, 120 ms after it settles", () => {
  const { sent, sizes, advance } = world();
  sizes.resized(80, 24);
  advance(40);
  sizes.resized(92, 24);
  advance(40);
  sizes.resized(131, 38);
  advance(119);
  expect(sent).toEqual([]);
  advance(1);
  expect(sent).toEqual([[131, 38]]);
});

test("settling back at the size the pane already has sends nothing", () => {
  const { sent, sizes, advance } = world();
  sizes.opened(80, 24);
  sizes.resized(120, 30);
  advance(60);
  sizes.resized(80, 24);
  advance(500);
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
