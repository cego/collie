// What the human does in a pane's terminal in Desktop, as herdr's controller is told it,
// and the little the view reads off a line it draws: where its links are.

import type { PaneAt } from "../../../src/board-model";
import type { TerminalCommand } from "./flock";

interface Held {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

export interface Pointer extends Held {
  readonly clientX: number;
  readonly clientY: number;
}

/** The terminal's drawn screen on the page, and its size in cells. */
export interface Screen {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly cols: number;
  readonly rows: number;
}

/** herdr's modifier bits: Shift 1, Ctrl 2, Alt 4. */
const modifiersOf = (held: Held) =>
  (held.shiftKey ? 1 : 0) | (held.ctrlKey ? 2 : 0) | (held.altKey ? 4 : 0);

/** The zero-based cell under the pointer, kept inside the screen. */
export const cellAt = (pointer: Pointer, screen: Screen) => {
  const clamp = (at: number, size: number) => Math.min(size - 1, Math.max(0, Math.floor(at)));
  return {
    column: clamp(((pointer.clientX - screen.left) / screen.width) * screen.cols, screen.cols),
    row: clamp(((pointer.clientY - screen.top) / screen.height) * screen.rows, screen.rows),
  };
};

/** A line of wheel is this many pixels of its delta. */
const WHEEL_LINE = 40;

/** A wheel turn, as a scroll of the pane's own history at the cell under the pointer. */
export const scrollOf = (
  deltaY: number,
  pointer: Pointer,
  screen: Screen,
): TerminalCommand | null =>
  deltaY === 0
    ? null
    : {
        type: "terminal.scroll",
        direction: deltaY < 0 ? "up" : "down",
        lines: Math.max(1, Math.round(Math.abs(deltaY) / WHEEL_LINE)),
        ...cellAt(pointer, screen),
        modifiers: modifiersOf(pointer),
      };

/** By a DOM mouse event's `button`. */
const BUTTONS = ["left", "middle", "right"] as const;

/** A press, release or drag of a mouse button, or null for a button herdr has no name for. */
export const mouseOf = (
  action: "down" | "up" | "drag",
  button: number,
  pointer: Pointer,
  screen: Screen,
): TerminalCommand | null => {
  const named = BUTTONS[button];
  return named === undefined
    ? null
    : {
        type: "terminal.mouse",
        action,
        button: named,
        ...cellAt(pointer, screen),
        modifiers: modifiersOf(pointer),
      };
};

/** A mouse report xterm.js writes itself; herdr is sent `terminal.mouse` instead. */
// oxlint-disable-next-line no-control-regex
export const isMouseReport = (text: string) => /^\u001b\[(<\d+;\d+;\d+[Mm]|M[\s\S]{3})$/.test(text);

export interface Key {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * What a key pressed in the terminal does: reaches the pane; copies the selection, as
 * Ctrl+C does while there is one; or is left to the browser, whose paste xterm.js sends
 * as one bracketed paste where the pane asked for that.
 */
export const keyAction = (key: Key, hasSelection: boolean): "pane" | "copy" | "paste" => {
  const letter = key.key.toLowerCase();
  if (letter === "c" && (key.metaKey || (key.ctrlKey && (key.shiftKey || hasSelection))))
    return "copy";
  if (letter === "v" && (key.metaKey || (key.ctrlKey && key.shiftKey))) return "paste";
  return "pane";
};

/** The web links in a drawn line, by the one-based columns they span. */
export const linksIn = (line: string) =>
  [...line.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((found) => ({
    url: found[0],
    start: found.index + 1,
    end: found.index + found[0].length,
  }));

/** Where a pane is, as its card says it: Machine › workspace › tab. */
export const paneWhere = (machine: string, at: PaneAt) =>
  [machine, at.workspace, at.tab].filter((part) => part !== null).join(" › ");
