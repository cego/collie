import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect } from "effect";
import type { ScheduleChange, ScheduleChanged, ScheduleListing } from "./schedule-model";

type DoorFailure = { readonly reason: string } | { readonly message: string };

export interface ScheduleDoor {
  readonly name: string;
  readonly schedules: Effect.Effect<ScheduleListing, DoorFailure>;
  readonly changeSchedule: (asked: {
    readonly change: ScheduleChange;
    readonly request: string;
  }) => Effect.Effect<ScheduleChanged, DoorFailure>;
}

export type Moved =
  | { readonly ok: true; readonly moved: ScheduleChanged; readonly said: string }
  | {
      readonly ok: false;
      readonly code:
        | "machine_unreachable"
        | "schedule_not_found"
        | "move_failed"
        | "move_incomplete";
      readonly message: string;
    };

const why = (failure: DoorFailure) => ("reason" in failure ? failure.reason : failure.message);

// WARNING: step request ids derive from the request, so a retried move repeats nothing.
export const moveSchedule: (asked: {
  readonly from: ScheduleDoor;
  readonly to: ScheduleDoor;
  readonly name: string;
  readonly checkout?: string | undefined;
  readonly request: string;
}) => Effect.Effect<Moved> = Effect.fn("ScheduleMove.move")(function* (asked: {
  readonly from: ScheduleDoor;
  readonly to: ScheduleDoor;
  readonly name: string;
  readonly checkout?: string | undefined;
  readonly request: string;
}) {
  const { from, to, name, request } = asked;
  const listed = yield* Effect.all(
    Arr.map([from, to], (door) =>
      door.schedules.pipe(
        Effect.mapError((cause) => `${door.name} did not answer: ${why(cause)}`),
        Effect.result,
      ),
    ),
    { concurrency: "unbounded" },
  );
  const unreachable = Arr.flatMap(listed, (one) => (one._tag === "Failure" ? [one.failure] : []));
  if (unreachable.length > 0)
    return {
      ok: false,
      code: "machine_unreachable",
      message: `${Arr.join(unreachable, "; ")}. Nothing was moved.`,
    };
  const found = Option.getOrUndefined(
    Arr.findFirst(
      Arr.flatMap(listed, (one) => (one._tag === "Success" ? one.success.schedules : [])),
      (one) => one.name === name,
    ),
  );
  if (found === undefined)
    return {
      ok: false,
      code: "schedule_not_found",
      message: `No Schedule called "${name}" is on ${from.name} or ${to.name}.`,
    };

  const step = (door: ScheduleDoor, change: ScheduleChange) =>
    door
      .changeSchedule({ change, request: `${request}:${change.change}` })
      .pipe(Effect.mapError(why), Effect.result);
  const added = yield* step(to, {
    change: "add",
    name,
    cron: found.cron,
    tz: found.tz,
    paused: true,
    start: {
      ...found.start,
      workspace:
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(asked.checkout), (present) => Str.trim(present)),
        ) || found.start.workspace,
    },
  });
  if (added._tag === "Failure")
    return {
      ok: false,
      code: "move_failed",
      message: `${to.name} would not take "${name}": ${added.failure}. Nothing was moved.`,
    };
  const removed = yield* step(from, { change: "remove", name });
  if (removed._tag === "Failure")
    return {
      ok: false,
      code: "move_incomplete",
      message: `"${name}" is added, paused on ${to.name}, but ${from.name} would not remove it: ${removed.failure}. It still fires on ${from.name}.`,
    };
  const resumed = yield* step(to, { change: "resume", name });
  if (resumed._tag === "Failure")
    return {
      ok: false,
      code: "move_incomplete",
      message: `"${name}" is removed from ${from.name} and paused on ${to.name}, which would not resume it: ${resumed.failure}.`,
    };
  return {
    ok: true,
    moved: resumed.success,
    said: `Moved "${name}" from ${from.name} to ${to.name}; it starts fresh there, and the Runs it started stay on ${from.name}.`,
  };
});
