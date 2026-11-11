// A wait that ends without a repair; it needs someone only once overdue.

import { Schema } from "effect";
import { epochMs } from "./time";

export const AwaitingSchema = Schema.Struct({
  /** What it waits for, as the card finishes "Waiting for …". */
  on: Schema.String,
  /** Who acts for it to end, or null where nobody has to. */
  who: Schema.NullOr(Schema.String),
  since: Schema.String,
});
export type Awaiting = typeof AwaitingSchema.Type;

export const AwaitingJson = Schema.fromJsonString(AwaitingSchema);

const HOUR = 60 * 60 * 1000;

/** Who a review waits on to change their merge request, which takes as long as it takes. */
export const THE_AUTHOR = "the author";

/** How long it may wait before someone should look: CI's own bound, or two days for a person. */
const patienceOf = (who: string | null) =>
  who === THE_AUTHOR
    ? null
    : who === null
      ? { ms: 2 * HOUR, said: "2 hours" }
      : { ms: 48 * HOUR, said: "2 days" };

export const awaitingLine = (wait: Awaiting) => `Waiting for ${wait.on}.`;

/** The park a wait becomes once it has outlasted its patience, or null while it has not. */
export function overdueLine(wait: Awaiting, now: number): string | null {
  const patience = patienceOf(wait.who);
  if (patience === null || now - epochMs(wait.since) <= patience.ms) return null;
  return `Waiting for ${wait.on} for over ${patience.said}, which is longer than it should take. See what holds it up.`;
}
