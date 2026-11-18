import { isFocusKey, type Key } from "./terminal-input";

interface Pane {
  readonly min: number;
  readonly step: number;
  readonly share: number;
}

const CONTEXT = { min: 240, step: 16, share: 0.45 } satisfies Pane;
const CONTEXT_START = { share: 0.28, max: 384 };
const RAIL = { min: 56, step: 24, share: 0.6 } satisfies Pane;
const RAIL_START = { share: 0.25, max: 192 };

const sized = (pane: Pane, chosen: number, room: number) =>
  Math.round(Math.max(pane.min, Math.min(chosen, room * pane.share)));

const SIDE_BY_SIDE = 672;

export const stacks = (room: number) => room < SIDE_BY_SIDE;

export const contextWidth = (chosen: number | null, room: number) =>
  sized(CONTEXT, chosen ?? Math.min(CONTEXT_START.max, room * CONTEXT_START.share), room);

export const contextStepped = (drawn: number, room: number, by: 1 | -1) =>
  sized(CONTEXT, drawn + by * CONTEXT.step, room);

export const railHeight = (chosen: number | null, room: number) =>
  chosen === null ? null : sized(RAIL, chosen, room);

export const railCap = (room: number) =>
  Math.round(Math.max(RAIL.min, Math.min(RAIL_START.max, room * RAIL_START.share)));

export const railStepped = (drawn: number, room: number, by: 1 | -1) =>
  sized(RAIL, drawn + by * RAIL.step, room);

export const workspaceKey = (key: Key, focusing: boolean) => {
  if (isFocusKey(key)) return focusing ? "restore" : "focus";
  return key.key === "Escape" && focusing ? "restore" : null;
};

export interface Focusable {
  readonly isConnected: boolean;
  readonly focus: () => void;
}

export const focusHandOff = <T extends Focusable>() => {
  let left: { origin: T; into: T } | null = null;
  return {
    focus: (active: T | null, inWork: (one: T) => boolean, into: T | null) => {
      left = null;
      if (active === null || into === null || inWork(active)) return;
      left = { origin: active, into };
      into.focus();
    },
    restore: (active: T | null) => {
      const back = left;
      left = null;
      if (back?.origin.isConnected && (active === null || active === back.into))
        back.origin.focus();
    },
  };
};
