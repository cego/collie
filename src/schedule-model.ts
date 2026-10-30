// A Schedule as every door reads it, and the two decisions its firing is made of
// (ADR-0052). Pure, so the host, the CLI and Desktop share one reading.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Cron, DateTime, Result, Schema } from "effect";
import { VerifySpecSchema } from "./verify-spec";

/** Lowercase letters, digits and hyphens: safe in a file name and in a request id. */
export const SCHEDULE_NAME = /^[a-z0-9-]{1,40}$/;

/** Where the checkout of a saved start is: an absolute path, or this. */
export const SCHEDULE_PROJECTS_ROOT = "projects-root";

/** A start as an agent gives one, without `here` and attachments: chat's `start` action. */
export const SavedStart = Schema.Struct({
  workflow: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.String),
  /** An absolute path, or `projects-root`. */
  workspace: Schema.String,
  verify: Schema.Array(VerifySpecSchema),
});
export type SavedStart = typeof SavedStart.Type;

/** What an occurrence came to, as the host records it. */
export const OccurrenceOutcome = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), run: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("waiting-for-herdr") }),
  Schema.Struct({ kind: Schema.Literal("refused"), reason: Schema.String }),
]);
export type OccurrenceOutcome = typeof OccurrenceOutcome.Type;

/** One Schedule as its host keeps it under `schedules/<name>/`. */
export const ScheduleRecord = Schema.Struct({
  name: Schema.String,
  cron: Schema.String,
  tz: Schema.String,
  start: SavedStart,
  paused: Schema.Boolean,
  added: Schema.String,
  /** The request id of the add or resume that began the chain now firing it. */
  epoch: Schema.String,
  /** The occurrence the chain's waiting execution is for. */
  pending: Schema.NullOr(Schema.String),
  last: Schema.NullOr(Schema.Struct({ occurrence: Schema.String, outcome: OccurrenceOutcome })),
  /** The Run it last started. */
  lastRun: Schema.NullOr(Schema.String),
  /** The Run a chain is waiting on, which a resume leaves that chain to hand over after. */
  running: Schema.NullOr(Schema.String),
});
export type ScheduleRecord = typeof ScheduleRecord.Type;

/** The Machine a Schedule is on: its installation id, and its name. */
export const ScheduleMachine = Schema.Struct({
  installation: Schema.String,
  hostname: Schema.String,
});
export type ScheduleMachine = typeof ScheduleMachine.Type;

/** What a listing says of the last occurrence. */
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

/** One Schedule as the CLI, chat and Desktop list it. */
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

/** A Machine's Schedules. */
export const ScheduleListing = Schema.Struct({
  machine: ScheduleMachine,
  schedules: Schema.Array(ScheduleEntry),
});
export type ScheduleListing = typeof ScheduleListing.Type;

/** What one Schedule's last occurrence came to, in a few words. */
export const lastLine = (last: ScheduleEntry["last"]) => {
  if (last === null) return "nothing yet";
  const outcome = last.outcome;
  const said =
    outcome.kind === "run"
      ? `${outcome.run} ${outcome.status}`
      : outcome.kind === "waiting-for-run"
        ? `waiting for ${outcome.run} (${outcome.status})`
        : outcome.kind === "waiting-for-herdr"
          ? "waiting for herdr"
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

/** The one write: add (paused or not), pause, resume or remove. */
export const ScheduleChange = Schema.Union([
  Schema.Struct({
    change: Schema.Literal("add"),
    name: Schema.String,
    cron: Schema.String,
    /** The host's own time zone where left out. */
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

/** What a write did, on which Machine; `schedule` is null once it is removed. */
export const ScheduleChanged = Schema.Struct({
  machine: ScheduleMachine,
  change: Schema.Literals(["add", "pause", "resume", "remove"]),
  name: Schema.String,
  schedule: Schema.NullOr(ScheduleEntry),
});
export type ScheduleChanged = typeof ScheduleChanged.Type;

export const machineOf = (machine: ScheduleMachine) =>
  `${machine.hostname} (${machine.installation})`;

/** What a write did, in the line every door says it in. */
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

/**
 * A cron expression read in a time zone, at minute resolution: five fields, or six where
 * the host was told seconds are allowed.
 */
export const parseSchedule = (
  expression: string,
  tz: string,
  allow: { readonly seconds: boolean },
): Result.Result<Cron.Cron, string> => {
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

/** An occurrence as it is recorded and named in a request id. */
export const isoOf = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The latest cron time at or before `now`, in epoch milliseconds. */
const latestAtOrBefore = (cron: Cron.Cron, now: number): number => {
  // `prev` is strict, so it is asked from just past now.
  const found = Cron.prev(cron, now + 1000).getTime();
  return found > now ? Cron.prev(cron, found).getTime() : found;
};

/** What a waking occurrence does. */
export type Wake =
  | { readonly _tag: "end"; readonly why: "removed" | "paused" | "superseded" }
  | { readonly _tag: "start"; readonly occurrence: number };

/**
 * End where the Schedule is gone, paused or under another epoch; otherwise start the
 * latest occurrence due, so a clock delivered late starts one Run for all it missed.
 */
export const onWake = (o: {
  readonly cron: Cron.Cron;
  readonly schedule: { readonly paused: boolean; readonly epoch: string } | null;
  readonly epoch: string;
  readonly occurrence: number;
  readonly now: number;
}): Wake => {
  if (o.schedule === null) return { _tag: "end", why: "removed" };
  if (o.schedule.paused) return { _tag: "end", why: "paused" };
  if (o.schedule.epoch !== o.epoch) return { _tag: "end", why: "superseded" };
  return { _tag: "start", occurrence: Math.max(o.occurrence, latestAtOrBefore(o.cron, o.now)) };
};

/**
 * The occurrence after `dealt`: one that fell since, at once, else the next cron time.
 * A resume passes now as `dealt`, which is what keeps it from catching up.
 */
export const nextOccurrence = (cron: Cron.Cron, dealt: number, now: number): number => {
  const latest = latestAtOrBefore(cron, now);
  return latest > dealt ? latest : Cron.next(cron, now).getTime();
};
