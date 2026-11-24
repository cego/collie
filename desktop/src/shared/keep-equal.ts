import * as Arr from "effect/Array";
import * as Equal from "effect/Equal";
import * as Rec from "effect/Record";

export const keepEqual = <A>(next: A, before: A | undefined) =>
  before !== undefined && Equal.equals(next, before) ? before : next;

export const keepList = <A>(
  next: ReadonlyArray<A>,
  before: ReadonlyArray<A> | undefined,
  keep: (one: A, was: A | undefined) => A = keepEqual,
) => {
  const kept = Arr.map(next, (one, at) => keep(one, before?.[at]));
  return before !== undefined &&
    kept.length === before.length &&
    Arr.every(kept, (one, at) => one === before[at])
    ? before
    : kept;
};

export const keepRecord = <A>(
  next: Readonly<Record<string, A>>,
  before: Readonly<Record<string, A>> | undefined,
) => {
  const kept = Rec.map(next, (one, key) => keepEqual(one, before?.[key]));
  return before !== undefined &&
    Rec.size(kept) === Rec.size(before) &&
    Arr.every(Rec.keys(kept), (key) => kept[key] === before[key])
    ? before
    : kept;
};
