import * as Arr from "effect/Array";
import { Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { NEWS_BATCH, NewsReceipt, Significance } from "./board-model";
import { appendJournal, readJournal } from "./journal";
import { herdDir } from "./steering";
import { nowIso } from "./time";

export const KEEP = 200;

export const NATIVE = "native";

const ItemSchema = Schema.Struct({
  key: Schema.String,
  run: Schema.String,
  text: Schema.String,
  at: Schema.String,
  significance: Significance.pipe(Schema.withDecodingDefaultKey(Effect.succeed("routine"))),
});
export type Item = Schema.Schema.Type<typeof ItemSchema>;

const LineSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("item"), ...ItemSchema.fields }),
  Schema.Struct({
    kind: NewsReceipt,
    key: Schema.String,
    conversation: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(NATIVE))),
    at: Schema.String,
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("superseded"), key: Schema.String, at: Schema.String }),
]);
type Line = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);

export const newsPath = Effect.fn("News.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "news.jsonl");
});

export const NEWS_TRAIL = 50;

export const newsTrail = Effect.fn("News.trail")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "news");
});

export const read = (file: string) =>
  readJournal(file, LineJson).pipe(Effect.orElseSucceed(() => []));

export interface Batch {
  readonly items: ReadonlyArray<Item>;
  readonly omitted: number;
}

export function pending(lines: ReadonlyArray<Line>, conversation = NATIVE, bound = NEWS_BATCH) {
  const all = Arr.map(
    Arr.filter(live(lines), (entry) => !entry.read.has(conversation)),
    (entry) => entry.item,
  );
  const kept = all.length > bound ? all.slice(-bound) : all;
  return { items: kept, omitted: all.length - kept.length };
}

interface Entry {
  readonly item: Item;
  readonly read: Set<string>;
  readonly uncertain: Set<string>;
}

function live(lines: ReadonlyArray<Line>) {
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

export function retired(lines: ReadonlyArray<Line>) {
  const alive = new Set(Arr.map(live(lines), (entry) => entry.item.key));
  return new Set(
    Arr.flatMap(lines, (line) =>
      line.kind === "superseded" && !alive.has(line.key) ? [line.key] : [],
    ),
  );
}

export function uncertain(lines: ReadonlyArray<Line>, conversation = NATIVE) {
  return Arr.flatMap(live(lines), (entry) =>
    entry.uncertain.has(conversation) && !entry.read.has(conversation) ? [entry.item.key] : [],
  );
}

export const append = Effect.fn("News.append")(function* (
  file: string,
  item: Omit<Item, "at" | "significance"> & { readonly significance?: Significance },
) {
  const lines = yield* read(file);
  if (Arr.some(live(lines), (known) => known.item.key === item.key)) return false;
  yield* appendJournal(file, LineJson, {
    kind: "item",
    significance: "routine",
    ...item,
    at: yield* nowIso,
  }).pipe(Effect.orDie);
  yield* trim(file);
  return true;
});

export const settle = Effect.fn("News.settle")(function* (
  file: string,
  key: string,
  as: typeof NewsReceipt.Type,
  conversation: string,
  note?: string,
) {
  const at = yield* nowIso;
  const line: Line =
    note === undefined
      ? { kind: as, key, conversation, at }
      : { kind: as, key, conversation, at, note };
  yield* appendJournal(file, LineJson, line).pipe(Effect.orDie);
});

export const supersede = Effect.fn("News.supersede")(function* (
  file: string,
  holds: (item: Item) => boolean,
) {
  const gone = Arr.filter(live(yield* read(file)), (entry) => !holds(entry.item));
  for (const { item } of gone)
    yield* appendJournal(file, LineJson, {
      kind: "superseded",
      key: item.key,
      at: yield* nowIso,
    }).pipe(Effect.orDie);
  return gone.length;
});

const trim = Effect.fn("News.trim")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const lines = yield* read(file);
  if (lines.length <= KEEP) return;
  const kept = lines.slice(-KEEP);
  const encode = flow(Schema.encodeResult(LineJson), Result.getOrThrow);
  const tmp = `${file}.${process.pid}.tmp`;
  yield* fs.writeFileString(
    tmp,
    Arr.join(
      Arr.map(kept, (line) => `${encode(line)}\n`),
      "",
    ),
  );
  yield* fs.rename(tmp, file);
});

export function asText(batch: Batch) {
  if (batch.items.length === 0) return "Nothing has happened that you have not seen.";
  return Arr.join(
    [
      ...Arr.map(batch.items, (item) => `- ${item.text}`),
      ...(batch.omitted > 0
        ? [`- (${batch.omitted} older item(s) not listed here; they are still waiting)`]
        : []),
    ],
    "\n",
  );
}
