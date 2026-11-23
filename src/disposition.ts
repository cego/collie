import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Effect, Schema } from "effect";
import { Disposition } from "./board-model";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";

const RecordJson = Schema.fromJsonString(Disposition);

export const dispositionPath = (runDir: string) => runJournal(runDir, "steering/disposition.jsonl");

export const recordDisposition = Effect.fn("Disposition.record")(function* (
  runDir: string,
  line: Disposition,
) {
  yield* appendRunJournal(dispositionPath(runDir), RecordJson, line);
});

export const readDispositions = Effect.fn("Disposition.read")(function* (runDir: string) {
  return yield* readRunJournal(dispositionPath(runDir), RecordJson);
});

export const refWords = (ref: string) => Str.split(ref, /[\s;,]+/);

export const qualifiedRuns = (ref: string) =>
  Arr.flatMap(refWords(ref), (word) => {
    const match = /^([^:/]+):(run-[\w.-]+)$/.exec(word);
    return match === null ? [] : [{ machine: match[1]!, run: match[2]! }];
  });

export const refRuns = (ref: string, machine: string) => {
  const names = new Set([machine, Str.split(machine, ".")[0]]);
  return Arr.flatMap(refWords(ref), (word) => {
    const colon = Option.getOrElse(Str.indexOf(":")(word), () => -1);
    if (colon < 0) return [word];
    return names.has(Str.slice(0, colon)(word)) ? [Str.slice(colon + 1)(word)] : [];
  });
};

// WARNING: a correction is a new line rather than an edit, so the history of what people believed is kept.
export function latest(lines: ReadonlyArray<Disposition>) {
  return lines.length === 0 ? null : lines.at(-1)!;
}

export function statusLine(status: string, line: Disposition | null) {
  if (line === null) return status;
  const where = line.ref === "" ? "" : ` ${line.ref}`;
  return `${status} · ${line.kind}${where} by ${line.by}`;
}
