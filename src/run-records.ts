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
  "recovery-parent",
  "steering/judged.json",
  "evidence/approved.json",
];

/** Facts an older build kept one file each beside others of their kind, by name prefix. */
export const LEGACY_FACT_PREFIXES: ReadonlyArray<string> = [
  "steering/progress/",
  "steering/externals.",
];

/** A Run directory's records: the Run, and what its records' names start with. */
export const addressOf = (dir: string) => {
  const run = runOfDir(dir);
  const parent = runOfDir(parentOf(dir));
  return { run, prefix: parent === "runs" || parent === "" ? "" : `${parent}/` };
};

/** The journal of a Run's Steps. */
export const STEPS = "steps.jsonl";

/** What a write to a Run's records invalidates. */
export const RUN_RECORDS = "collie/run-records";

/** A Run's directory names its Run. */
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
        : Effect.flatMap(
            Clock.currentTimeMillis,
            (now) => sql`
              INSERT INTO collie_run_activity (run, at) VALUES (${run}, ${now})
              ON CONFLICT (run) DO UPDATE SET at = max(at, excluded.at)
            `,
          );
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
      stepSamples: sql<{ readonly workflow: string; readonly step: string; readonly ms: number }>`
        WITH leaves AS (
          SELECT l.run, l.key, json_extract(l.line, '$.at') AS at, r.workflow,
            row_number() OVER (PARTITION BY l.run, l.key ORDER BY json_extract(l.line, '$.at') DESC) AS nth
          FROM collie_run_lines l JOIN collie_runs r ON r.run = l.run
          WHERE l.journal = ${STEPS} AND l.kind = 'leave'
        ), entered AS (
          SELECT run, key, min(seq) AS seq FROM collie_run_lines
          WHERE journal = ${STEPS} AND kind = 'enter' GROUP BY run, key
        ), samples AS (
          SELECT leaves.workflow, json_extract(e.line, '$.step.id') AS step, leaves.at,
            CAST(round((julianday(leaves.at) - julianday(json_extract(e.line, '$.at'))) * 86400000) AS INTEGER) AS ms
          FROM leaves
          JOIN entered ON entered.run = leaves.run AND entered.key = leaves.key
          JOIN collie_run_lines e ON e.run = entered.run AND e.journal = ${STEPS} AND e.seq = entered.seq
          WHERE leaves.nth = 1
        ), ranked AS (
          SELECT workflow, step, ms,
            row_number() OVER (PARTITION BY workflow, step ORDER BY at DESC) AS nth
          FROM samples WHERE ms >= 0
        )
        SELECT workflow, step, ms FROM ranked WHERE nth <= 10
      `.pipe(Effect.orDie),
      touch: (run) => worked(run, "").pipe(Effect.andThen(moved(run)), Effect.orDie),
    } satisfies RunRecordsApi;
  }),
);
