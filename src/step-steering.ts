import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema, Semaphore } from "effect";
import { readStepLines } from "./steps";
import { nowIso } from "./time";

export const StepPause = Schema.Struct({
  step: Schema.String,
  by: Schema.String,
  at: Schema.String,
});
export const StepNote = Schema.Struct({
  id: Schema.String,
  step: Schema.String,
  by: Schema.String,
  at: Schema.String,
  text: Schema.String,
  read: Schema.NullOr(Schema.String),
  prompt: Schema.optional(Schema.String),
});
const State = Schema.Struct({
  pauses: Schema.Array(StepPause),
  reached: Schema.NullOr(StepPause),
  notes: Schema.Array(StepNote).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});
type State = typeof State.Type;
const json = Schema.fromJsonString(State);
const lock = Semaphore.makeUnsafe(1);
const empty: State = { pauses: [], reached: null, notes: [] };
export const readStepSteering = Effect.fn("StepSteering.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${dir}/step-steering.json`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(json)),
    Effect.orElseSucceed(() => empty),
  );
});
const change = <A>(
  dir: string,
  edit: (state: State) => Effect.Effect<{ state: State; value: A }>,
) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const next = yield* edit(yield* readStepSteering(dir));
      yield* fs
        .writeFileString(
          `${dir}/step-steering.json.tmp`,
          yield* Schema.encodeEffect(json)(next.state).pipe(Effect.orDie),
        )
        .pipe(Effect.orDie);
      yield* fs
        .rename(`${dir}/step-steering.json.tmp`, `${dir}/step-steering.json`)
        .pipe(Effect.orDie);
      return next.value;
    }),
  );

export const stepTarget = Effect.fn("StepSteering.target")(function* (dir: string, id: string) {
  const lines = yield* readStepLines(dir);
  const latest = Option.getOrUndefined(Arr.findLast(lines, (one) => one.kind === "forecast"));
  const entered = Option.getOrUndefined(
    Arr.findLast(lines, (one) => one.kind === "enter" && one.step.id === id),
  );
  const meta =
    latest?.kind === "forecast"
      ? Option.getOrUndefined(Arr.findFirst(latest.steps, (one) => one.id === id))
      : undefined;
  const step = meta ?? (entered?.kind === "enter" ? entered.step : undefined);
  if (step === undefined) return { refused: `No Step ${id} is declared by this Run` } as const;
  if (
    entered?.kind === "enter" &&
    Arr.some(lines, (one) => one.kind === "leave" && one.key === entered.key)
  ) {
    const place = entered.place;
    const repeats =
      place !== null &&
      ("item" in place
        ? place.items.indexOf(place.item) < place.items.length - 1
        : place.of === null || place.round < place.of);
    if (!repeats)
      return { refused: `Step ${id} has already been left and will not run again` } as const;
  }
  return { step } as const;
});

export const pauseBefore = (dir: string, step: string, by: string, armed: boolean) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      const pause = { step, by, at: yield* nowIso };
      return {
        state: {
          ...state,
          pauses: [
            ...Arr.filter(state.pauses, (one) => one.step !== step),
            ...(armed ? [pause] : []),
          ],
        },
        value: undefined,
      };
    }),
  );
export const reachPause = (dir: string, step: string) =>
  change(dir, (state) =>
    Effect.succeed({
      state: Arr.some(state.pauses, (one) => one.step === step)
        ? {
            ...state,
            pauses: Arr.filter(state.pauses, (one) => one.step !== step),
            reached: Option.getOrUndefined(
              Arr.findFirst(state.pauses, (one) => one.step === step),
            )!,
          }
        : state,
      value: Option.getOrUndefined(Arr.findFirst(state.pauses, (one) => one.step === step)) ?? null,
    }),
  );
export const clearReachedPause = (dir: string) =>
  change(dir, (state) => Effect.succeed({ state: { ...state, reached: null }, value: undefined }));

export const leaveStepNote = (
  dir: string,
  note: { id: string; step: string; by: string; text: string },
) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      if (Arr.some(state.notes, (one) => one.id === note.id)) return { state, value: undefined };
      return {
        state: { ...state, notes: [...state.notes, { ...note, at: yield* nowIso, read: null }] },
        value: undefined,
      };
    }),
  );
export const withdrawStepNote = (dir: string, id: string) =>
  change(dir, (state) =>
    Effect.succeed({
      state: {
        ...state,
        notes: Arr.filter(state.notes, (one) => one.id !== id || one.read !== null),
      },
      value: Arr.some(state.notes, (one) => one.id === id && one.read === null),
    }),
  );
export const takeStepNotes = (dir: string, step: string, prompt: string) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const notes = Arr.map(state.notes, (one) =>
        one.step === step && one.read === null ? { ...one, read: at, prompt } : one,
      );
      return {
        state: { ...state, notes },
        value: Arr.join(
          Arr.map(
            Arr.filter(notes, (one) => one.prompt === prompt),
            (one) => one.text,
          ),
          "\n\n",
        ),
      };
    }),
  );
export const readStepNote = (dir: string, id: string) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      return {
        state: {
          ...state,
          notes: Arr.map(state.notes, (one) => (one.id === id ? { ...one, read: at } : one)),
        },
        value: undefined,
      };
    }),
  );
