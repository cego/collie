import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Schema, Semaphore } from "effect";
import { readStepLines, type StepLine } from "./steps";
import { epochMs } from "./time";

const Sample = Schema.Struct({
  workflow: Schema.String,
  step: Schema.String,
  run: Schema.String,
  key: Schema.String,
  at: Schema.String,
  ms: Schema.Finite,
});
type Sample = typeof Sample.Type;
const Index = Schema.fromJsonString(Schema.Array(Sample));
const lock = Semaphore.makeUnsafe(1);
const file = (dir: string) => `${dir}/step-durations.json`;
const read = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(file(dir)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Index)),
      Effect.orElseSucceed(() => null),
    );
  });
const samples = (run: string, workflow: string, lines: ReadonlyArray<StepLine>): Sample[] =>
  Arr.flatMap(lines, (line) => {
    if (line.kind !== "leave") return [];
    const entered = Option.getOrUndefined(
      Arr.findFirst(lines, (one) => one.kind === "enter" && one.key === line.key),
    );
    if (entered?.kind !== "enter") return [];
    const ms = epochMs(line.at) - epochMs(entered.at);
    return Number.isFinite(ms) && ms >= 0
      ? [{ workflow, step: entered.step.id, run, key: line.key, at: line.at, ms }]
      : [];
  });
const latest = (all: ReadonlyArray<Sample>) => {
  const kept: Sample[] = [];
  for (const one of [...all].sort((a, b) => pipe_(b.at, Str.localeCompare(a.at)))) {
    if (Arr.some(kept, (other) => other.run === one.run && other.key === one.key)) continue;
    if (
      Arr.filter(kept, (other) => other.workflow === one.workflow && other.step === one.step)
        .length < 10
    )
      kept.push(one);
  }
  return kept;
};
const write = (dir: string, values: ReadonlyArray<Sample>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${file(dir)}.tmp`,
      yield* Schema.encodeEffect(Index)(latest(values)).pipe(Effect.orDie),
    );
    yield* fs.rename(`${file(dir)}.tmp`, file(dir));
  }).pipe(Effect.orDie);

/** Rebuild once when absent; board reads never visit historical Run records. */
export const ensureStepDurations = (
  dir: string,
  runs: ReadonlyArray<{ readonly run: string; readonly workflow: string }>,
) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      if ((yield* read(dir)) !== null) return;
      const all = yield* Effect.forEach(runs, (run) =>
        readStepLines(`${dir}/runs/${run.run}`).pipe(
          Effect.map((lines) => samples(run.run, run.workflow, lines)),
        ),
      );
      yield* write(dir, all.flat());
    }),
  );
export const rememberStepDurations = (
  dir: string,
  run: string,
  workflow: string,
  lines: ReadonlyArray<StepLine>,
) =>
  lock.withPermits(1)(
    Effect.gen(function* () {
      yield* write(dir, [...((yield* read(dir)) ?? []), ...samples(run, workflow, lines)]);
    }),
  );
export const usualStepTimes = (dir: string, workflow: string) =>
  Effect.gen(function* () {
    const all = Arr.filter((yield* read(dir)) ?? [], (one) => one.workflow === workflow);
    const usual = new Map<string, number>();
    for (const step of new Set(Arr.map(all, (one) => one.step))) {
      const values = Arr.map(
        Arr.filter(all, (one) => one.step === step),
        (one) => one.ms,
      ).sort((a, b) => a - b);
      if (values.length < 3) continue;
      const middle = Math.floor(values.length / 2);
      usual.set(
        step,
        values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!,
      );
    }
    return usual;
  });
