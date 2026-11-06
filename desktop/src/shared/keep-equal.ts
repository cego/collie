// What draws a value Vue compares by identity: a part kept as it was is not drawn again.

import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Rec from "effect/Record";

/** `before` while `next` is structurally equal to it, otherwise `next`. */
export const keepEqual = <A>(next: A, before: A | undefined): A =>
  before !== undefined && Equal.equals(next, before) ? before : next;

/** Each item kept against the one at its position, and `before` itself while every one is. */
export const keepList = <A>(
  next: ReadonlyArray<A>,
  before: ReadonlyArray<A> | undefined,
  keep: (one: A, was: A | undefined) => A = keepEqual,
): ReadonlyArray<A> => {
  const kept = Arr.map(next, (one, at) => keep(one, before?.[at]));
  return before !== undefined &&
    kept.length === before.length &&
    Arr.every(kept, (one, at) => one === before[at])
    ? before
    : kept;
};

/** Each entry kept against the one under its key, and `before` itself while every one is. */
export const keepRecord = <A>(
  next: Readonly<Record<string, A>>,
  before: Readonly<Record<string, A>> | undefined,
): Readonly<Record<string, A>> => {
  const kept = Rec.map(next, (one, key) => keepEqual(one, before?.[key]));
  return before !== undefined &&
    Rec.size(kept) === Rec.size(before) &&
    Arr.every(Rec.keys(kept), (key) => kept[key] === before[key])
    ? before
    : kept;
};
