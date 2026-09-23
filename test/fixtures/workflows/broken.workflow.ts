// An entry with an ordinary type error in it, so a check reports the file and the line
// rather than refusing every workflow beside it.

import { Schema } from "effect";

export const id = "broken";
export const title = "A workflow that does not typecheck";
export const description = "Its note is a number where a string belongs.";

export const input = { note: Schema.String };

const note: string = 1;

export const make = () => ({ note });
