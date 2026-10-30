// Each Machine's Schedules as the Machines page draws them, and what each row offers
// (ADR-0052 D6). Pure, so the main process and the view read one thing.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Schema } from "effect";
import { lastLine, ScheduleEntry } from "../../../src/schedule-model";

/** What one Machine's host listed, or why it listed nothing. */
export const MachineSchedules = Schema.Struct({
  installation: Schema.String,
  profile: Schema.String,
  name: Schema.String,
  schedules: Schema.Array(ScheduleEntry),
  problem: Schema.NullOr(Schema.String),
  /** Desktop could not reach it, which stops none of its Schedules. */
  unreachable: Schema.Boolean,
});
export type MachineSchedules = typeof MachineSchedules.Type;

export const SCHEDULES_UPGRADE_SAID = "Can't list its Schedules; upgrade this Machine.";

export type ScheduleAction = "pause" | "resume" | "remove" | "move";

/** What a row's action asks: a change sent as `changeSchedule`'s payload, or the move dialog. */
export type ScheduleAsk =
  | { readonly kind: "move"; readonly from: string; readonly name: string }
  | {
      readonly kind: "change";
      readonly payload: {
        readonly installation: string;
        readonly name: string;
        readonly change: "pause" | "resume" | "remove";
      };
    };

export const scheduleAsk = (
  installation: string,
  name: string,
  action: ScheduleAction,
): ScheduleAsk =>
  action === "move"
    ? { kind: "move", from: installation, name }
    : { kind: "change", payload: { installation, name, change: action } };

export interface ScheduleRowView {
  readonly name: string;
  readonly workflow: string;
  readonly checkout: string;
  /** `every day at 07:00 (0 7 * * * Europe/Copenhagen)`. */
  readonly when: string;
  /** `next …`, or `paused`. */
  readonly next: string;
  readonly last: string;
  readonly actions: ReadonlyArray<ScheduleAction>;
}

export interface MachineSchedulesView {
  readonly state: "listed" | "empty" | "upgrade" | "unreachable" | "problem";
  readonly said: string | null;
  readonly rows: ReadonlyArray<ScheduleRowView>;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NUMBER = /^\d+$/;

/** A cron expression in words, for the shapes people write; null for the rest. */
export const cronWords = (cron: string): string | null => {
  // ponytail: common five-field shapes only; anything else is shown as its expression.
  const [minute, hour, day, month, weekday, ...rest] = Str.split(Str.trim(cron), /\s+/);
  if (rest.length > 0 || weekday === undefined || day !== "*" || month !== "*") return null;
  const step = /^\*\/(\d+)$/.exec(minute!)?.[1];
  if (step !== undefined && hour === "*" && weekday === "*") return `every ${step} minutes`;
  if (!NUMBER.test(minute!)) return null;
  const mm = pipe(minute!, Str.padStart(2, "0"));
  if (hour === "*" && weekday === "*") return `every hour at :${mm}`;
  if (!NUMBER.test(hour!)) return null;
  const at = `at ${pipe(hour!, Str.padStart(2, "0"))}:${mm}`;
  if (weekday === "*") return `every day ${at}`;
  if (weekday === "1-5") return `weekdays ${at}`;
  const named = NUMBER.test(weekday) ? DAYS[Number(weekday) % 7] : undefined;
  return named === undefined ? null : `every ${named} ${at}`;
};

const rowOf = (entry: ScheduleEntry): ScheduleRowView => {
  const expression = `${entry.cron} ${entry.tz}`;
  const words = cronWords(entry.cron);
  return {
    name: entry.name,
    workflow: entry.workflow,
    checkout: entry.checkout,
    when: words === null ? expression : `${words} (${expression})`,
    next: entry.paused ? "paused" : `next ${entry.next ?? "when its Run ends"}`,
    last: lastLine(entry.last),
    actions: [entry.paused ? "resume" : "pause", "remove", "move"],
  };
};

/** A Machine's Schedules section. */
export const machineSchedules = (machine: MachineSchedules): MachineSchedulesView => {
  if (machine.unreachable)
    return {
      state: "unreachable",
      said: `${machine.name} is unreachable${machine.problem === null ? "" : ` (${machine.problem})`}; its Schedules still fire there while its host runs.`,
      rows: [],
    };
  if (machine.problem !== null)
    return {
      state: machine.problem === SCHEDULES_UPGRADE_SAID ? "upgrade" : "problem",
      said: machine.problem,
      rows: [],
    };
  if (machine.schedules.length === 0)
    return {
      state: "empty",
      said: `No Schedules on ${machine.name}. Ask the Flock chat to add one.`,
      rows: [],
    };
  return { state: "listed", said: null, rows: Arr.map(machine.schedules, rowOf) };
};
