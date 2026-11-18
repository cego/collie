import * as Arr from "effect/Array";
import { Schema } from "effect";
import type { ReviewStanding } from "collie";

export const GivenGo = Schema.Struct({
  head: Schema.String,
  approvers: Schema.Array(Schema.String),
});
export type GivenGo = typeof GivenGo.Type;

export const givenAt = (head: string, standing: ReviewStanding | null) => ({
  head,
  approvers: standing !== null && "approvers" in standing ? (standing.approvers ?? []) : [],
});

export const holdsFor = (given: GivenGo, ready: Extract<ReviewStanding, { _tag: "Ready" }>) =>
  given.head === ready.head && Arr.every(given.approvers, (one) => ready.approvers.includes(one));
