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
//
// One journal per Herd; receipts are per conversation (CONTEXT.md, News).

import { Effect, FileSystem, Path, Schema } from "effect";
import { NEWS_BATCH, NewsReceipt, Significance } from "./board-model";
import { appendJournal, readJournal } from "./journal";
import { herdDir } from "./steering";
import { nowIso } from "./time";

/** How many items the journal keeps. Old news nobody read is still not worth unbounded disk. */
export const KEEP = 200;

/** The Herd's Native chat, in its Home. */
export const NATIVE = "native";

const ItemSchema = Schema.Struct({
  /** What makes this news this news. `proactive.ts` mints it; a repeat is the same key. */
  key: Schema.String,
  run: Schema.String,
  /** The words a human reads. Built from the record, never written by a model. */
  text: Schema.String,
  at: Schema.String,
  /** Decided by rules over the cause (`proactive.ts`); an item written before it was is routine. */
  significance: Significance.pipe(Schema.withDecodingDefaultKey(Effect.succeed("routine"))),
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
    kind: NewsReceipt,
    key: Schema.String,
    /** Whose receipt: `NATIVE`, or another conversation such as `flock@pc`. */
    conversation: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(NATIVE))),
    at: Schema.String,
    note: Schema.optionalKey(Schema.String),
  }),
  /** Its cause no longer holds, so it is nobody's news any more. */
  Schema.Struct({ kind: Schema.Literal("superseded"), key: Schema.String, at: Schema.String }),
]);
type Line = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);

export const newsPath = Effect.fn("News.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "news.jsonl");
});

/** How many News reads a Herd's trail keeps: enough to answer a retried request. */
export const NEWS_TRAIL = 50;

/** Where a Herd's News reads are audited, apart from its other operations. */
export const newsTrail = Effect.fn("News.trail")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "news");
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
export function pending(
  lines: ReadonlyArray<Line>,
  conversation = NATIVE,
  bound = NEWS_BATCH,
): Batch {
  const all = live(lines)
    .filter((entry) => !entry.read.has(conversation))
    .map((entry) => entry.item);
  const kept = all.length > bound ? all.slice(-bound) : all;
  return { items: kept, omitted: all.length - kept.length };
}

interface Entry {
  readonly item: Item;
  /** The conversations that read it, and those whose send of it nobody can account for. */
  readonly read: Set<string>;
  readonly uncertain: Set<string>;
}

/**
 * Every item not superseded, newest last, with its receipts. A key written again after it
 * was superseded is a new item with none.
 */
function live(lines: ReadonlyArray<Line>): ReadonlyArray<Entry> {
  const entries = new Map<string, Entry>();
  for (const line of lines) {
    if (line.kind === "item") {
      const { key, run, text, at, significance } = line;
      const item = { key, run, text, at, significance };
      entries.delete(line.key);
      entries.set(line.key, { item, read: new Set(), uncertain: new Set() });
      continue;
    }
    const entry = entries.get(line.key);
    if (entry === undefined) continue;
    if (line.kind === "superseded") entries.delete(line.key);
    else if (line.kind === "read") entry.read.add(line.conversation);
    else if (line.kind === "uncertain") entry.uncertain.add(line.conversation);
  }
  return [...entries.values()];
}

/**
 * Keys whose last item was superseded: a cause that holds again under one of these is
 * new news, whatever has been said before.
 */
export function retired(lines: ReadonlyArray<Line>): ReadonlySet<string> {
  const alive = new Set(live(lines).map((entry) => entry.item.key));
  return new Set(
    lines.flatMap((line) => (line.kind === "superseded" && !alive.has(line.key) ? [line.key] : [])),
  );
}

/** Items a send could not be accounted for, which stay a human's to look at. */
export function uncertain(
  lines: ReadonlyArray<Line>,
  conversation = NATIVE,
): ReadonlyArray<string> {
  return live(lines).flatMap((entry) =>
    entry.uncertain.has(conversation) && !entry.read.has(conversation) ? [entry.item.key] : [],
  );
}

/**
 * Write one piece of news down, unless this Herd already has it.
 *
 * Deduplicated here as well as by `proactive.ts`'s own memory, because the two answer
 * different questions: that one is "have I ever said this", and this one is "is it
 * already waiting". A restart that re-notices a halt must not queue it twice.
 */
export const append = Effect.fn("News.append")(function* (
  file: string,
  item: Omit<Item, "at" | "significance"> & { readonly significance?: Significance },
) {
  const lines = yield* read(file);
  if (live(lines).some((known) => known.item.key === item.key)) return false;
  yield* appendJournal(file, LineJson, {
    kind: "item",
    significance: "routine",
    ...item,
    at: yield* nowIso(),
  }).pipe(Effect.orDie);
  yield* trim(file);
  return true;
});

/** What became of an item, as its own line: the states are separate facts. */
export const settle = Effect.fn("News.settle")(function* (
  file: string,
  key: string,
  as: typeof NewsReceipt.Type,
  conversation: string,
  note?: string,
) {
  const at = yield* nowIso();
  const line: Line =
    note === undefined
      ? { kind: as, key, conversation, at }
      : { kind: as, key, conversation, at, note };
  yield* appendJournal(file, LineJson, line).pipe(Effect.orDie);
});

/** Retires every live item whose cause no longer holds, for every conversation; how many. */
export const supersede = Effect.fn("News.supersede")(function* (
  file: string,
  holds: (item: Item) => boolean,
) {
  const gone = live(yield* read(file)).filter((entry) => !holds(entry.item));
  for (const { item } of gone)
    yield* appendJournal(file, LineJson, {
      kind: "superseded",
      key: item.key,
      at: yield* nowIso(),
    }).pipe(Effect.orDie);
  return gone.length;
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
