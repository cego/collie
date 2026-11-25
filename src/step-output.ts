import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, Duration, Effect, FileSystem, Schedule, Schema } from "effect";
import type { Launched } from "./launches";
import type { RunRecordsApi } from "./run-records";

export const ACCEPTED = "accepted/";
export const COLLECTED = "collected/";

export const acceptedName = (output: string) =>
  `${ACCEPTED}${output.slice(output.lastIndexOf("/") + 1)}`;

export const collectedName = (output: string) =>
  `${COLLECTED}${output.slice(output.lastIndexOf("/") + 1)}`;

const Accepted = Schema.Struct({ text: Schema.String, at: Schema.Finite });
const AcceptedJson = Schema.fromJsonString(Accepted);
const decodeAccepted = Schema.decodeOption(AcceptedJson);
const encodeAccepted = Schema.encodeSync(AcceptedJson);

export interface StepOutput {
  readonly text: string;
  readonly at: number;
  readonly file: boolean;
}

export type Step = Pick<Launched, "runId" | "output"> & { readonly submitOnly?: boolean };

export const outputOf = Effect.fn("StepOutput.of")(function* (
  records: RunRecordsApi,
  step: Step,
  known?: ReadonlyArray<{ readonly name: string; readonly data: string }>,
) {
  const name = acceptedName(step.output);
  const fact =
    known === undefined
      ? yield* records.fact(step.runId, name)
      : (Option.getOrNull(Arr.findFirst(known, (one) => one.name === name))?.data ?? null);
  if (fact !== null) {
    const accepted = decodeAccepted(fact);
    if (Option.isSome(accepted)) {
      return {
        text: accepted.value.text,
        at: accepted.value.at,
        file: false,
      } satisfies StepOutput;
    }
  }
  if (step.submitOnly === true) {
    return null;
  }
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(step.output).pipe(Effect.orElseSucceed(() => null));
  if (info === null) {
    return null;
  }
  const text = yield* fs.readFileString(step.output).pipe(Effect.orElseSucceed(() => ""));
  // WARNING: a blank file is a write not yet happened.
  if (text.trim() === "") {
    return null;
  }
  return {
    text,
    at: Option.getOrUndefined(info.mtime)?.getTime() ?? 0,
    file: true,
  } satisfies StepOutput;
});

export const acceptedText = (data: string) =>
  Option.match(decodeAccepted(data), {
    onNone: () => data,
    onSome: (one) => one.text,
  });

export const recordOutput = Effect.fn("StepOutput.record")(function* (
  records: RunRecordsApi,
  step: Step,
  text: string,
) {
  const at = yield* Clock.currentTimeMillis;
  yield* records.put(step.runId, acceptedName(step.output), encodeAccepted({ text, at }));
});
export const uncollected = Effect.fn("StepOutput.uncollected")(function* (
  records: RunRecordsApi,
  step: Step,
) {
  const fact = yield* records.fact(step.runId, acceptedName(step.output));
  if (fact === null) {
    return false;
  }
  const collected = yield* records.fact(step.runId, collectedName(step.output));
  const accepted = decodeAccepted(fact);
  const taken = collected === null ? Option.none() : decodeAccepted(collected);
  if (Option.isNone(accepted)) {
    return false;
  }
  return Option.isNone(taken) || taken.value.at < accepted.value.at;
});

export const markCollected = Effect.fn("StepOutput.collected")(function* (
  records: RunRecordsApi,
  step: Step,
  text: string,
) {
  const fact = yield* records.fact(step.runId, acceptedName(step.output));
  if (fact !== null) {
    yield* records.put(step.runId, collectedName(step.output), fact);
  }
  return text;
});

export const acceptOutput = Effect.fn("StepOutput.accept")(function* (
  records: RunRecordsApi,
  step: Step,
  text: string,
) {
  const at = yield* Clock.currentTimeMillis;
  // WARNING: another connection may hold the database for a moment, and a refusal must not lose an accepted Output.
  const held = yield* records
    .update(step.runId, acceptedName(step.output), (was) =>
      Effect.succeed(was !== null ? was : encodeAccepted({ text, at })),
    )
    .pipe(Effect.retry({ times: 20, schedule: Schedule.spaced(Duration.millis(50)) }));
  const accepted = held === null ? Option.none() : decodeAccepted(held);
  return Option.isSome(accepted) ? accepted.value.text : text;
});
