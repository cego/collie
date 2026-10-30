// A Run's Review comment drafts, what each is about, and the one message they are sent as
// (ADR-0051). No Bun-only import: the view bundles this.

import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

/** A span of a plan file, by its path in the plan directory, quoted as selected. */
export interface PlanAnchor {
  readonly _tag: "Plan";
  readonly file: string;
  readonly quote: string;
}

/** Lines of a changed file on one side: as it is now (`additions`) or as it was. */
export interface DiffAnchor {
  readonly _tag: "Diff";
  readonly path: string;
  readonly side: SelectionSide;
  readonly first: number;
  readonly last: number;
  readonly lines: ReadonlyArray<string>;
}

export type Anchor = PlanAnchor | DiffAnchor;

export interface Draft {
  readonly id: string;
  readonly anchor: Anchor;
  readonly text: string;
}

export const addDraft = (drafts: ReadonlyArray<Draft>, draft: Draft): Draft[] => [...drafts, draft];

export const editDraft = (drafts: ReadonlyArray<Draft>, id: string, text: string): Draft[] =>
  drafts.map((draft) => (draft.id === id ? { ...draft, text } : draft));

export const removeDraft = (drafts: ReadonlyArray<Draft>, id: string): Draft[] =>
  drafts.filter((draft) => draft.id !== id);

/** What is left once the drafts `sent` carried have gone; one edited since is kept. */
export const clearSent = (drafts: ReadonlyArray<Draft>, sent: ReadonlyArray<Draft>): Draft[] =>
  drafts.filter((draft) => !sent.some((one) => one.id === draft.id && one.text === draft.text));

/** A selection in a plan file as an anchor; null for one with nothing but whitespace. */
export const planAnchor = (file: string, selected: string): PlanAnchor | null =>
  selected.trim() === "" ? null : { _tag: "Plan", file, quote: selected };

/** The hunk of `file` that shows `line` on `side`, and where its lines start. */
const hunkAt = (file: FileDiffMetadata, line: number, side: SelectionSide) =>
  file.hunks
    .map((hunk) =>
      side === "additions"
        ? { start: hunk.additionStart, count: hunk.additionCount, index: hunk.additionLineIndex }
        : { start: hunk.deletionStart, count: hunk.deletionCount, index: hunk.deletionLineIndex },
    )
    .find(({ start, count }) => line >= start && line < start + count);

export const inHunks = (file: FileDiffMetadata, line: number, side: SelectionSide) =>
  hunkAt(file, line, side) !== undefined;

const textAt = (file: FileDiffMetadata, line: number, side: SelectionSide) => {
  const hunk = hunkAt(file, line, side);
  if (hunk === undefined) return [];
  const text = (side === "additions" ? file.additionLines : file.deletionLines)[
    hunk.index + line - hunk.start
  ];
  return text === undefined ? [] : [text.replace(/\r?\n$/, "")];
};

/**
 * The lines a selection covers on its side, the file as it is now where it names none. One
 * crossing to the other side is its first line alone, since the two sides number apart.
 */
export const diffAnchor = (
  path: string,
  range: SelectedLineRange,
  file: FileDiffMetadata,
): DiffAnchor => {
  const side = range.side ?? "additions";
  const end = (range.endSide ?? side) === side ? range.end : range.start;
  const first = Math.min(range.start, end);
  const last = Math.max(range.start, end);
  const lines: string[] = [];
  for (let line = first; line <= last; line++) lines.push(...textAt(file, line, side));
  return { _tag: "Diff", path, side, first, last, lines };
};

const QUOTE_MAX = 300;

/** The quote as `>` lines, a long one kept to its start and end. */
const quoted = (quote: string) => {
  const head = Math.ceil((QUOTE_MAX - 1) / 2);
  const cut =
    quote.length <= QUOTE_MAX
      ? quote
      : `${quote.slice(0, head)}…${quote.slice(quote.length - (QUOTE_MAX - 1 - head))}`;
  return cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
};

export const quoteOf = (anchor: Anchor) =>
  anchor._tag === "Plan" ? anchor.quote : anchor.lines.join("\n");

export const locationOf = (anchor: Anchor) => {
  if (anchor._tag === "Plan") return `the plan's \`${anchor.file}\``;
  const lines = anchor.first === anchor.last ? `${anchor.first}` : `${anchor.first}-${anchor.last}`;
  return `\`${anchor.path}:${lines}\`${anchor.side === "deletions" ? " (as it was)" : ""}`;
};

export const counted = (drafts: ReadonlyArray<Draft>) =>
  `${drafts.length} review comment${drafts.length === 1 ? "" : "s"}`;

export const compose = (drafts: ReadonlyArray<Draft>) => {
  const count = counted(drafts);
  const items = drafts.map(
    (draft, at) =>
      `${at + 1}. ${locationOf(draft.anchor)}\n${quoted(quoteOf(draft.anchor))}\n\n${draft.text}`,
  );
  const message = [
    `${count} from the human in Desktop. Each names where it is, quotes what it is about, then says what they want.`,
    ...items,
  ];
  if (drafts.some((draft) => draft.anchor._tag === "Plan"))
    message.push(
      "Revise the plan and tickets where these comments call for changes. Preserve the Run's scope and constraints. Leave its next-choice menu unanswered.",
    );
  return message.join("\n\n");
};
