// A Run's own records in `host.db` (ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database):
// its journals, line by line in the order written, and its facts, one value each. Each is
// named by the file an older build kept it in, which is what the import reads and the
// rollback writes.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Clock, Context, Effect, Layer, Option } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { StoreWrites } from "./store-writes";

/** The migration that made these tables and imported the files they replace. */
export const RUN_RECORDS_MIGRATION_ID = 25;
export const RUN_RECORDS_MIGRATION = `${RUN_RECORDS_MIGRATION_ID}_run_records`;

/** Where an older build kept a Run's records, under the state directory, by the Run's id. */
export const AREAS = ["runs", "evidence"] as const;

/** A record's name: its path in the Run's directory, `evidence/` first for that area's. */
export const recordName = (area: (typeof AREAS)[number], path: string) =>
  area === "runs" ? path : `${area}/${path}`;

/** The journals an older build kept as JSONL files, by name. */
export const LEGACY_JOURNALS: ReadonlyArray<string> = [
  "steps.jsonl",
  "operations.jsonl",
  "replies.jsonl",
  "reviews.jsonl",
  "ci-rechecks.jsonl",
  "ci-failed.jsonl",
  "links.jsonl",
  "link-deliveries.jsonl",
  "link-notices.jsonl",
  "metrics.jsonl",
  "steering/cards.jsonl",
  "steering/disposition.jsonl",
  "steering/drift.jsonl",
  "steering/seen.jsonl",
  "steering/carded",
  "evidence/metrics.jsonl",
  "evidence/measurements.jsonl",
  "evidence/steering/verifications.jsonl",
];

/** Journals of plain lines rather than JSON. */
export const TEXT_JOURNALS: ReadonlySet<string> = new Set(["steering/carded"]);

/** The facts an older build kept one file each, by name. */
export const LEGACY_FACTS: ReadonlyArray<string> = [
  "intent.json",
  "step-steering.json",
  "landing.json",
  "terminal.json",
  "merge-request",
  "nothing-to-land",
  "recovery-parent",
  "steering/judged.json",
  "evidence/approved.json",
];

/** Facts an older build kept one file each beside others of their kind, by name prefix. */
export const LEGACY_FACT_PREFIXES: ReadonlyArray<string> = [
  "steering/progress/",
  "steering/externals.",
];

/**
 * The controls the host sets over a Run that an older build kept as `<control>.<run>`
 * files in the state directory, one value each.
 */
export const LEGACY_CONTROLS: ReadonlyArray<string> = [
  "hold",
  "stop",
  "parked",
  "park-info",
  "park-cause",
  "awaiting",
  "usage",
];
/** What the host told about a Run: one row per thing told, keyed by it (`notified.<run>`). */
export const NOTIFIED = "notified";
/** The children a Run waits on, one row each keyed by the child (`awaited.<run>/<child>`). */
export const AWAITED = "awaited";
/** What a Run's agent on core was started with, keyed by agent (`relaunch/<run>/<agent>.json`). */
export const RELAUNCH = "relaunch";
/** A check the host runs, keyed by its id under no Run (`running-checks/<id>.json`); its Run is in its record. */
export const RUNNING_CHECK = "running-check";

/** A Run directory's records: the Run, and what its records' names start with. */
export const addressOf = (dir: string) => {
  const run = runOfDir(dir);
  const parent = runOfDir(parentOf(dir));
  return { run, prefix: parent === "runs" || parent === "" ? "" : `${parent}/` };
};

export const STEPS = "steps.jsonl";

/** What a write to a Run's records invalidates. */
export const RUN_RECORDS = "collie/run-records";

const lastSlash = (path: string) => Option.getOrElse(Str.lastIndexOf("/")(path), () => -1);

export const runOfDir = (dir: string) => Str.slice(lastSlash(dir) + 1)(dir);

/** The directory `path` is in; empty where it names none. */
export const parentOf = (path: string) => Str.slice(0, Math.max(0, lastSlash(path)))(path);

