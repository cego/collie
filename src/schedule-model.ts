import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Cron, DateTime, Result, Schema } from "effect";
import { VerifySpecSchema } from "./verify-spec";

export const SCHEDULE_NAME = /^[a-z0-9-]{1,40}$/;

export const SCHEDULE_PROJECTS_ROOT = "projects-root";

export const SavedStart = Schema.Struct({
  workflow: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.String),
  workspace: Schema.String,
  verify: Schema.Array(VerifySpecSchema),
});
export type SavedStart = typeof SavedStart.Type;

export const OccurrenceOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), run: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("waiting-for-herdr") }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);
export type OccurrenceOutcome = typeof OccurrenceOutcome.Type;

export const ScheduleRecord = Schema.Struct({
  name: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  start: SavedStart,
  paused: Schema.Boolean,
  added: Schema.String,
  epoch: Schema.String,
  pending: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.Struct({ occurrence: Schema.String, outcome: OccurrenceOutcome })),
  lastRun: Schema.NullOr(Schema.String),
  running: Schema.NullOr(Schema.String),
});
export type ScheduleRecord = typeof ScheduleRecord.Type;

export const ScheduleMachine = Schema.Struct({
  installation: Schema.String,
  hostname: Schema.String,
});
export type ScheduleMachine = typeof ScheduleMachine.Type;

export const LastOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("run"), run: Schema.String, status: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("waiting-for-run"),
    run: Schema.String,
    status: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("waiting-for-herdr") }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);
export type LastOutcome = typeof LastOutcome.Type;

export const ScheduleEntry = Schema.Struct({
  machine: ScheduleMachine,
  name: Schema.String,
  workflow: Schema.String,
  checkout: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  paused: Schema.Boolean,
  start: SavedStart,
  next: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.Struct({ occurrence: Schema.String, outcome: LastOutcome })),
});
export type ScheduleEntry = typeof ScheduleEntry.Type;

export const ScheduleListing = Schema.Struct({
  machine: ScheduleMachine,
  schedules: Schema.Array(ScheduleEntry),
});
export type ScheduleListing = typeof ScheduleListing.Type;

export const lastLine = (last: ScheduleEntry["last"]) => {
  if (last === null) return "nothing yet";
  const outcome = last.outcome;
  const said =
    outcome.kind === "run"
      ? `${outcome.run} ${outcome.status}`
      : outcome.kind === "waiting-for-run"
        ? `waiting for ${outcome.run} (${outcome.status})`
        : outcome.kind === "waiting-for-herdr"
          ? "waiting for core"
          : `refused: ${outcome.reason}`;
  return `${last.occurrence} ${said}`;
};

export const scheduleLine = (entry: ScheduleEntry) =>
  Arr.join(
    [
      entry.name,
      `${entry.cron} ${entry.tz}`,
      entry.workflow,
      entry.checkout,
      entry.paused ? "paused" : `next ${entry.next ?? "when its Run ends"}`,
      `last ${lastLine(entry.last)}`,
    ],
    "\t",
  );

export const scheduleLines = (listing: ScheduleListing) =>
  Arr.join(
    [
      `schedules on ${listing.machine.hostname} (${listing.machine.installation}), as \`collie schedule list\` lists them:`,
      ...(listing.schedules.length === 0 ? ["- (none)"] : Arr.map(listing.schedules, scheduleLine)),
    ],
    "\n",
  );

export const ScheduleChange = Schema.Union([
  Schema.Struct({
    change: Schema.Literal("add"),
    name: Schema.String,
    cron: Schema.String,
    tz: Schema.optionalKey(Schema.String),
    paused: Schema.Boolean,
    start: SavedStart,
  }),
  Schema.Struct({
    change: Schema.Literals(["pause", "resume", "remove"]),
    name: Schema.String,
  }),
]);
export type ScheduleChange = typeof ScheduleChange.Type;

export const ScheduleChanged = Schema.Struct({
  machine: ScheduleMachine,
  change: Schema.Literals(["add", "pause", "resume", "remove"]),
  name: Schema.String,
  schedule: Schema.NullOr(ScheduleEntry),
});
export type ScheduleChanged = typeof ScheduleChanged.Type;

export const machineOf = (machine: ScheduleMachine) =>
  `${machine.hostname} (${machine.installation})`;

export const changedLine = (changed: ScheduleChanged) => {
  const on = machineOf(changed.machine);
  const entry = changed.schedule;
  switch (changed.change) {
    case "add":
      return `Added schedule ${changed.name} on ${on}${entry?.paused === true ? ", paused" : `; next ${entry?.next ?? "when its Run ends"}`}.`;
    case "pause":
      return `Paused schedule ${changed.name} on ${on}.`;
    case "resume":
      return `Resumed schedule ${changed.name} on ${on}; next ${entry?.next ?? "when its last Run ends"}.`;
    case "remove":
      return `Removed schedule ${changed.name} from ${on}; the Runs it started stay.`;
  }
};

export const parseSchedule = (
  expression: string,
  tz: string,
  allow: { readonly seconds: boolean },
) => {
  const fields = Str.split(Str.trim(expression), /\s+/).length;
  if (fields !== 5 && !(allow.seconds && fields === 6))
    return Result.fail(
      `"${expression}" is not a cron expression of five fields: minute, hour, day of month, month, day of week`,
    );
  return Result.mapError(Cron.parse(expression, tz), (failure) =>
    pipe(failure.message, Str.includes("time zone"))
      ? `"${tz}" is not a time zone`
      : `"${expression}" is not a cron expression: ${failure.message}`,
  );
};

export const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const latestAtOrBefore = (cron: Cron.Cron, now: number) => {
  const found = Cron.prev(cron, now + 1000).getTime();
  return found > now ? Cron.prev(cron, found).getTime() : found;
};

export type Wake =
  | { readonly _tag: "end"; readonly why: "removed" | "paused" | "superseded" }
  | { readonly _tag: "start"; readonly occurrence: number };

export const onWake: (o: {
  readonly cron: Cron.Cron;
  readonly schedule: { readonly paused: boolean; readonly epoch: string } | null;
  readonly epoch: string;
  readonly occurrence: number;
  readonly now: number;
}) => Wake = (o) => {
  if (o.schedule === null) return { _tag: "end", why: "removed" };
  if (o.schedule.paused) return { _tag: "end", why: "paused" };
  if (o.schedule.epoch !== o.epoch) return { _tag: "end", why: "superseded" };
  return { _tag: "start", occurrence: Math.max(o.occurrence, latestAtOrBefore(o.cron, o.now)) };
};

export const nextOccurrence = (cron: Cron.Cron, dealt: number, now: number) => {
  const latest = latestAtOrBefore(cron, now);
  return latest > dealt ? latest : Cron.next(cron, now).getTime();
};
