// WARNING: A half-written last line is skipped; an undecodable line elsewhere is corruption, not an interrupted append.
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { addressOf, RunRecords } from "./run-records";

export interface Journal<A> {
  readonly lines: Array<A>;
  readonly corrupt: number;
}

const textsOf = (raw: string) => Arr.filter(Str.split(raw, "\n"), (text) => Str.trim(text) !== "");

const tally = <A>(decoded: ReadonlyArray<Option.Option<A>>) => {
  const lines: Array<A> = [];
  let corrupt = 0;
  for (const [at, one] of decoded.entries()) {
    if (one._tag === "Some") {
      lines.push(one.value);
    } else if (at < decoded.length - 1) {
      corrupt += 1;
    }
  }
  return { lines, corrupt };
};

export const readJournalWhole = Effect.fn("Journal.readWhole")(function* <A>(
  file: string,
  json: Schema.Codec<A, string, never, never>,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const decode = Schema.decodeUnknownOption(json);
  return tally(yield* Effect.forEach(textsOf(raw), (text) => Effect.sync(() => decode(text))));
});

export const journalOf = <A>(raw: string, json: Schema.Codec<A, string, never, never>) => {
  const decode = Schema.decodeUnknownOption(json);
  return tally(Arr.map(textsOf(raw), (text) => decode(text)));
};

export const readJournal = <A>(file: string, json: Schema.Codec<A, string, never, never>) =>
  readJournalWhole(file, json).pipe(Effect.map((journal) => journal.lines));

export const lastRunJournal = Effect.fn("Journal.lastRun")(function* <A>(
  at: RunJournal,
  json: Schema.Codec<A, string, never, never>,
  kinds: ReadonlyArray<string> | null,
) {
  const newest =
    (yield* RunRecords.use((records) => records.lastOf([at.run], at.name, kinds))).get(at.run) ??
    [];
  const decode = Schema.decodeUnknownOption(json);
  for (const line of newest) {
    const read = decode(line);
    if (Option.isSome(read)) {
      return read;
    }
  }
  return Option.none<A>();
});

export const appendJournal = Effect.fn("Journal.append")(function* <A>(
  file: string,
  json: Schema.Codec<A, string, never, never>,
  line: A,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(
    file,
    `${yield* Schema.encodeEffect(json)(line).pipe(Effect.orDie)}\n`,
    { flag: "a" },
  );
});

export interface RunJournal {
  readonly run: string;
  readonly name: string;
}

export const runJournal = (dir: string, path: string) => {
  const at = addressOf(dir);
  return { run: at.run, name: `${at.prefix}${path}` };
};

const textsAt = (at: RunJournal) => RunRecords.use((records) => records.lines(at.run, at.name));

export const readRunJournalWhole = Effect.fn("Journal.readRunWhole")(function* <A>(
  at: RunJournal,
  json: Schema.Codec<A, string, never, never>,
) {
  const decode = Schema.decodeUnknownOption(json);
  return tally(
    yield* Effect.forEach(yield* textsAt(at), (text) => Effect.sync(() => decode(text))),
  );
});

export const readRunJournal = <A>(at: RunJournal, json: Schema.Codec<A, string, never, never>) =>
  readRunJournalWhole(at, json).pipe(Effect.map((journal) => journal.lines));

export const readBriefsOf = Effect.fn("Journal.readBriefsOf")(function* <A>(
  runs: ReadonlyArray<string>,
  name: string,
  json: Schema.Codec<A, string, never, never>,
) {
  const decode = Schema.decodeUnknownOption(json);
  const briefs = yield* RunRecords.use((records) => records.briefsOf(runs, name));
  return Arr.flatMap(
    runs,
    (run) => tally(Arr.map(briefs.get(run) ?? [], (one) => decode(one))).lines,
  );
});

export const findLastRunJournal = Effect.fn("Journal.findLastRun")(function* <A>(
  at: RunJournal,
  json: Schema.Codec<A, string, never, never>,
  matches: (record: A) => boolean,
) {
  const lines = yield* textsAt(at);
  const decode = Schema.decodeUnknownOption(json);
  for (let i = lines.length - 1; i >= 0; i--) {
    const read = yield* Effect.sync(() => decode(lines[i]));
    if (read._tag === "Some" && matches(read.value)) {
      return read;
    }
  }
  return Option.none<A>();
});

export const appendRunJournal = Effect.fn("Journal.appendRun")(function* <A>(
  at: RunJournal,
  json: Schema.Codec<A, string, never, never>,
  line: A,
) {
  const text = yield* Schema.encodeEffect(json)(line).pipe(Effect.orDie);
  yield* RunRecords.use((records) => records.append(at.run, at.name, [text]));
});