export interface RunRecordsApi {
  /** A journal's lines, oldest first. */
  readonly lines: (run: string, journal: string) => Effect.Effect<ReadonlyArray<string>>;
  /** These Runs' lines of `journal`, in one read; a Run with none is absent. */
  readonly linesOf: (
    runs: ReadonlyArray<string>,
    journal: string,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  /** Appends lines to a journal, after every line already there. */
  readonly append: (
    run: string,
    journal: string,
    lines: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  /** A fact's value, null where there is none. */
  readonly fact: (run: string, name: string) => Effect.Effect<string | null>;
  /** These Runs' values of `name`, in one read; a Run with none is absent. */
  readonly factsOf: (
    runs: ReadonlyArray<string>,
    name: string,
  ) => Effect.Effect<ReadonlyMap<string, string>>;
  /** The Run's facts whose names start with `prefix`, by name. */
  readonly factsUnder: (
    run: string,
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly data: string }>>;
  /** Sets a fact, or removes it for null. */
  readonly put: (run: string, name: string, value: string | null) => Effect.Effect<void>;
  /**
   * Replaces a fact with what `change` makes of it, in one transaction: no other write to
   * this database lands between the read and the write. Null removes it.
   */
  readonly update: <E, R>(
    run: string,
    name: string,
    change: (value: string | null) => Effect.Effect<string | null, E, R>,
  ) => Effect.Effect<string | null, E, R>;
  /** When each of these Runs last did work, epoch ms; a Run with none recorded is absent. */
  readonly activity: (runs: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, number>>;
  /**
   * How long each workflow's Steps took: for each Step, at most its 10 latest runs, each
   * from the Step's first entry to its last leaving.
   */
  readonly stepSamples: Effect.Effect<
    ReadonlyArray<{ readonly workflow: string; readonly step: string; readonly ms: number }>
  >;
  /** Records that the Run did work now. */
  readonly touch: (run: string) => Effect.Effect<void>;
  /** A control's value over the Run, null where it is not set. */
  readonly control: (control: string, run: string, key?: string) => Effect.Effect<string | null>;
  /** Every value of `control` set over the Run, by key. */
  readonly controlsOf: (
    control: string,
    run: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string; readonly data: string }>>;
  /** Every value of `control`, over any Run. */
  readonly everyControl: (
    control: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly run: string; readonly key: string; readonly data: string }>
  >;
  /** These Runs' controls, in one read; a Run with none is absent. */
  readonly controlsIn: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<ControlRow>>>;
  /** Sets a control over the Run, or clears it for null. Not work: activity stays. */
  readonly setControl: (
    control: string,
    run: string,
    data: string | null,
    key?: string,
  ) => Effect.Effect<void>;
}

export interface ControlRow {
  readonly control: string;
  readonly key: string;
  readonly data: string;
}

export class RunRecords extends Context.Service<RunRecords, RunRecordsApi>()("collie/RunRecords") {}

/**
 * Records about a Run that the host writes for itself, not work the Run did: who looked at
 * it, what became of it, who asked for what. Writing one does not make the Run active.
 */
export const BOOKKEEPING: ReadonlySet<string> = new Set([
  "operations.jsonl",
  "steering/disposition.jsonl",
  "steering/seen.jsonl",
]);

/** How many of a Step's latest times its usual time is taken from. */
const STEP_SAMPLES = 10;

/** Each Step's time in `?1`'s Runs, or every Run's for null: its latest leaving, less its first entry. */
const stepSamplesOf = `WITH leaves AS (
    SELECT l.run, l.key, json_extract(l.line, '$.at') AS at, r.workflow,
      row_number() OVER (PARTITION BY l.run, l.key ORDER BY json_extract(l.line, '$.at') DESC) AS nth
    FROM collie_run_lines l JOIN collie_runs r ON r.run = l.run
    WHERE l.journal = '${STEPS}' AND l.kind = 'leave' AND (?1 IS NULL OR l.run = ?1)
  ), entered AS (
    SELECT run, key, min(seq) AS seq FROM collie_run_lines
    WHERE journal = '${STEPS}' AND kind = 'enter' AND (?1 IS NULL OR run = ?1) GROUP BY run, key
  ), timed AS (
    SELECT leaves.workflow, json_extract(e.line, '$.step.id') AS step, leaves.at,
      CAST(round((julianday(leaves.at) - julianday(json_extract(e.line, '$.at'))) * 86400000) AS INTEGER) AS ms
    FROM leaves
    JOIN entered ON entered.run = leaves.run AND entered.key = leaves.key
    JOIN collie_run_lines e ON e.run = entered.run AND e.journal = '${STEPS}' AND e.seq = entered.seq
    WHERE leaves.nth = 1
  ), samples AS (SELECT workflow, step, at, ms FROM timed WHERE ms >= 0)`;

/**
 * `records` for one pass over these Runs: the first read of a journal, a fact, a control's
 * values or activity for any of them reads it for all of them, in one query, and the pass
 * reads that.
 */
export const readAhead = (records: RunRecordsApi, runs: ReadonlyArray<string>): RunRecordsApi => {
  const ids = new Set(runs);
  const once = <A>(read: (name: string) => Effect.Effect<A>) => {
    const reads = new Map<string, Effect.Effect<A>>();
    return (name: string) =>
      Effect.suspend(() => {
        const known = reads.get(name);
        if (known !== undefined) return known;
        return Effect.flatMap(Effect.cached(read(name)), (read) => {
          reads.set(name, read);
          return read;
        });
      });
  };
  const journal = once((name) => records.linesOf(runs, name));
  const fact = once((name) => records.factsOf(runs, name));
  const activity = once(() => records.activity(runs));
  const controls = once((name) =>
    Effect.map(records.everyControl(name), (rows) => Arr.groupBy(rows, (row) => row.run)),
  );
  return {
    ...records,
    lines: (run, name) =>
      ids.has(run)
        ? Effect.map(journal(name), (all) => all.get(run) ?? [])
        : records.lines(run, name),
    fact: (run, name) =>
      ids.has(run)
        ? Effect.map(fact(name), (all) => all.get(run) ?? null)
        : records.fact(run, name),
    controlsOf: (control, run) =>
      ids.has(run)
        ? Effect.map(controls(control), (all) => all[run] ?? [])
        : records.controlsOf(control, run),
    activity: (some) =>
      Arr.every(some, (run) => ids.has(run))
        ? Effect.map(
            activity(""),
            (all) => new Map(Arr.filter([...all], ([run]) => some.includes(run))),
          )
        : records.activity(some),
  };
};

/**
 * Keeps a Run's Step times past its records, for the usual times its workflow's next Runs
 * are measured against: each Step keeps its latest ten.
 */
export const keepStepTimes = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `${stepSamplesOf} INSERT INTO collie_step_times (workflow, step, at, ms) SELECT workflow, step, at, ms FROM samples`,
      [run],
    );
    yield* trimStepTimes;
  });

