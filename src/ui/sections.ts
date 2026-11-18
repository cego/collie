import { GLYPH_FOR, STEP_GLYPH_FOR } from "../board";
import type { StepState, TaskState, TaskView } from "../board-model";
import type { Density } from "../settings";

const TWO_COLUMN_MIN = 80;

export function columnsFor(width: number, density: Density) {
  if (width < TWO_COLUMN_MIN) return 1;
  return density === "compact" ? 3 : 2;
}

export const C = {
  ground: "#1a1b26",
  pane: "#16161e",
  card: "#24283b",
  hover: "#2f3549",
  selected: "#3a4160",
  line: "#292e42",
  strong: "#3d4466",
  text: "#c0caf5",
  muted: "#9aa5ce",
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
  todo: C.dim,
};

export function stateGlyph(state: TaskState) {
  return { glyph: GLYPH_FOR[state], fg: STATE_FG[state] };
}

export function stepGlyph(state: StepState) {
  return { glyph: STEP_GLYPH_FOR[state], fg: STEP_FG[state] };
}

export function cardEdge(view: TaskView) {
  if (view.decision !== null) return view.decision.kind === "proposal" ? C.red : C.amber;
  return null;
}

export function sentenceColour(view: TaskView) {
  if (view.decision !== null) return C.text;
  if (view.state === "quiet") return C.purple;
  if (view.state === "failed") return C.red;
  return C.muted;
}
