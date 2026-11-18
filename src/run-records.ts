import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Clock, Context, Effect, Layer, Option } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { StoreWrites } from "./store-writes";

export const RUN_RECORDS_MIGRATION_ID = 25;
export const RUN_RECORDS_MIGRATION = `${RUN_RECORDS_MIGRATION_ID}_run_records`;

export const AREAS = ["runs", "evidence"] as const;

export const recordName = (area: (typeof AREAS)[number], path: string) =>
  area === "runs" ? path : `${area}/${path}`;

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

export const TEXT_JOURNALS: ReadonlySet<string> = new Set(["steering/carded"]);

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

export const LEGACY_FACT_PREFIXES: ReadonlyArray<string> = [
  "steering/progress/",
  "steering/externals.",
];

export const LEGACY_CONTROLS: ReadonlyArray<string> = [
  "hold",
  "stop",
  "parked",
  "park-info",
  "park-cause",
  "awaiting",
  "usage",
];
export const NOTIFIED = "notified";
export const AWAITED = "awaited";
export const RELAUNCH = "relaunch";
export const RUNNING_CHECK = "running-check";

export const addressOf = (dir: string) => {
  const run = runOfDir(dir);
  const parent = runOfDir(parentOf(dir));
  return { run, prefix: parent === "runs" || parent === "" ? "" : `${parent}/` };
};

export const STEPS = "steps.jsonl";

export const RUN_RECORDS = "collie/run-records";

const lastSlash = (path: string) => Option.getOrElse(Str.lastIndexOf("/")(path), () => -1);

export const runOfDir = (dir: string) => Str.slice(lastSlash(dir) + 1)(dir);

export const parentOf = (path: string) => Str.slice(0, Math.max(0, lastSlash(path)))(path);

