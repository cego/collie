import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import type { PaneAt } from "../../../src/board-model";

// oxlint-disable-next-line no-control-regex
export const isMouseReport = (text: string) => /^\u001b\[(<\d+;\d+;\d+[Mm]|M[\s\S]{3})$/.test(text);

export interface Key {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export const isFocusKey = (key: Key) =>
  Str.toLowerCase(key.key) === "f" && key.shiftKey && (key.ctrlKey || key.metaKey);

// WARNING: paste is left to the browser, which xterm.js sends bracketed where the pane asked for it.
export const keyAction = (key: Key, hasSelection: boolean) => {
  if (isFocusKey(key)) {
    return "focus";
  }
  const letter = Str.toLowerCase(key.key);
  if (letter === "c" && (key.metaKey || (key.ctrlKey && (key.shiftKey || hasSelection)))) {
    return "copy";
  }
  if (letter === "v" && (key.metaKey || (key.ctrlKey && key.shiftKey))) {
    return "paste";
  }
  return "pane";
};

export const linksIn = (line: string) =>
  Arr.map([...pipe(line, Str.matchAll(/https?:\/\/[^\s"'<>]+/g))], (found) => ({
    url: found[0],
    start: (found.index ?? 0) + 1,
    end: (found.index ?? 0) + found[0].length,
  }));

export const paneWhere = (machine: string, at: PaneAt) =>
  Arr.join(
    Arr.filter([machine, at.workspace, at.tab], (part) => part !== null),
    " › ",
  );

export const paneLine = (at: PaneAt) =>
  Arr.join(
    Arr.filter([at.tab, at.workspace], (part) => part !== null),
    " · ",
  );
