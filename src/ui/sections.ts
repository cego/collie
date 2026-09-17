// How the board is drawn: the palette, a state's colour, a card's edge, and how many
// cards fit across. What the board *is* — its sections, labels and sentences — is
// `src/board.ts`, which the CLI and the text view read too.

import { GLYPH_FOR, STEP_GLYPH_FOR, type StepState, type TaskState, type TaskView } from "../board";
import type { Density } from "../config";

/** Below this two columns are two unreadable half-cards rather than one readable one. */
const TWO_COLUMN_MIN = 80;

export function columnsFor(width: number, density: Density): number {
  if (width < TWO_COLUMN_MIN) return 1;
  return density === "compact" ? 3 : 2;
}

/** The Tokyo Night palette the prototype is drawn in. */
export const C = {
  ground: "#1a1b26",
  pane: "#16161e",
  // A clear step up from the ground: two cells of near-identical dark read as no card at all.
  card: "#24283b",
  hover: "#2f3549",
  selected: "#3a4160",
  line: "#292e42",
  strong: "#3d4466",
  text: "#c0caf5",
  muted: "#9aa5ce",
  // Readable on the ground and on a card; the comment grey it replaced was not.
  dim: "#7d88b5",
  blue: "#7aa2f7",
  amber: "#e0af68",
  green: "#9ece6a",
  red: "#f7768e",
  purple: "#bb9af7",
} as const;

const STATE_FG: Readonly<Record<TaskState, string>> = {
  blocked: C.amber,
  active: C.blue,
  quiet: C.purple,
  failed: C.red,
  stopped: C.dim,
  abandoned: C.amber,
  done: C.green,
};

const STEP_FG: Readonly<Record<StepState, string>> = {
  done: C.green,
  active: C.blue,
  blocked: C.amber,
  failed: C.red,
  // Quieter than the steps that were reached, but still there.
  todo: C.dim,
};

export function stateGlyph(state: TaskState) {
  return { glyph: GLYPH_FOR[state], fg: STATE_FG[state] };
}

export function stepGlyph(state: StepState) {
  return { glyph: STEP_GLYPH_FOR[state], fg: STEP_FG[state] };
}

/**
 * The one cell of colour down a card's left edge, or none. Only the states worth
 * interrupting a human for get one — an edge on every card is an edge on none.
 */
export function cardEdge(view: TaskView): string | null {
  // Only a decision colours the whole border: a quiet or failed card already says so in
  // its glyph and its sentence, and a board of coloured boxes is a board nobody reads.
  if (view.decision !== null) return view.decision.kind === "proposal" ? C.red : C.amber;
  return null;
}

/** The colour of a card's sentence: the state it is about, where that state is loud. */
export function sentenceColour(view: TaskView): string {
  if (view.decision !== null) return C.text;
  if (view.state === "quiet") return C.purple;
  if (view.state === "failed") return C.red;
  return C.muted;
}
