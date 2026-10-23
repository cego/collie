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
        .writeFileString(`${dir}/step-steering.json.tmp`, Schema.encodeSync(json)(next.state))
        .pipe(Effect.orDie);
      yield* fs
        .rename(`${dir}/step-steering.json.tmp`, `${dir}/step-steering.json`)
        .pipe(Effect.orDie);
      return next.value;
    }),
  );

export const stepTarget = Effect.fn("StepSteering.target")(function* (dir: string, id: string) {
  const lines = yield* readStepLines(dir);
  const latest = lines.findLast((one) => one.kind === "forecast");
  const entered = lines.findLast((one) => one.kind === "enter" && one.step.id === id);
  const meta = latest?.kind === "forecast" ? latest.steps.find((one) => one.id === id) : undefined;
  const step = meta ?? (entered?.kind === "enter" ? entered.step : undefined);
  if (step === undefined) return { refused: `No Step ${id} is declared by this Run` } as const;
  if (
    entered?.kind === "enter" &&
    lines.some((one) => one.kind === "leave" && one.key === entered.key)
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
      const pause = { step, by, at: yield* nowIso() };
      return {
        state: {
          ...state,
          pauses: [...state.pauses.filter((one) => one.step !== step), ...(armed ? [pause] : [])],
        },
        value: undefined,
      };
    }),
  );
export const reachPause = (dir: string, step: string) =>
  change(dir, (state) =>
    Effect.succeed({
      state: state.pauses.some((one) => one.step === step)
        ? {
            ...state,
            pauses: state.pauses.filter((one) => one.step !== step),
            reached: state.pauses.find((one) => one.step === step)!,
          }
        : state,
      value: state.pauses.find((one) => one.step === step) ?? null,
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
      if (state.notes.some((one) => one.id === note.id)) return { state, value: undefined };
      return {
        state: { ...state, notes: [...state.notes, { ...note, at: yield* nowIso(), read: null }] },
        value: undefined,
      };
    }),
  );
export const withdrawStepNote = (dir: string, id: string) =>
  change(dir, (state) =>
    Effect.succeed({
      state: { ...state, notes: state.notes.filter((one) => one.id !== id || one.read !== null) },
      value: state.notes.some((one) => one.id === id && one.read === null),
    }),
  );
export const takeStepNotes = (dir: string, step: string, prompt: string) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      const at = yield* nowIso();
      const notes = state.notes.map((one) =>
        one.step === step && one.read === null ? { ...one, read: at, prompt } : one,
      );
      return {
        state: { ...state, notes },
        value: notes
          .filter((one) => one.prompt === prompt)
          .map((one) => one.text)
          .join("\n\n"),
      };
    }),
  );
export const readStepNote = (dir: string, id: string) =>
  change(dir, (state) =>
    Effect.gen(function* () {
      const at = yield* nowIso();
      return {
        state: {
          ...state,
          notes: state.notes.map((one) => (one.id === id ? { ...one, read: at } : one)),
        },
        value: undefined,
      };
    }),
  );
