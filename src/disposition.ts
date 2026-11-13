// What became of a Run's work, which is not how the Run's execution ended.
//
// A Run that failed still failed. When a human then finishes the work by hand and merges
// it, there are two wrong things to do with that fact and they are wrong in opposite
// directions: leave the board showing a red row against work that shipped, or edit the
// Run's status to tidy the row and lose what actually happened. So this is recorded
// beside the status and never over it — append-only, in the Run's own directory, with the
// reference that backs it up.
//
// Nothing here is guessed. A person records one, or the merge watch does when the Task's
// merge request merged — the one a Run recorded, else the one opened from the Task's own
// branch, whoever opened it — and the record says who and when.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Effect, Path, Schema } from "effect";
import { Disposition } from "./board-model";
import { appendJournal, readJournal } from "./journal";

const RecordJson = Schema.fromJsonString(Disposition);

export const dispositionPath = Effect.fn("Disposition.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "steering", "disposition.jsonl");
});

export const recordDisposition = Effect.fn("Disposition.record")(function* (
  runDir: string,
  line: Disposition,
) {
  yield* appendJournal(yield* dispositionPath(runDir), RecordJson, line);
});

export const readDispositions = Effect.fn("Disposition.read")(function* (runDir: string) {
  return yield* readJournal(yield* dispositionPath(runDir), RecordJson);
});

/** The words of a ref, any of which may be a Run's id. */
export const refWords = (ref: string) => Str.split(ref, /[\s;,]+/);

export const qualifiedRuns = (ref: string) =>
  Arr.flatMap(refWords(ref), (word) => {
    const match = /^([^:/]+):(run-[\w.-]+)$/.exec(word);
    return match === null ? [] : [{ machine: match[1]!, run: match[2]! }];
  });

/** The Runs a ref names on `machine`: bare, or `<machine>:<run>` by it or its first label. */
export const refRuns = (ref: string, machine: string) => {
  const names = new Set([machine, Str.split(machine, ".")[0]!]);
  return Arr.flatMap(refWords(ref), (word) => {
    const colon = Option.getOrElse(Str.indexOf(":")(word), () => -1);
    if (colon < 0) return [word];
    return names.has(Str.slice(0, colon)(word)) ? [Str.slice(colon + 1)(word)] : [];
  });
};

/**
 * The current answer, which is the last one given. A correction is a new line rather than
 * an edit, so the history of what people believed happened is itself kept.
 */
export function latest(lines: ReadonlyArray<Disposition>): Disposition | null {
  return lines.length === 0 ? null : lines[lines.length - 1]!;
}

/**
 * One line for a human, holding both facts at once. The execution status comes first
 * because it is what happened; the delivery follows because it is what came of it.
 */
export function statusLine(status: string, line: Disposition | null): string {
  if (line === null) return status;
  const where = line.ref === "" ? "" : ` ${line.ref}`;
  return `${status} · ${line.kind}${where} by ${line.by}`;
}
