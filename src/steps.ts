// What a Step is as data, and what the host records of one as a Run's work enters and leaves
// it (ADR-draft-a-step-is-declared-where-its-work-is-written D1–D4). The SDK's `step` makes
// one, and the Flow is built from these records.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { Context, Effect, FileSystem, Schema, flow, Result } from "effect";

export const StepKind = Schema.Literals(["agent", "question", "workflow", "check"]);
export type StepKind = typeof StepKind.Type;

export const Produces = Schema.Literals(["plan", "review", "evidence", "merge-request"]);
export type Produces = typeof Produces.Type;

/** What a reader needs of a Step before it runs. */
export const StepMeta = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  kind: StepKind,
  role: Schema.NullOr(Schema.String),
  produces: Schema.NullOr(Produces),
});
export type StepMeta = typeof StepMeta.Type;

/** Which of a Step's runs a call is: a round of so many, or an item of a list. */
export const StepPlace = Schema.Union([
  Schema.Struct({ round: Schema.Int, of: Schema.NullOr(Schema.Int) }),
  Schema.Struct({ item: Schema.String, items: Schema.Array(Schema.String) }),
]);
export type StepPlace = typeof StepPlace.Type;

/** The Step run the work is in now. `key` names that run within the Run. */
export interface At {
  readonly step: string;
  readonly place: StepPlace | null;
  readonly key: string;
}

export const CurrentStep = Context.Reference<At | null>("collie/CurrentStep", {
  defaultValue: () => null,
});

/** A Step run's key: its id and place, or its id and how many calls without one came before. */
export const runKey = (id: string, place: StepPlace | null, call: number): string => {
  if (place === null) return call > 1 ? `${id}~${call}` : id;
  return "item" in place ? `${id}@${place.item}` : `${id}#${place.round}`;
};

const Line = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ...fields, at: Schema.String });

export const StepLine = Schema.Union([
  /** The Steps the Run expects to take, in order. The latest one is the forecast. */
  Line({ kind: Schema.Literal("forecast"), steps: Schema.Array(StepMeta) }),
  Line({
    kind: Schema.Literal("enter"),
    key: Schema.String,
    step: StepMeta,
    place: Schema.NullOr(StepPlace),
    log: Schema.optional(Schema.Int),
  }),
  Line({ kind: Schema.Literal("leave"), key: Schema.String }),
  Line({ kind: Schema.Literal("fail"), key: Schema.String, why: Schema.String }),
  /** The Run's work was entered again; a cause says it went on with a Step left part-done. */
  Line({
    kind: Schema.Literal("entry"),
    cause: Schema.NullOr(Schema.Literals(["restarted", "resumed"])),
  }),
  Line({ kind: Schema.Literal("question"), key: Schema.String, name: Schema.String }),
  Line({ kind: Schema.Literal("child"), key: Schema.String, run: Schema.String }),
  Line({ kind: Schema.Literal("check"), key: Schema.String, name: Schema.String }),
]);
export type StepLine = typeof StepLine.Type;

/** A line as the workflow hands it over: the host stamps when. */
export type StepNote = StepLine extends infer L
  ? L extends StepLine
    ? Omit<L, "at">
    : never
  : never;

export const STEPS_FILE = "steps.jsonl";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(StepLine));
const encodeLine = flow(Schema.encodeResult(Schema.fromJsonString(StepLine)), Result.getOrThrow);

export const encodeStepLine = (line: StepLine): string => encodeLine(line);

/** What a Run's directory records of its Steps, in the order it was written. */
export const readStepLines = Effect.fn("Steps.read")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(`${runDir}/${STEPS_FILE}`)
    .pipe(Effect.orElseSucceed(() => ""));
  return Arr.flatMap(Str.split(text, "\n"), (line) => {
    const read = decodeLine(line);
    return read._tag === "Some" ? [read.value] : [];
  });
});
