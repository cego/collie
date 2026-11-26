// What the merge watch read and decided, line by line, in the host's state directory: an
// incident is read back from the times it recorded rather than from what a later reading
// of the code believes ought to have happened.

import { Effect, FileSystem, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";

/** What asked for a merge request's read: a Run still watching it, or a card that shows it. */
export const WatchSource = Schema.Literals(["watch", "task"]);
export type WatchSource = typeof WatchSource.Type;

export const WatchEvent = Schema.Union([
  /** One logical read of a merge request, and the HTTP requests it took. */
  Schema.TaggedStruct("poll", {
    at: Schema.String,
    mr: Schema.String,
    source: WatchSource,
    result: Schema.Literals(["read", "failed"]),
    /** Requests this host sent to the forge for it, retries included. */
    attempts: Schema.Finite,
    /** The head it read; null where it read nothing. */
    head: Schema.NullOr(Schema.String),
    reason: Schema.optionalKey(Schema.String),
  }),
  /** A head a watch now reads, and since when: what detection happened at. */
  Schema.TaggedStruct("observed", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    head: Schema.String,
    /** When the head was first seen; the quiet window counts from it. */
    since: Schema.Finite,
  }),
  /** A watch woken, which is where its Run's next round starts. */
  Schema.TaggedStruct("woke", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    head: Schema.NullOr(Schema.String),
    previous: Schema.NullOr(Schema.String),
    newHead: Schema.Boolean,
  }),
  /** A watch ended by what the forge reads rather than by a head or a comment. */
  Schema.TaggedStruct("ended", {
    at: Schema.String,
    mr: Schema.String,
    run: Schema.String,
    name: Schema.String,
    why: Schema.Literals(["merged", "closed"]),
  }),
]);
export type WatchEvent = typeof WatchEvent.Type;

const WatchEventJson = Schema.fromJsonString(WatchEvent);

export const WATCH_JOURNAL = "board/watch.jsonl";

export const watchJournalPath = (stateDir: string) => `${stateDir}/${WATCH_JOURNAL}`;

/** Writes one line where `readWatchJournal` finds it. */
export const recordWatchEvent =
  (stateDir: string) =>
  (event: WatchEvent): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
    appendJournal(watchJournalPath(stateDir), WatchEventJson, event).pipe(Effect.orDie);

export const readWatchJournal = (stateDir: string) =>
  readJournal(watchJournalPath(stateDir), WatchEventJson);
