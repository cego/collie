// A Machine's Schedules, as its host keeps and fires them (ADR-0052): the record of each
// under `schedules/`, the one write and the read every door uses, and the `Schedule`
// workflow on the host's engine, one execution per occurrence.

import { hostname } from "node:os";
import {
  Cause,
  Clock,
  Context,
  Cron,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schedule as Retry,
  Schema,
  Semaphore,
} from "effect";
import * as Activity from "effect/workflow/Activity";
import * as DurableClock from "effect/workflow/DurableClock";
import * as Workflow from "effect/workflow/Workflow";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { agentStartRefusal, hostOptions } from "./agent-start";
import { once, readAudit, recordAudit, type ScheduledBy } from "./audit";
import { HostRefused, RequestConflict, Started, type FrontDoor, type Where } from "./board-model";
import { savedModules } from "./discovery";
import {
  forgetExecution,
  NEEDS_INPUT,
  REFUSED_INPUT,
  Registry,
  runDir,
  type HostServices,
} from "./engine";
import type { PluginEnv } from "./env";
import { Herdr } from "./herdr";
import { reason } from "./naming";
import { freshTaskLabel } from "./tasknames";
import { projectsRoot } from "./projects";
import { epochMs } from "./time";
import type { Voice } from "./proposals";
import {
  OccurrenceOutcome,
  SCHEDULE_NAME,
  SCHEDULE_PROJECTS_ROOT,
  ScheduleChanged,
  ScheduleRecord,
  isoOf,
  nextOccurrence,
  onWake,
  parseSchedule,
  type LastOutcome,
  type SavedStart,
  type ScheduleChange,
  type ScheduleEntry,
  type ScheduleListing,
  type ScheduleMachine,
} from "./schedule-model";

export const schedulesDir = (dir: string) => `${dir}/schedules`;
/** A Schedule's own directory: its record, and the trail of each change and occurrence. */
const trailOf = (dir: string, name: string) => `${schedulesDir(dir)}/${name}`;
const recordOf = (dir: string, name: string) => `${trailOf(dir, name)}/schedule.json`;
/** The request that last removed it, kept so a retry interrupted before its receipt finds it done. */
const removedOf = (dir: string, name: string) => `${trailOf(dir, name)}/removed`;

/** How long an occurrence waits between asking a herdr that does not answer. */
const HERDR_WAIT = "1 minute";

/** One occurrence of one Schedule's chain; the next is started by this one. */
export const ScheduleWorkflow = Workflow.make("Schedule", {
  payload: {
    name: Schema.String,
    epoch: Schema.String,
    occurrence: Schema.String,
    /** The occurrence of the execution that started this one, whose engine state it clears. */
    after: Schema.NullOr(Schema.String),
  },
  idempotencyKey: ({ name, epoch, occurrence }) => `${name}/${epoch}/${occurrence}`,
});

const Woke = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("end") }),
  Schema.Struct({ kind: Schema.Literal("start"), occurrence: Schema.String }),
]);

const RecordJson = Schema.fromJsonString(ScheduleRecord);
const decodeRecord = Schema.decodeUnknownEffect(RecordJson);
const encodeRecord = Schema.encodeSync(RecordJson);
const asJson = Schema.decodeUnknownSync(Schema.Json);

/** Who asks for a change, as the channel declared it. */
export type ScheduleAsker = Voice & {
  readonly origin: FrontDoor;
  readonly from?: Where | undefined;
};

export class Schedules extends Context.Service<
  Schedules,
  {
    readonly list: Effect.Effect<ScheduleListing>;
    readonly change: (
      change: ScheduleChange,
      request: string,
      by: ScheduleAsker,
    ) => Effect.Effect<ScheduleChanged, HostRefused | RequestConflict>;
  }
>()("collie/Schedules") {}

const refusedInput = (why: string) => new HostRefused({ reason: `${REFUSED_INPUT}: ${why}` });

