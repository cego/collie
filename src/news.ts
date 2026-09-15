// What Collie has to tell the human that they did not ask for, and what became of it.
//
// The board already notices meaningful change — `proactive.ts` says which transitions are
// worth a word and which are just a Run getting on with it. This is what happens to one
// after that: it is written down as a fact, kept until something proves it reached the
// conversation, and never turned into prose by a second model.
//
// Four disciplines, and each is a way this goes wrong otherwise.
//
// **No model until there is something to say.** An unchanged Herd produces no events, so
// nothing is appended, so no turn is started. The board redrawing is not news.
//
// **Deduplicated by cause, not by moment.** A Run that halted is one piece of news however
// many times the board redraws; a Run that halts again for a different reason is another.
// `proactive.ts` already mints that key.
//
// **Bounded, and says what it dropped.** A burst that arrives while chat is busy becomes
// one batch of the newest items and a line naming how many older ones went — never one
// turn per event, and never a single "latest status" line that swallowed the rest.
//
// **Submitted is not delivered.** Writing a notification is not evidence anybody read it.
// An item stays `pending` until the conversation itself says otherwise, and an item whose
// fate nobody can establish stays `uncertain` rather than being quietly called done.

import { Effect, FileSystem, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";
import { herdDir } from "./steering";
import { nowIso } from "./time";

/**
 * How many items one batch carries. A screen's worth of news; what it left out is said
 * rather than dropped silently, and nothing is lost — the rest stays pending.
 */
export const BATCH = 10;

/** How many items the journal keeps. Old news nobody read is still not worth unbounded disk. */
export const KEEP = 200;

const ItemSchema = Schema.Struct({
  /** What makes this news this news. `proactive.ts` mints it; a repeat is the same key. */
  key: Schema.String,
  run: Schema.String,
  /** The words a human reads. Built from the record, never written by a model. */
  text: Schema.String,
  at: Schema.String,
});
export type Item = Schema.Schema.Type<typeof ItemSchema>;

const LineSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("item"), ...ItemSchema.fields }),
  /**
   * What became of it. `read` is the conversation itself having taken it — the only
   * receipt worth the name. `sent` is a transport having accepted it, which is a
   * different and weaker fact. `uncertain` is a send nobody can account for, and it is
   * kept rather than retried: an ambiguous delivery repeated is the same news twice.
   */
  Schema.Struct({
    kind: Schema.Literals(["sent", "read", "uncertain"]),
    key: Schema.String,
    at: Schema.String,
    note: Schema.optionalKey(Schema.String),
  }),
]);
type Line = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);

export const newsPath = Effect.fn("News.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "news.jsonl");
});

export const read = (file: string) =>
  readJournal(file, LineJson).pipe(
    Effect.catch((): Effect.Effect<ReadonlyArray<Line>> => Effect.succeed([])),
  );

/** A batch as it is handed over: what is in it, and how much it left behind. */
export interface Batch {
  readonly items: ReadonlyArray<Item>;
  readonly omitted: number;
}

/**
 * News nobody has read yet, newest last, and how many older ones this leaves out.
 *
 * `sent` does not remove an item: a transport that accepted a message has not shown that
 * a conversation received it, and the one thing this must not do is call something
 * delivered because it was handed over.
 */
export function pending(lines: ReadonlyArray<Line>): Batch {
  const all = unread(lines);
  return { items: all.slice(-BATCH), omitted: Math.max(0, all.length - BATCH) };
}

/** Every item nobody has read, newest last — the batch before it is bounded. */
function unread(lines: ReadonlyArray<Line>): ReadonlyArray<Item> {
  const readKeys = new Set(lines.flatMap((line) => (line.kind === "read" ? [line.key] : [])));
  const items = new Map<string, Item>();
  for (const line of lines)
    if (line.kind === "item" && !readKeys.has(line.key))
      items.set(line.key, { key: line.key, run: line.run, text: line.text, at: line.at });
  return [...items.values()];
}

/** Items a send could not be accounted for, which stay a human's to look at. */
export function uncertain(lines: ReadonlyArray<Line>): ReadonlyArray<string> {
  const settled = new Set(lines.flatMap((line) => (line.kind === "read" ? [line.key] : [])));
  return [
    ...new Set(
      lines.flatMap((line) =>
        line.kind === "uncertain" && !settled.has(line.key) ? [line.key] : [],
      ),
    ),
  ];
}

/**
 * Write one piece of news down, unless this Herd already has it.
 *
 * Deduplicated here as well as by `proactive.ts`'s own memory, because the two answer
 * different questions: that one is "have I ever said this", and this one is "is it
 * already waiting". A restart that re-notices a halt must not queue it twice.
 */
export const append = Effect.fn("News.append")(function* (file: string, item: Omit<Item, "at">) {
  const lines = yield* read(file);
  if (unread(lines).some((known) => known.key === item.key)) return false;
  yield* appendJournal(file, LineJson, { kind: "item", ...item, at: yield* nowIso() }).pipe(
    Effect.orDie,
  );
  yield* trim(file);
  return true;
});

/** What became of an item, as its own line: the states are separate facts. */
export const settle = Effect.fn("News.settle")(function* (
  file: string,
  key: string,
  as: "sent" | "read" | "uncertain",
  note?: string,
) {
  const at = yield* nowIso();
  const line: Line = note === undefined ? { kind: as, key, at } : { kind: as, key, at, note };
  yield* appendJournal(file, LineJson, line).pipe(Effect.orDie);
});

/** Kept bounded on write, because there is no daemon to sweep with. */
const trim = Effect.fn("News.trim")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const lines = yield* read(file);
  if (lines.length <= KEEP) return;
  const kept = lines.slice(-KEEP);
  const encode = Schema.encodeSync(LineJson);
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(tmp, kept.map((line) => `${encode(line)}\n`).join(""));
  yield* fs.rename(tmp, file);
});

/**
 * The batch as the conversation is given it: the facts, and what was left out. Built from
 * the items themselves — there is no second model between the record and these words, so
 * what a human reads is what Collie actually knows.
 */
export function asText(batch: Batch): string {
  if (batch.items.length === 0) return "Nothing has happened that you have not seen.";
  return [
    ...batch.items.map((item) => `- ${item.text}`),
    ...(batch.omitted > 0
      ? [`- (${batch.omitted} older item(s) not listed here; they are still waiting)`]
      : []),
  ].join("\n");
}
