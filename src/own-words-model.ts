import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { Schema } from "effect";

export const OwnSource = Schema.Literals(["claude-code", "codex", "pi", "opencode", "collie"]);
export type OwnSource = typeof OwnSource.Type;

export const OwnStore = Schema.Struct({
  source: OwnSource,
  where: Schema.String,
  found: Schema.Literals(["read", "missing", "unreadable"]),
  sessions: Schema.Finite,
  unread: Schema.optionalKey(Schema.Finite),
  why: Schema.optionalKey(Schema.String),
});
export type OwnStore = typeof OwnStore.Type;

export const OwnInventory = Schema.Struct({ stores: Schema.Array(OwnStore) });
export type OwnInventory = typeof OwnInventory.Type;

export const OwnMessage = Schema.Struct({
  source: OwnSource,
  at: Schema.String,
  cwd: Schema.NullOr(Schema.String),
  text: Schema.String,
  run: Schema.optionalKey(Schema.String),
});
export type OwnMessage = typeof OwnMessage.Type;

export const OwnWords = Schema.Struct({
  messages: Schema.Array(OwnMessage),
  stores: Schema.Array(OwnStore),
  skipped: Schema.Finite,
  leftOut: Schema.Finite,
  cut: Schema.Finite,
});
export type OwnWords = typeof OwnWords.Type;

const MOST_MESSAGES = 400;
const MOST_CHARACTERS = 60_000;

const byNewest = Order.mapInput(Order.flip(Order.String), (one: OwnMessage) => one.at);

export const withinCaps = <M extends OwnMessage>(messages: ReadonlyArray<M>) => {
  const newest = Arr.sort(messages, byNewest);
  let characters = 0;
  let kept = 0;
  for (const { text } of newest) {
    if (kept >= MOST_MESSAGES || characters + text.length > MOST_CHARACTERS) {
      break;
    }
    characters += text.length;
    kept += 1;
  }
  return { kept: Arr.take(newest, kept), leftOut: newest.length - kept };
};