/** The occurrence the chain waits for next, and null while it waits for a Run instead. */
const upcoming = (record: ScheduleRecord) =>
  record.pending !== null &&
  (record.last === null || epochMs(record.pending) > epochMs(record.last.occurrence))
    ? record.pending
    : null;

/** The host's own time zone, which a Schedule added without one is read in. */
const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The host's Schedules, and the `Schedule` workflow registered on its engine. `seconds`
 * is the test-only allowance for a sixth cron field.
 */
export const schedulesLayer = (options: {
  readonly dir: string;
  readonly env: PluginEnv;
  readonly installation: string;
  readonly seconds: boolean;
}) =>
  Layer.effect(Schedules)(
    Effect.gen(function* () {
      const { dir, env } = options;
      const fs = yield* FileSystem.FileSystem;
      const registry = yield* Registry;
      const hosted = yield* Effect.context<HostServices | BunServices>();
      const scope = yield* Effect.scope;
      const machine: ScheduleMachine = { installation: options.installation, hostname: hostname() };
      // One writer of the records at a time: a change and an occurrence both read and write one.
      const writing = yield* Semaphore.make(1);

      const read = (name: string) =>
        fs.readFileString(recordOf(dir, name)).pipe(
          Effect.flatMap(decodeRecord),
          Effect.orElseSucceed((): ScheduleRecord | null => null),
        );
      const write = (record: ScheduleRecord) =>
        Effect.gen(function* () {
          const file = recordOf(dir, record.name);
          yield* fs.makeDirectory(trailOf(dir, record.name), { recursive: true });
          yield* fs.writeFileString(`${file}.tmp`, encodeRecord(record));
          yield* fs.rename(`${file}.tmp`, file);
        }).pipe(Effect.orDie);
      const update = (name: string, change: (record: ScheduleRecord) => ScheduleRecord) =>
        writing.withPermits(1)(
          Effect.flatMap(read(name), (record) =>
            record === null
              ? Effect.succeed(null)
              : Effect.as(write(change(record)), change(record)),
          ),
        );
      const cronOf = (record: ScheduleRecord) =>
        Result.getOrUndefined(parseSchedule(record.cron, record.tz, { seconds: options.seconds }));
      const now = Clock.currentTimeMillis;

      /** The chain's next execution, started apart from this one so neither waits on the other. */
      const startExecution = (payload: typeof ScheduleWorkflow.payloadSchema.Type) =>
        ScheduleWorkflow.execute(payload, { discard: true }).pipe(
          Effect.updateContext((context: Context.Context<WorkflowEngine.WorkflowEngine>) =>
            Context.omit(WorkflowEngine.WorkflowInstance)(context),
          ),
          Effect.provideContext(hosted),
          Effect.asVoid,
        );

      const statusOf = (run: string) =>
        registry.view(run).pipe(Effect.map((view) => view?.status.status ?? "unknown"));

      const entryOf = Effect.fn("Schedules.entryOf")(function* (record: ScheduleRecord) {
        let last: ScheduleEntry["last"] = null;
        if (record.last !== null) {
          const outcome = record.last.outcome;
          let said: LastOutcome;
          if (outcome.kind === "started") {
            const status = yield* statusOf(outcome.run);
            said = {
              kind: status === "complete" || status === "failed" ? "run" : "waiting-for-run",
              run: outcome.run,
              status,
            };
          } else said = outcome;
          last = { occurrence: record.last.occurrence, outcome: said };
        }
        return {
          machine,
          name: record.name,
          workflow: record.start.workflow,
          checkout: record.start.workspace,
          cron: record.cron,
          tz: record.tz,
          paused: record.paused,
          start: record.start,
          next: record.paused ? null : upcoming(record),
          last,
        } satisfies ScheduleEntry;
      });

      const list = Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(schedulesDir(dir))
          .pipe(Effect.orElseSucceed((): Array<string> => []));
        const entries: Array<ScheduleEntry> = [];
        for (const name of names.sort()) {
          const record = yield* read(name);
          if (record !== null) entries.push(yield* entryOf(record));
        }
        return { machine, schedules: entries };
      });

      /** Where a saved start runs, and what the host is given to start it there. */
      const placed = Effect.fn("Schedules.placed")(function* (start: SavedStart) {
        const atRoot = start.workspace === SCHEDULE_PROJECTS_ROOT;
        const root = atRoot
          ? (yield* projectsRoot(env).pipe(
              Effect.mapError(() => refusedInput("this Machine has no Projects root")),
            )).path
          : undefined;
        const project = root ?? start.workspace;
        const split = hostOptions({ json: {}, text: start.inputs });
        return {
          project,
          root,
          text: split.input.text,
          options: { ...split.options, workspace: start.workspace },
        };
      });

      /** The start checked as an agent's start is, before the Schedule is written. */
      const checkStart = Effect.fn("Schedules.checkStart")(function* (
        start: SavedStart,
        request: string,
      ) {
        if (start.workspace.trim() === "")
          return yield* new HostRefused({
            reason: `${NEEDS_INPUT}: a Schedule names its checkout: an absolute path, or ${SCHEDULE_PROJECTS_ROOT}`,
          });
        if (start.workspace !== SCHEDULE_PROJECTS_ROOT && !start.workspace.startsWith("/"))
          return yield* refusedInput(
            `workspace: "${start.workspace}" is neither an absolute path nor ${SCHEDULE_PROJECTS_ROOT}`,
          );
        if ("workspace" in start.inputs)
          return yield* refusedInput(
            "the checkout is the start's workspace, not one of its Inputs",
          );
        const where = yield* placed(start);
        const saved = yield* savedModules({ ...env, cwd: where.project });
        const fault = saved.problems.find((one) => one.id === start.workflow);
        if (fault !== undefined) return yield* refusedInput(`${fault.path}: ${fault.message}`);
        const entry = saved.entries.find((one) => one.id === start.workflow);
        if (entry === undefined)
          return yield* refusedInput(
            `no workflow "${start.workflow}" is saved for ${where.project}`,
          );
        const missing = yield* agentStartRefusal(
          { ...env, cwd: where.project },
          entry,
          { json: {}, text: where.text },
          { named: where.project, fix: "" },
        );
        if (missing !== null)
          return yield* new HostRefused({ reason: `${NEEDS_INPUT}: ${missing.error.message}` });
        const generation = yield* registry.resolve({ project: where.project, id: start.workflow });
        yield* registry.check({
          generation,
          request,
          project: where.project,
          input: {},
          text: where.text,
          root: where.root,
          options: where.options,
          verify: start.verify,
        });
      }, Effect.provideContext(hosted));

      /** One occurrence's Run, admitted for the Schedule to execute itself. */
      const startSaved = Effect.fn("Schedules.startSaved")(function* (
        start: SavedStart,
        by: ScheduledBy,
      ) {
        const request = `schedule:${by.name}:${by.occurrence}`;
        const where = yield* placed(start);
        const generation = yield* registry.resolve({ project: where.project, id: start.workflow });
        const admitted = yield* registry.start({
          generation,
          request,
          project: where.project,
          input: {},
          text: where.text,
          root: where.root,
          options: where.options,
          taskLabel: yield* freshTaskLabel(
            { ...env, cwd: where.project },
            { workflow: start.workflow, inputs: where.text, goal: by.name.replace(/[-_]+/g, " ") },
          ),
          verify: start.verify,
          handsOver: true,
        });
        const trail = runDir(dir, admitted.runId);
        const recorded = (yield* readAudit(trail).pipe(Effect.orElseSucceed(() => []))).some(
          (line) => line.request === request,
        );
        if (!recorded)
          yield* recordAudit(trail, {
            operation: "start",
            request,
            origin: "schedule",
            schedule: by,
            result: Started,
            value: admitted,
          }).pipe(Effect.orDie);
        return admitted.runId;
      }, Effect.provideContext(hosted));

      /** herdr answering, waited for each minute: a scheduled Run always gets its own Task. */
      const herdrAnswers = (name: string, occurrence: string) =>
        new Herdr(env).workspaceList().pipe(
          Effect.tapError(() =>
            update(name, (record) => ({
              ...record,
              last: { occurrence, outcome: { kind: "waiting-for-herdr" } },
            })),
          ),
          Effect.retry({ schedule: Retry.spaced(options.seconds ? "1 second" : HERDR_WAIT) }),
          Effect.provideContext(hosted),
          Effect.orDie,
        );

      const startOccurrence = Effect.fn("Schedules.startOccurrence")(function* (
        name: string,
        epoch: string,
        occurrence: string,
      ): Effect.fn.Return<OccurrenceOutcome> {
        yield* herdrAnswers(name, occurrence);
        const refused = (why: string) => ({ kind: "refused" as const, reason: why });
        // Under the write lock from the read to the recorded Run, so a pause, resume or
        // removal lands wholly before the start or after its Run is the Schedule's.
        return yield* writing.withPermits(1)(
          Effect.gen(function* (): Effect.fn.Return<OccurrenceOutcome> {
            const record = yield* read(name);
            if (record === null) return refused("the Schedule was removed");
            if (record.epoch !== epoch) return refused("the Schedule was resumed");
            if (record.paused) {
              const outcome = refused("the Schedule was paused");
              yield* write({ ...record, last: { occurrence, outcome } });
              return outcome;
            }
            const outcome = yield* startSaved(record.start, { name, occurrence }).pipe(
              Effect.map((run) => ({ kind: "started" as const, run })),
              Effect.catch((failure) =>
                Effect.succeed(refused("reason" in failure ? failure.reason : reason(failure))),
              ),
            );
            yield* write(
              outcome.kind === "started"
                ? {
                    ...record,
                    last: { occurrence, outcome },
                    lastRun: outcome.run,
                    running: outcome.run,
                  }
                : { ...record, last: { occurrence, outcome } },
            );
            return outcome;
          }),
        );
      });

      /**
       * What became of an occurrence, written down, and which execution the chain goes on
       * with. A chain a resume left waiting for its Run hands the Schedule's new epoch its
       * first occurrence, with no catch-up.
       */
      const recordOccurrence = Effect.fn("Schedules.recordOccurrence")(function* (
        payload: typeof ScheduleWorkflow.payloadSchema.Type,
        occurrence: string,
        outcome: OccurrenceOutcome,
      ) {
        yield* once(
          trailOf(dir, payload.name),
          {
            operation: "occurrence",
            request: `schedule:${payload.name}:${occurrence}`,
            origin: "schedule",
            schedule: { name: payload.name, occurrence },
            asked: { epoch: payload.epoch, due: payload.occurrence },
            result: OccurrenceOutcome,
          },
          Effect.succeed(outcome),
        ).pipe(Effect.orDie);
        const at = yield* now;
        const run = outcome.kind === "started" ? outcome.run : null;
        return yield* writing.withPermits(1)(
          Effect.gen(function* () {
            const record = yield* read(payload.name);
            if (record === null) return null;
            const own = record.epoch === payload.epoch;
            const handedOver = !own && run !== null && record.running === run;
            const cron = cronOf(record);
            const chosen =
              record.paused || cron === undefined || !(own || handedOver)
                ? null
                : isoOf(nextOccurrence(cron, own ? epochMs(occurrence) : at, at));
            yield* write({
              ...record,
              pending: own || handedOver ? chosen : record.pending,
              running: run !== null && record.running === run ? null : record.running,
            });
            return chosen === null ? null : { epoch: record.epoch, occurrence: chosen };
          }),
        );
      });

      /** What the engine kept of an execution that has finished, gone. */
      const forgetFinished = (payload: typeof ScheduleWorkflow.payloadSchema.Type) =>
        Effect.gen(function* () {
          const execution = yield* ScheduleWorkflow.executionId(payload);
          if (Option.isNone(yield* ScheduleWorkflow.poll(execution))) return;
          yield* forgetExecution(ScheduleWorkflow._tag, execution);
        }).pipe(Effect.provideContext(hosted), Effect.ignore);

      yield* Layer.buildWithScope(
        ScheduleWorkflow.toLayer((payload) =>
          Effect.gen(function* () {
            const due = epochMs(payload.occurrence);
            yield* DurableClock.sleep({
              name: "occurrence",
              duration: Duration.millis(Math.max(0, due - (yield* Clock.currentTimeMillis))),
              // Every wake-up is the persisted clock, however near the occurrence.
              inMemoryThreshold: Duration.zero,
            });
            const woke = yield* Activity.make({
              name: "wake",
              success: Woke,
              execute: Effect.gen(function* () {
                const record = yield* read(payload.name);
                const cron = record === null ? undefined : cronOf(record);
                const decided =
                  cron === undefined
                    ? ({ _tag: "end" } as const)
                    : onWake({
                        cron,
                        schedule: record,
                        epoch: payload.epoch,
                        occurrence: epochMs(payload.occurrence),
                        now: yield* now,
                      });
                return decided._tag === "end"
                  ? { kind: "end" as const }
                  : { kind: "start" as const, occurrence: isoOf(decided.occurrence) };
              }),
            });
            if (woke.kind === "end") return;
            const outcome = yield* Activity.make({
              name: "start",
              success: OccurrenceOutcome,
              execute: startOccurrence(payload.name, payload.epoch, woke.occurrence),
            });
            // On this execution's own fiber, so the Run's end is what wakes it. A suspension
            // is the engine's and passes through; how the Run ended is its own record's.
            if (outcome.kind === "started")
              yield* registry.result(outcome.run).pipe(
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              );
            // Decided once, so a replay starts the same execution rather than a later one.
            const next = yield* Activity.make({
              name: "record",
              success: Schema.NullOr(
                Schema.Struct({ epoch: Schema.String, occurrence: Schema.String }),
              ),
              execute: recordOccurrence(payload, woke.occurrence, outcome),
            });
            if (next !== null)
              yield* startExecution({
                name: payload.name,
                ...next,
                after: next.epoch === payload.epoch ? payload.occurrence : null,
              });
            // ponytail: an execution that ends unstarted (paused, removed, superseded) has no follower to forget it; one row each.
            if (payload.after !== null)
              yield* forgetFinished({ ...payload, occurrence: payload.after });
          }),
        ),
        scope,
      );

      const change = (change: ScheduleChange, request: string, by: ScheduleAsker) =>
        Effect.gen(function* () {
          if (!SCHEDULE_NAME.test(change.name))
            return yield* refusedInput(
              `"${change.name}" is not a Schedule's name: lowercase letters, digits and hyphens, at most 40`,
            );
          return yield* once(
            trailOf(dir, change.name),
            {
              operation: change.change,
              request,
              ...by,
              asked: asJson(change),
              result: ScheduleChanged,
            },
            writing.withPermits(1)(apply(change, request)),
          );
        }).pipe(Effect.provideContext(hosted));

      const apply = Effect.fn("Schedules.apply")(function* (
        change: ScheduleChange,
        request: string,
      ) {
        const record = yield* read(change.name);
        const done = (schedule: ScheduleRecord | null) =>
          Effect.map(
            schedule === null ? Effect.succeed<ScheduleEntry | null>(null) : entryOf(schedule),
            (entry): ScheduleChanged => ({
              machine,
              change: change.change,
              name: change.name,
              schedule: entry,
            }),
          );
        if (change.change === "remove") {
          const removals = yield* fs
            .readFileString(removedOf(dir, change.name))
            .pipe(Effect.orElseSucceed(() => ""));
          // Each line is a removal's request and the `added` of the record it removed.
          const removed = removals
            .split("\n")
            .find((line) => line.startsWith(`${request} `))
            ?.slice(request.length + 1);
          if (removed !== undefined && removed !== record?.added) return yield* done(null);
        }
        // This request's own write, from an attempt that stopped before its receipt.
        if (record !== null && record.epoch === request && change.change !== "pause")
          return yield* done(record);
        if (change.change === "add") {
          if (record !== null)
            return yield* refusedInput(
              `a Schedule called "${change.name}" is already on this Machine; remove it first`,
            );
          const tz = change.tz ?? hostZone();
          const cron = parseSchedule(change.cron, tz, { seconds: options.seconds });
          if (Result.isFailure(cron)) return yield* refusedInput(cron.failure);
          yield* checkStart(change.start, request);
          const at = yield* now;
          const added: ScheduleRecord = {
            name: change.name,
            cron: change.cron,
            tz,
            start: change.start,
            paused: change.paused,
            added: isoOf(at),
            epoch: request,
            pending: change.paused ? null : isoOf(Cron.next(cron.success, at).getTime()),
            last: null,
            lastRun: null,
            running: null,
          };
          yield* write(added);
          if (added.pending !== null)
            yield* startExecution({
              name: added.name,
              epoch: added.epoch,
              occurrence: added.pending,
              after: null,
            });
          return yield* done(added);
        }
        if (record === null)
          return yield* refusedInput(`no Schedule called "${change.name}" is on this Machine`);
        if (change.change === "remove") {
          yield* fs
            .writeFileString(removedOf(dir, change.name), `${request} ${record.added}\n`, {
              flag: "a",
            })
            .pipe(Effect.orDie);
          yield* fs.remove(recordOf(dir, change.name)).pipe(Effect.orDie);
          return yield* done(null);
        }
        if (change.change === "pause") {
          const paused = { ...record, paused: true };
          yield* write(paused);
          return yield* done(paused);
        }
        if (!record.paused)
          return yield* new HostRefused({
            reason: `invalid_state: "${change.name}" is not paused`,
          });
        const cron = cronOf(record);
        if (cron === undefined)
          return yield* refusedInput(`"${record.cron}" no longer reads as a cron expression here`);
        const at = yield* now;
        // A chain still waiting for its Run hands the new epoch its first occurrence.
        const pending = record.running === null ? isoOf(nextOccurrence(cron, at, at)) : null;
        const resumed = { ...record, paused: false, epoch: request, pending };
        yield* write(resumed);
        if (pending !== null)
          yield* startExecution({
            name: record.name,
            epoch: request,
            occurrence: pending,
            after: null,
          });
        return yield* done(resumed);
      });

      /**
       * The first occurrence of a Schedule resumed while its Run went, where that Run has
       * ended and no chain was left to hand it over; null while one still may.
       */
      const handedOverAndLost = (record: ScheduleRecord) =>
        Effect.gen(function* () {
          const cron = cronOf(record);
          if (record.running === null || cron === undefined) return null;
          const status = yield* statusOf(record.running);
          if (status !== "complete" && status !== "failed") return null;
          const at = yield* now;
          const pending = isoOf(nextOccurrence(cron, at, at));
          yield* update(record.name, (now) => ({ ...now, pending, running: null }));
          return pending;
        });

      // Each active Schedule's waiting execution, again: its key makes this a no-op unless
      // the engine lost it.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const names = yield* fs
            .readDirectory(schedulesDir(dir))
            .pipe(Effect.orElseSucceed((): Array<string> => []));
          for (const name of names) {
            const record = yield* read(name);
            if (record === null || record.paused) continue;
            const pending = record.pending ?? (yield* handedOverAndLost(record));
            if (pending === null) continue;
            yield* startExecution({
              name,
              epoch: record.epoch,
              occurrence: pending,
              after: null,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `Schedule ${name} was not taken up again: ${Cause.pretty(cause)}`,
                ),
              ),
            );
          }
        }),
      );

      return Schedules.of({ list, change });
    }),
  );
