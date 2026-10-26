import { isFocusKey, type Key } from "./terminal-input";

interface Pane {
  readonly min: number;
  readonly step: number;
  /** The most of the room it may take. */
  readonly share: number;
}

const CONTEXT = { min: 240, step: 16, share: 0.45 } satisfies Pane;
const CONTEXT_START = { share: 0.28, max: 384 };
const RAIL = { min: 56, step: 24, share: 0.6 } satisfies Pane;
const RAIL_START = { share: 0.25, max: 192 };

const sized = (pane: Pane, chosen: number, room: number) =>
  Math.round(Math.max(pane.min, Math.min(chosen, room * pane.share)));

/** Under this, the context column would leave the work too narrow, so it goes above it. */
const SIDE_BY_SIDE = 672;

export const stacks = (room: number) => room < SIDE_BY_SIDE;

/** The context column's width in a workspace `room` px wide; null is the default. */
export const contextWidth = (chosen: number | null, room: number) =>
  sized(CONTEXT, chosen ?? Math.min(CONTEXT_START.max, room * CONTEXT_START.share), room);

export const contextStepped = (drawn: number, room: number, by: 1 | -1) =>
  sized(CONTEXT, drawn + by * CONTEXT.step, room);

/** The rail's height in a Flow `room` px tall; null leaves it to its Runs, within its cap. */
export const railHeight = (chosen: number | null, room: number) =>
  chosen === null ? null : sized(RAIL, chosen, room);

/** The most a rail left to its Runs takes of a Flow `room` px tall, before it scrolls. */
export const railCap = (room: number) =>
  Math.round(Math.max(RAIL.min, Math.min(RAIL_START.max, room * RAIL_START.share)));

export const railStepped = (drawn: number, room: number, by: 1 | -1) =>
  sized(RAIL, drawn + by * RAIL.step, room);

/** What a key does to the workspace, ahead of the Flow's own keys. */
export const workspaceKey = (key: Key, focusing: boolean): "focus" | "restore" | null => {
  if (isFocusKey(key)) return focusing ? "restore" : "focus";
  return key.key === "Escape" && focusing ? "restore" : null;
};
