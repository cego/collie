import { Context, Effect, Schema, flow, Result } from "effect";
import { RunRecords, runOfDir, STEPS } from "./run-records";

export const StepKind = Schema.Literals(["agent", "question", "workflow", "check"]);
export type StepKind = typeof StepKind.Type;

export const Produces = Schema.Literals(["plan", "review", "evidence", "merge-request"]);
export type Produces = typeof Produces.Type;

export const StepMeta = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.String,
  kind: StepKind,
  role: Schema.NullOr(Schema.String),
  produces: Schema.NullOr(Produces),
});
export type StepMeta = typeof StepMeta.Type;

export const StepPlace = Schema.Union([
  Schema.Struct({ round: Schema.Int, of: Schema.NullOr(Schema.Int) }),
  Schema.Struct({ item: Schema.String, items: Schema.Array(Schema.String) }),
]);
export type StepPlace = typeof StepPlace.Type;

export interface At {
  readonly step: string;
  readonly place: StepPlace | null;
  readonly key: string;
}

export const CurrentStep = Context.Reference<At | null>("collie/CurrentStep", {
  defaultValue: () => null,
});

export const runKey = (id: string, place: StepPlace | null, call: number) => {
  if (place === null) return call > 1 ? `${id}~${call}` : id;
  return "item" in place ? `${id}@${place.item}` : `${id}#${place.round}`;
};

const Line = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ ...fields, at: Schema.String });

export const StepLine = Schema.Union([
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
  Line({
    kind: Schema.Literal("entry"),
    cause: Schema.NullOr(Schema.Literals(["restarted", "resumed"])),
  }),
  Line({ kind: Schema.Literal("question"), key: Schema.String, name: Schema.String }),
  Line({ kind: Schema.Literal("child"), key: Schema.String, run: Schema.String }),
  Line({ kind: Schema.Literal("check"), key: Schema.String, name: Schema.String }),
]);
export type StepLine = typeof StepLine.Type;

export type StepNote = StepLine extends infer L
  ? L extends StepLine
    ? Omit<L, "at">
    : never
  : never;

export const STEPS_FILE = STEPS;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(StepLine));
const encodeLine = flow(Schema.encodeResult(Schema.fromJsonString(StepLine)), Result.getOrThrow);

export const encodeStepLine = (line: StepLine) => encodeLine(line);

export const readStepLines = Effect.fn("Steps.read")(function* (runDir: string) {
  const texts = yield* RunRecords.use((records) => records.lines(runOfDir(runDir), STEPS_FILE));
  const lines: StepLine[] = [];
  // WARNING: read a line at a time, so a long Run is read in the scheduler's turns.
  for (const text of texts) {
    const read = yield* Effect.sync(() => decodeLine(text));
    if (read._tag === "Some") lines.push(read.value);
  }
  return lines;
});

export const appendStepLine = (runDir: string, line: StepLine) =>
  RunRecords.use((records) => records.append(runOfDir(runDir), STEPS_FILE, [encodeLine(line)]));
