import { Effect, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";

export const WatchSource = Schema.Literals(["watch", "task"]);
export type WatchSource = typeof WatchSource.Type;

export const WatchEvent = Schema.Union([
  Schema.TaggedStruct("poll", {
    at: Schema.String,
    mr: Schema.String,
    source: WatchSource,
    result: Schema.Literals(["read", "failed"]),
    attempts: Schema.Finite,
    rateLimit: Schema.Finite,
    forge: Schema.String,
    head: Schema.NullOr(Schema.String),
    reason: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("observed", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    head: Schema.String,
    since: Schema.Finite,
  }),
  Schema.TaggedStruct("woke", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    head: Schema.NullOr(Schema.String),
    previous: Schema.NullOr(Schema.String),
    newHead: Schema.Boolean,
  }),
  Schema.TaggedStruct("ended", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    why: Schema.Literals(["merged", "closed"]),
  }),
  Schema.TaggedStruct("completed", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    head: Schema.String,
  }),
  Schema.TaggedStruct("published", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    head: Schema.String,
    round: Schema.Finite,
  }),
  Schema.TaggedStruct("discarded", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    head: Schema.String,
    moved: Schema.String,
  }),
]);
export type WatchEvent = typeof WatchEvent.Type;

const WatchEventJson = Schema.fromJsonString(WatchEvent);

export const WATCH_JOURNAL = "board/watch.jsonl";

export const watchJournalPath = (stateDir: string) => `${stateDir}/${WATCH_JOURNAL}`;

export const recordWatchEvent = (stateDir: string) => (event: WatchEvent) =>
  appendJournal(watchJournalPath(stateDir), WatchEventJson, event).pipe(Effect.orDie);

export const readWatchJournal = (stateDir: string) =>
  readJournal(watchJournalPath(stateDir), WatchEventJson);
