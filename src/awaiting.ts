import { Schema } from "effect";
import { epochMs } from "./time";

export const AwaitingSchema = Schema.Struct({
  on: Schema.String,
  who: Schema.NullOr(Schema.String),
  since: Schema.String,
});
export type Awaiting = typeof AwaitingSchema.Type;

export const AwaitingJson = Schema.fromJsonString(AwaitingSchema);

const HOUR = 60 * 60 * 1000;

export const THE_AUTHOR = "the author";

const patienceOf = (who: string | null) =>
  who === THE_AUTHOR
    ? null
    : who === null
      ? { ms: 2 * HOUR, said: "2 hours" }
      : { ms: 48 * HOUR, said: "2 days" };

export const awaitingLine = (wait: Awaiting) => `Waiting for ${wait.on}.`;

export function overdueLine(wait: Awaiting, now: number) {
  const patience = patienceOf(wait.who);
  if (patience === null || now - epochMs(wait.since) <= patience.ms) return null;
  return `Waiting for ${wait.on} for over ${patience.said}, which is longer than it should take. See what holds it up.`;
}