export interface RunRecordsApi {
  readonly lines: (run: string, journal: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly linesOf: (
    runs: ReadonlyArray<string>,
    journal: string,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly lastOf: (
    runs: ReadonlyArray<string>,
    journal: string,
    kinds: ReadonlyArray<string> | null,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly briefsOf: (
    runs: ReadonlyArray<string>,
    journal: string,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly append: (
    run: string,
    journal: string,
    lines: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly fact: (run: string, name: string) => Effect.Effect<string | null>;
  readonly factsOf: (
    runs: ReadonlyArray<string>,
    name: string,
  ) => Effect.Effect<ReadonlyMap<string, string>>;
  readonly factsUnder: (
    run: string,
    prefix: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly data: string }>>;
  readonly put: (run: string, name: string, value: string | null) => Effect.Effect<void>;
  readonly update: <E, R>(
    run: string,
    name: string,
    change: (value: string | null) => Effect.Effect<string | null, E, R>,
  ) => Effect.Effect<string | null, E, R>;
  readonly activity: (runs: ReadonlyArray<string>) => Effect.Effect<ReadonlyMap<string, number>>;
  readonly stepSamples: Effect.Effect<
    ReadonlyArray<{ readonly workflow: string; readonly step: string; readonly ms: number }>
  >;
  readonly touch: (run: string) => Effect.Effect<void>;
  readonly control: (control: string, run: string, key?: string) => Effect.Effect<string | null>;
  readonly controlsOf: (
    control: string,
    run: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly key: string; readonly data: string }>>;
  readonly everyControl: (
    control: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly run: string; readonly key: string; readonly data: string }>
  >;
  readonly controlsIn: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<ControlRow>>>;
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

export const BOOKKEEPING: ReadonlySet<string> = new Set([
  "operations.jsonl",
  "steering/disposition.jsonl",
  "steering/seen.jsonl",
]);

const STEP_SAMPLES = 10;

const stepSamplesOf = `WITH leaves AS (
    SELECT l.run, l.key, json_extract(l.line, '$.at') AS at, r.workflow,
      row_number() OVER (PARTITION BY l.run, l.key ORDER BY json_extract(l.line, '$.at') DESC) AS nth
    FROM collie_run_lines l JOIN collie_runs r ON r.run = l.run
    WHERE l.journal = '${STEPS}' AND l.kind = 'leave' AND (?1 IS NULL OR l.run = ?1)
  ), entered AS (
    SELECT run, key, min(seq) AS seq FROM collie_run_lines
    WHERE journal = '${STEPS}' AND kind = 'enter' AND (?1 IS NULL OR run = ?1) GROUP BY run, key
  ), timed AS (
    SELECT leaves.run, leaves.key, leaves.workflow, json_extract(e.line, '$.step.id') AS step, leaves.at,
      CAST(round((julianday(leaves.at) - julianday(json_extract(e.line, '$.at'))) * 86400000) AS INTEGER) AS ms
    FROM leaves
    JOIN entered ON entered.run = leaves.run AND entered.key = leaves.key
    JOIN collie_run_lines e ON e.run = entered.run AND e.journal = '${STEPS}' AND e.seq = entered.seq
    WHERE leaves.nth = 1
  ), samples AS (SELECT run, key, workflow, step, at, ms FROM timed WHERE ms >= 0)`;

export const readAhead: (records: RunRecordsApi, runs: ReadonlyArray<string>) => RunRecordsApi = (
  records,
  runs,
) => {
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
  const brief = once((name) => records.briefsOf(runs, name));
  const fact = once((name) => records.factsOf(runs, name));
  const last = once((key) => {
    const [name, ...kinds] = Str.split(key, "\u0000");
    return records.lastOf(runs, name, kinds.length === 0 ? null : kinds);
  });
  const activity = once(() => records.activity(runs));
  const controls = once((name) =>
    Effect.map(records.everyControl(name), (rows) => Arr.groupBy(rows, (row) => row.run)),
  );
  const only = <A>(all: ReadonlyMap<string, A>, some: ReadonlyArray<string>) =>
    new Map(Arr.flatMap(some, (run) => (all.has(run) ? [[run, all.get(run)!] as const] : [])));
  return {
    ...records,
    lines: (run, name) =>
      ids.has(run)
        ? Effect.map(journal(name), (all) => all.get(run) ?? [])
        : records.lines(run, name),
    briefsOf: (some, name) =>
      Arr.every(some, (run) => ids.has(run))
        ? Effect.map(brief(name), (all) => only(all, some))
        : records.briefsOf(some, name),
    lastOf: (some, name, kinds) =>
      Arr.every(some, (run) => ids.has(run))
        ? Effect.map(last(Arr.join([name, ...(kinds ?? [])], "\u0000")), (all) => only(all, some))
        : records.lastOf(some, name, kinds),
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
        ? Effect.map(activity(""), (all) => only(all, some))
        : records.activity(some),
  };
};

export const keepStepTimes = (run: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(
      `${stepSamplesOf} INSERT OR REPLACE INTO collie_step_times (run, key, workflow, step, at, ms)
        SELECT run, key, workflow, step, at, ms FROM samples`,
      [run],
    );
    yield* trimStepTimes;
  });

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
    const returned: RunRecordsApi = {
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
      briefsOf: (runs, journal) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly brief: string }>`
              SELECT run, brief FROM collie_run_lines
              WHERE journal = ${journal} AND run IN ${sql.in(runs)} AND brief IS NOT NULL
              ORDER BY run, seq
            `.pipe(
              Effect.map((rows) => grouped(rows, (row) => row.brief)),
              Effect.orDie,
            ),
      lastOf: (runs, journal, kinds) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : (kinds === null
              ? sql.unsafe<{ readonly run: string; readonly line: string }>(
                  `WITH asked(run) AS (VALUES ${Arr.join(
                    Arr.map(runs, () => "(?)"),
                    ",",
                  )})
                    SELECT run, line FROM (
                      SELECT run, (
                        SELECT line FROM collie_run_lines
                        WHERE run = asked.run AND journal = ? ORDER BY seq DESC LIMIT 1
                      ) AS line FROM asked
                    ) WHERE line IS NOT NULL`,
                  [...runs, journal],
                )
              : sql<{ readonly run: string; readonly line: string }>`
                  SELECT run, line FROM collie_run_lines
                  WHERE journal = ${journal} AND kind IN ${sql.in(kinds)} AND run IN ${sql.in(runs)}
                  ORDER BY run, seq DESC
                `
            ).pipe(
              Effect.map((rows) => grouped(rows, (row) => row.line)),
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
              if (journal === STEPS)
                yield* keepStepTimes(run).pipe(Effect.provideService(SqlClient.SqlClient, sql));
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
      stepSamples: sql<{ readonly workflow: string; readonly step: string; readonly ms: number }>`
        SELECT workflow, step, ms FROM collie_step_times
      `.pipe(Effect.orDie),
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
                grouped(rows, (row) => ({
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
    };
    return returned;
  }),
);
