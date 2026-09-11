// What became of a Run's work, which is not how the Run's execution ended.
//
// A Run that failed still failed. When a human then finishes the work by hand and merges
// it, there are two wrong things to do with that fact and they are wrong in opposite
// directions: leave the board showing a red row against work that shipped, or edit the
// Run's status to tidy the row and lose what actually happened. So this is recorded
// beside the status and never over it — append-only, in the Run's own directory, with the
// reference that backs it up.
//
// Nothing here is inferred. Collie does not decide that an MR it did not open was this
// Run's work; a person says so, and the record says who and when.

import { Effect, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";

/**
 * `merged` is the work landed by some other route. `abandoned` is a decision not to land
 * it. `superseded` names the Run that carried the work instead. There is deliberately no
 * value meaning "actually it succeeded": the execution record is not editable from here.
 */
const KindSchema = Schema.Literals(["merged", "abandoned", "superseded"]);
export type DispositionKind = Schema.Schema.Type<typeof KindSchema>;

const RecordSchema = Schema.Struct({
  at: Schema.String,
  by: Schema.String,
  kind: KindSchema,
  /** What backs it up: a merge request, a commit, or the Run that took the work over. */
  ref: Schema.String,
  note: Schema.NullOr(Schema.String),
});
export type Disposition = Schema.Schema.Type<typeof RecordSchema>;
const RecordJson = Schema.fromJsonString(RecordSchema);

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
