// What the human does in a pane's terminal in Desktop, and the little the view reads off a
// line it draws: where its links are.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import type { PaneAt } from "../../../src/board-model";

/** A mouse report xterm.js writes itself. */
// oxlint-disable-next-line no-control-regex
export const isMouseReport = (text: string) => /^\u001b\[(<\d+;\d+;\d+[Mm]|M[\s\S]{3})$/.test(text);

export interface Key {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Ctrl or Cmd with Shift and F: Focus on the terminal, or Restore, from anywhere in the Flow. */
export const isFocusKey = (key: Key) =>
  Str.toLowerCase(key.key) === "f" && key.shiftKey && (key.ctrlKey || key.metaKey);

/**
 * What a key pressed in the terminal does: reaches the pane; copies the selection, as
 * Ctrl+C does while there is one; is left to the browser, whose paste xterm.js sends
 * as one bracketed paste where the pane asked for that; or toggles Focus.
 */
export const keyAction = (key: Key, hasSelection: boolean): "pane" | "copy" | "paste" | "focus" => {
  if (isFocusKey(key)) return "focus";
  const letter = Str.toLowerCase(key.key);
  if (letter === "c" && (key.metaKey || (key.ctrlKey && (key.shiftKey || hasSelection))))
    return "copy";
  if (letter === "v" && (key.metaKey || (key.ctrlKey && key.shiftKey))) return "paste";
  return "pane";
};

/** The web links in a drawn line, by the one-based columns they span. */
export const linksIn = (line: string) =>
  Arr.map([...pipe(line, Str.matchAll(/https?:\/\/[^\s"'<>]+/g))], (found) => ({
    url: found[0],
    start: (found.index ?? 0) + 1,
    end: (found.index ?? 0) + found[0].length,
  }));

/** Where a pane is, as its card says it: Machine › workspace › tab. */
export const paneWhere = (machine: string, at: PaneAt) =>
  Arr.join(
    Arr.filter([machine, at.workspace, at.tab], (part) => part !== null),
    " › ",
  );

/** A pane on its card's one line, whose footer names the Machine: tab · workspace. */
export const paneLine = (at: PaneAt) =>
  Arr.join(
    Arr.filter([at.tab, at.workspace], (part) => part !== null),
    " · ",
  );