/** Keeps each Step's latest ten kept times. */
export const trimStepTimes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM collie_step_times WHERE rowid IN (
      SELECT rowid FROM (
        SELECT rowid, row_number() OVER (PARTITION BY workflow, step ORDER BY at DESC) AS nth
        FROM collie_step_times
      ) WHERE nth > ${STEP_SAMPLES}
    )
  `;
});

/** Records that `run` did work now, as part of the write it is in. */
export const markWorked = (run: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    yield* sql`
      INSERT INTO collie_run_activity (run, at) VALUES (${run}, ${now})
      ON CONFLICT (run) DO UPDATE SET at = max(at, excluded.at)
    `;
  });

export const runRecordsLayer = Layer.effect(RunRecords)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const moved = (run: string) =>
      Effect.andThen(
        Effect.sync(() => told?.([run])),
        reactivity.invalidate([RUN_RECORDS]),
      );
    const worked = (run: string, topic: string) =>
      BOOKKEEPING.has(topic)
        ? Effect.void
        : markWorked(run).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const grouped = <R extends { readonly run: string }, A>(
      rows: ReadonlyArray<R>,
      value: (row: R) => A,
    ) => {
      const byRun = new Map<string, A[]>();
      for (const row of rows) {
        const list = byRun.get(row.run);
        if (list === undefined) byRun.set(row.run, [value(row)]);
        else list.push(value(row));
      }
      return byRun;
    };
    const readFact = (run: string, name: string) =>
      sql<{ readonly data: string }>`
        SELECT data FROM collie_run_facts WHERE run = ${run} AND name = ${name}
      `.pipe(Effect.map(([row]) => row?.data ?? null));
    const writeFact = (run: string, name: string, value: string | null) =>
      (value === null
        ? sql`DELETE FROM collie_run_facts WHERE run = ${run} AND name = ${name}`
        : sql`
            INSERT INTO collie_run_facts (run, name, data) VALUES (${run}, ${name}, ${value})
            ON CONFLICT (run, name) DO UPDATE SET data = excluded.data
          `
      ).pipe(Effect.andThen(worked(run, name)));
    return {
      lines: (run, journal) =>
        sql<{ readonly line: string }>`
          SELECT line FROM collie_run_lines WHERE run = ${run} AND journal = ${journal} ORDER BY seq
        `.pipe(Effect.map(Arr.map((row) => row.line)), Effect.orDie),
      linesOf: (runs, journal) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly line: string }>`
              SELECT run, line FROM collie_run_lines
              WHERE journal = ${journal} AND run IN ${sql.in(runs)} ORDER BY run, seq
            `.pipe(
              Effect.map((rows) => grouped(rows, (row: { line: string }) => row.line)),
              Effect.orDie,
            ),
      append: (run, journal, lines) =>
        lines.length === 0
          ? Effect.void
          : Effect.gen(function* () {
              const [last] = yield* sql<{ readonly seq: number | null }>`
                SELECT max(seq) AS seq FROM collie_run_lines WHERE run = ${run} AND journal = ${journal}
              `;
              let seq = last?.seq ?? -1;
              for (const line of lines)
                yield* sql`
                  INSERT INTO collie_run_lines (run, journal, seq, line)
                  VALUES (${run}, ${journal}, ${++seq}, ${line})
                `;
              yield* worked(run, journal);
            }).pipe(sql.withTransaction, Effect.andThen(moved(run)), Effect.orDie),
      fact: (run, name) => readFact(run, name).pipe(Effect.orDie),
      factsOf: (runs, name) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly data: string }>`
              SELECT run, data FROM collie_run_facts WHERE name = ${name} AND run IN ${sql.in(runs)}
            `.pipe(
              Effect.map((rows) => new Map(Arr.map(rows, (row) => [row.run, row.data] as const))),
              Effect.orDie,
            ),
      factsUnder: (run, prefix) =>
        sql<{ readonly name: string; readonly data: string }>`
          SELECT name, data FROM collie_run_facts
          WHERE run = ${run} AND substr(name, 1, ${prefix.length}) = ${prefix} ORDER BY name
        `.pipe(Effect.orDie),
      put: (run, name, value) =>
        writeFact(run, name, value).pipe(
          sql.withTransaction,
          Effect.andThen(moved(run)),
          Effect.orDie,
        ),
      update: (run, name, change) =>
        Effect.gen(function* () {
          const was = yield* readFact(run, name).pipe(Effect.orDie);
          const now = yield* change(was);
          if (now !== was) yield* writeFact(run, name, now).pipe(Effect.orDie);
          return now;
        }).pipe(
          sql.withTransaction,
          Effect.catchTag("SqlError", Effect.die),
          Effect.tap(() => moved(run)),
        ),
      activity: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly at: number }>`
              SELECT run, at FROM collie_run_activity WHERE run IN ${sql.in(runs)}
            `.pipe(
              Effect.map((rows) => new Map(Arr.map(rows, (row) => [row.run, row.at] as const))),
              Effect.orDie,
            ),
      stepSamples: sql
        .unsafe<{ readonly workflow: string; readonly step: string; readonly ms: number }>(
          `${stepSamplesOf}, every AS (
            SELECT workflow, step, at, ms FROM samples
            UNION ALL SELECT workflow, step, at, ms FROM collie_step_times
          ), ranked AS (
            SELECT workflow, step, ms,
              row_number() OVER (PARTITION BY workflow, step ORDER BY at DESC) AS nth
            FROM every
          )
          SELECT workflow, step, ms FROM ranked WHERE nth <= ${STEP_SAMPLES}`,
          [null],
        )
        .pipe(Effect.orDie),
      touch: (run) => worked(run, "").pipe(Effect.andThen(moved(run)), Effect.orDie),
      control: (control, run, key = "") =>
        sql<{ readonly data: string }>`
          SELECT data FROM collie_controls
          WHERE control = ${control} AND run = ${run} AND key = ${key}
        `.pipe(
          Effect.map(([row]) => row?.data ?? null),
          Effect.orDie,
        ),
      controlsOf: (control, run) =>
        sql<{ readonly key: string; readonly data: string }>`
          SELECT key, data FROM collie_controls WHERE control = ${control} AND run = ${run} ORDER BY key
        `.pipe(Effect.orDie),
      everyControl: (control) =>
        sql<{ readonly run: string; readonly key: string; readonly data: string }>`
          SELECT run, key, data FROM collie_controls WHERE control = ${control} ORDER BY run, key
        `.pipe(Effect.orDie),
      controlsIn: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<ControlRow & { readonly run: string }>`
              SELECT run, control, key, data FROM collie_controls WHERE run IN ${sql.in(runs)}
            `.pipe(
              Effect.map((rows) =>
                grouped(rows, (row): ControlRow => ({
                  control: row.control,
                  key: row.key,
                  data: row.data,
                })),
              ),
              Effect.orDie,
            ),
      setControl: (control, run, data, key = "") =>
        (data === null
          ? sql`DELETE FROM collie_controls WHERE control = ${control} AND run = ${run} AND key = ${key}`
          : sql`
              INSERT INTO collie_controls (control, run, key, data) VALUES (${control}, ${run}, ${key}, ${data})
              ON CONFLICT (control, run, key) DO UPDATE SET data = excluded.data
            `
        ).pipe(Effect.andThen(moved(run)), Effect.orDie),
    } satisfies RunRecordsApi;
  }),
);
