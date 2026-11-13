// The go a human's Release gives the Release Run it starts (ADR-draft-a-humans-release-is-the-go-for-its-head).

import * as Arr from "effect/Array";
import { Schema } from "effect";
import type { ReviewStanding } from "collie";

/** A human's Release this Run was started by: the head it was given at, and who had approved. */
export const GivenGo = Schema.Struct({
  head: Schema.String,
  approvers: Schema.Array(Schema.String),
});
export type GivenGo = typeof GivenGo.Type;

/** The go at `head`, with whoever the forge named as approving, however far from ready it is. */
export const givenAt = (head: string, standing: ReviewStanding | null): GivenGo => ({
  head,
  approvers: standing !== null && "approvers" in standing ? (standing.approvers ?? []) : [],
});

/** Whether the go still holds: the same head, and nobody's approval gone since. */
export const holdsFor = (given: GivenGo, ready: Extract<ReviewStanding, { _tag: "Ready" }>) =>
  given.head === ready.head && Arr.every(given.approvers, (one) => ready.approvers.includes(one));
