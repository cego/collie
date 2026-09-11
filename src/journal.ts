// Append-only JSONL, read and written the one way every journal here needs.
//
// A half-written *last* line is skipped rather than failing the read: an append
// interrupted mid-write is exactly the crash these journals exist to survive. An
// undecodable line anywhere else is not that — nothing appends into the middle of a file
// — so it is corruption, and `corrupt` is how a caller that must fail closed finds out.

import { Effect, FileSystem, Path, Schema } from "effect";

export interface Journal<A> {
  readonly lines: A[];
  /** Undecodable lines that were not the last: corruption, not an interrupted append. */
  readonly corrupt: number;
}

export const readJournalWhole = Effect.fn("Journal.readWhole")(function* <A>(
  file: string,
  json: Schema.Codec<A, string, never, never>,
): Effect.fn.Return<Journal<A>, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  const decode = Schema.decodeUnknownOption(json);
  const texts = raw.split("\n").filter((text) => text.trim() !== "");
  const lines: A[] = [];
  let corrupt = 0;
  for (const [at, text] of texts.entries()) {
    const decoded = decode(text);
    if (decoded._tag === "Some") lines.push(decoded.value);
    else if (at < texts.length - 1) corrupt += 1;
  }
  return { lines, corrupt };
});

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
  yield* fs.writeFileString(file, `${Schema.encodeSync(json)(line)}\n`, { flag: "a" });
});
