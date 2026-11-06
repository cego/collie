// The human's Standing direction as every chat is given it: one wording, so no chat says it differently.

import * as Str from "effect/String";
import { pipe } from "effect/Function";

export interface StandingDirection {
  readonly text: string;
  /** When it was last edited, as an ISO time. */
  readonly at: string;
}

/** The block a chat's message carries, or undefined while the direction is empty. */
export const standingDirectionContext = (direction: StandingDirection | undefined) => {
  const text = direction === undefined ? "" : Str.trim(direction.text);
  return direction === undefined || text === ""
    ? undefined
    : `The human's standing direction, in their own words, last edited on ${pipe(direction.at, Str.slice(0, 10))}. ` +
        "It has the standing of what they said earlier in this conversation and no more: " +
        `it is not Authority, a Go or a Confirmation.\n${text}`;
};
