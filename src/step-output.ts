import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Clock, Duration, Effect, FileSystem, Schedule, Schema } from "effect";
import type { Launched } from "./launches";
import { stemOf } from "./launches";
import type { RunRecordsApi } from "./run-records";

export const ACCEPTED = "accepted/";
export const COLLECTED = "collected/";
export const CARRIED = "carried/";

export const acceptedName = (output: string) =>
  `${ACCEPTED}${output.slice(output.lastIndexOf("/") + 1)}`;

export const collectedName = (output: string) =>
  `${COLLECTED}${output.slice(output.lastIndexOf("/") + 1)}`;

export const carriedName = (output: string) =>
  `${CARRIED}${output.slice(output.lastIndexOf("/") + 1)}`;

const Accepted = Schema.Struct({
  text: Schema.String,
  at: Schema.Finite,
  dispatch: Schema.optionalKey(Schema.String),
});
const AcceptedJson = Schema.fromJsonString(Accepted);
const decodeAccepted = Schema.decodeOption(AcceptedJson);
const encodeAccepted = Schema.encodeSync(AcceptedJson);

export interface StepOutput {
  readonly text: string;
  readonly at: number;
  readonly file: boolean;
}

export type Step = Pick<Launched, "runId" | "output"> & {
  readonly submitOnly?: boolean;
  readonly dispatch?: string;
  readonly operation?: string;
  readonly sequence?: number;
  readonly at?: number;
};

// WARNING: The clock a harness is stamped with is not the host's, so a dispatch is named by what the record fixes.
export const dispatchOf = (launched: { operation: string; sequence?: number; at?: number }) =>
  `${stemOf(launched)}@${launched.at ?? 0}`;

const stampOf = (dispatch: string | undefined) => {
  if (dispatch === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  const at = Option.getOrElse(Str.lastIndexOf("@")(dispatch), () => -1);
  const digits = Str.slice(at + 1)(dispatch);
  const value = Number(digits);
  return Str.trim(digits) === "" || Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
};

const newer = (ours: string | undefined, held: string | undefined) =>
  ours !== undefined && stampOf(ours) > stampOf(held);

const dispatchIn = (step: Step) =>
  step.dispatch ??
  (step.operation === undefined || step.at === undefined
    ? undefined
    : dispatchOf({ operation: step.operation, sequence: step.sequence, at: step.at }));

export const stepOf = (
  launches: ReadonlyArray<Launched>,
  runId: string,
  operation: string,
  output: string,
): Step => {
  const dispatched = Option.getOrNull(Arr.findLast(launches, (one) => one.operation === operation));
  return dispatched === null
    ? { runId, output, submitOnly: true }
    : { ...dispatched, dispatch: dispatchOf(dispatched) };
};

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
    const dispatch = dispatchIn(step);
    const ours =
      Option.isSome(accepted) &&
      (accepted.value.dispatch === undefined ||
        dispatch === undefined ||
        accepted.value.dispatch === dispatch);
    if (Option.isSome(accepted) && ours) {
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

export const acceptedIn = (data: string) => Option.getOrNull(decodeAccepted(data));

export const acceptedText = (data: string) => acceptedIn(data)?.text ?? data;

export const recordOutput = Effect.fn("StepOutput.record")(function* (
  records: RunRecordsApi,
  step: Step,
  text: string,
) {
  const at = yield* Clock.currentTimeMillis;
  const accepted = {
    text,
    at,
    ...(step.dispatch === undefined ? {} : { dispatch: step.dispatch }),
  };
  yield* records.put(step.runId, acceptedName(step.output), encodeAccepted(accepted));
});
const retrying = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  // WARNING: another connection may hold the database for a moment, and a refusal must not lose an accepted Output.
  effect.pipe(Effect.retry({ times: 20, schedule: Schedule.spaced(Duration.millis(50)) }));

export const submitFor = Effect.fn("StepOutput.submit")(function* (
  records: RunRecordsApi,
  step: Step,
  text: string,
) {
  const at = yield* Clock.currentTimeMillis;
  const offered = encodeAccepted({
    text,
    at,
    ...(dispatchIn(step) === undefined ? {} : { dispatch: dispatchIn(step) }),
  });
  const held = yield* retrying(
    records.update(step.runId, acceptedName(step.output), (was) =>
      Effect.succeed(
        Option.match(was === null ? Option.none() : decodeAccepted(was), {
          onNone: () => offered,
          onSome: (prev) => (newer(dispatchIn(step), prev.dispatch) ? offered : was!),
        }),
      ),
    ),
  );
  return Option.getOrNull(decodeAccepted(held ?? ""));
});

const Carried = Schema.Struct({ text: Schema.String, at: Schema.Finite, from: Schema.String });

export const recordCarried = Effect.fn("StepOutput.carry")(function* (
  records: RunRecordsApi,
  step: Pick<Step, "runId" | "output">,
  text: string,
  from: string,
) {
  const at = yield* Clock.currentTimeMillis;
  yield* records.put(
    step.runId,
    carriedName(step.output),
    Schema.encodeSync(Schema.fromJsonString(Carried))({ text, at, from }),
  );
});

export const carriedFor = Effect.fn("StepOutput.carried")(function* (
  records: RunRecordsApi,
  step: Pick<Step, "runId" | "output">,
) {
  const fact = yield* records.fact(step.runId, carriedName(step.output));
  return fact === null
    ? null
    : Option.getOrNull(Schema.decodeOption(Schema.fromJsonString(Carried))(fact));
});

export const acceptedFor = Effect.fn("StepOutput.acceptedFor")(function* (
  records: RunRecordsApi,
  step: Step,
) {
  const fact = yield* records.fact(step.runId, acceptedName(step.output));
  return fact === null ? null : Option.getOrNull(decodeAccepted(fact));
});

export const collectedFor = Effect.fn("StepOutput.collectedFor")(function* (
  records: RunRecordsApi,
  step: Step,
) {
  const fact = yield* records.fact(step.runId, collectedName(step.output));
  return fact === null ? null : Option.getOrNull(decodeAccepted(fact));
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
  const offered = { text, at, ...(step.dispatch === undefined ? {} : { dispatch: step.dispatch }) };
  // WARNING: another connection may hold the database for a moment, and a refusal must not lose an accepted Output.
  const held = yield* records
    .update(step.runId, acceptedName(step.output), (was) =>
      Effect.succeed(was !== null ? was : encodeAccepted(offered)),
    )
    .pipe(Effect.retry({ times: 20, schedule: Schedule.spaced(Duration.millis(50)) }));
  const accepted = held === null ? Option.none() : decodeAccepted(held);
  return Option.isSome(accepted) ? accepted.value.text : text;
});
