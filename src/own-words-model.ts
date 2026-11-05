// What the reader of the human's own words answers, kept apart from the reader so the board
// protocol and Desktop's views can name it without loading a session store.

import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { Schema } from "effect";

export const OwnSource = Schema.Literals(["claude-code", "codex", "pi", "opencode", "collie"]);
export type OwnSource = typeof OwnSource.Type;

/** Where one source keeps the human's words, and how many sessions (or Collie entries) it holds. */
export const OwnStore = Schema.Struct({
  source: OwnSource,
  where: Schema.String,
  found: Schema.Literals(["read", "missing", "unreadable"]),
  sessions: Schema.Finite,
  /** Sessions it could not read, the first of them named in `why`. */
  unread: Schema.optionalKey(Schema.Finite),
  why: Schema.optionalKey(Schema.String),
});
export type OwnStore = typeof OwnStore.Type;

export const OwnInventory = Schema.Struct({ stores: Schema.Array(OwnStore) });
export type OwnInventory = typeof OwnInventory.Type;

export const OwnMessage = Schema.Struct({
  source: OwnSource,
  at: Schema.String,
  /** The directory its session was in, where the store says. */
  cwd: Schema.NullOr(Schema.String),
  text: Schema.String,
  /** The Run it was said to, for Collie's records. */
  run: Schema.optionalKey(Schema.String),
});
export type OwnMessage = typeof OwnMessage.Type;

export const OwnWords = Schema.Struct({
  /** Newest first. */
  messages: Schema.Array(OwnMessage),
  stores: Schema.Array(OwnStore),
  /** Sessions skipped as ones Collie started for a Run's agent. */
  skipped: Schema.Finite,
  /** Messages the caps left out. */
  leftOut: Schema.Finite,
  /** Messages cut to the most one may hold. */
  cut: Schema.Finite,
});
export type OwnWords = typeof OwnWords.Type;

const MOST_MESSAGES = 400;
const MOST_CHARACTERS = 60_000;

const byNewest = Order.mapInput(Order.flip(Order.String), (one: OwnMessage) => one.at);

/** The newest messages within the caps on what one setup may read, and how many more there were. */
export const withinCaps = <M extends OwnMessage>(messages: ReadonlyArray<M>) => {
  const newest = Arr.sort(messages, byNewest);
  let characters = 0;
  let kept = 0;
  for (const { text } of newest) {
    if (kept >= MOST_MESSAGES || characters + text.length > MOST_CHARACTERS) break;
    characters += text.length;
    kept += 1;
  }
  return { kept: Arr.take(newest, kept), leftOut: newest.length - kept };
};
