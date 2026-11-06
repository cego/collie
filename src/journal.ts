// Append-only JSONL, read and written the one way every journal here needs.
//
// A half-written *last* line is skipped rather than failing the read: an append
// interrupted mid-write is exactly the crash these journals exist to survive. An
// undecodable line anywhere else is not that — nothing appends into the middle of a file
// — so it is corruption, and `corrupt` is how a caller that must fail closed finds out.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Option, Path, Schema } from "effect";

export interface Journal<A> {
  readonly lines: A[];
  /** Undecodable lines that were not the last: corruption, not an interrupted append. */
  readonly corrupt: number;
}

const textsOf = (raw: string) => Arr.filter(Str.split(raw, "\n"), (text) => Str.trim(text) !== "");

const tally = <A>(decoded: ReadonlyArray<Option.Option<A>>): Journal<A> => {
  const lines: A[] = [];
  let corrupt = 0;
  for (const [at, one] of decoded.entries()) {
    if (one._tag === "Some") lines.push(one.value);
    else if (at < decoded.length - 1) corrupt += 1;
  }
  return { lines, corrupt };
};

export const readJournalWhole = Effect.fn("Journal.readWhole")(function* <A>(
  file: string,
  json: Schema.Codec<A, string, never, never>,
): Effect.fn.Return<Journal<A>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const decode = Schema.decodeUnknownOption(json);
  // A line at a time, so a long journal is read in the scheduler's turns.
  return tally(yield* Effect.forEach(textsOf(raw), (text) => Effect.sync(() => decode(text))));
});

export const journalOf = <A>(
  raw: string,
  json: Schema.Codec<A, string, never, never>,
): Journal<A> => {
  const decode = Schema.decodeUnknownOption(json);
  return tally(Arr.map(textsOf(raw), (text) => decode(text)));
};

export const readJournal = <A>(file: string, json: Schema.Codec<A, string, never, never>) =>
  readJournalWhole(file, json).pipe(Effect.map((journal) => journal.lines));

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
