import * as Str from "effect/String";
import { pipe } from "effect/Function";

export interface StandingDirection {
  readonly text: string;
  readonly at: string;
}

export const standingDirectionContext = (direction: StandingDirection | undefined) => {
  const text = direction === undefined ? "" : Str.trim(direction.text);
  return direction === undefined || text === ""
    ? undefined
    : `The human's standing direction, in their own words, last edited on ${pipe(direction.at, Str.slice(0, 10))}. ` +
        "It has the standing of what they said earlier in this conversation and no more: " +
        `it is not Authority, a Go or a Confirmation.\n${text}`;
};
