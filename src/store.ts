// The rows Collie owns, beside the executions Effect owns.
//
// Effect's engine is the authority on what a workflow has done — its journal, its
// activities, its deferreds — and none of that is copied here. What is here is the other
// half: which request claimed which run, which generation it was admitted on, and which
// execution it became. That is what makes a retry that arrives twice, or a host that dies
// between accepting work and saying so, end as one Run rather than two.
//
// Same SQLite file as the engine's own tables, in the state directory the host owns, so
// there is one connection and one thing to back up.
// `docs/adr/0017-one-request-is-one-run.md` is why each of these is the way it is.

import { Context, Effect, Layer, Schema, Stream } from "effect";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { nowIso } from "./time";

/**
 * A request id that was accepted for other arguments. Schema-backed, so a host can fail a
 * client with this value rather than a sentence about it: the caller is retrying something
 * it has changed its mind about, and changing an accepted request silently is the one
 * thing an idempotency key must never do.
 */
export class RequestConflict extends Schema.TaggedError<RequestConflict>()("RequestConflict", {
  request: Schema.String,
  reason: Schema.String,
}) {}

/** A run as it was admitted: the claim, the arguments and the native identity it became. */
const Run = Schema.Struct({
  run: Schema.String,
  request: Schema.String,
  workflow: Schema.String,
  project: Schema.String,
  /** The arguments as they were claimed, canonical, which is what a retry is compared to. */
  input: Schema.String,
  generation: Schema.String,
  execution: Schema.String,
  /** The Task this work belongs to, and the run it came out of; null where it is neither. */
  task: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  /** When the engine took this work, or null while it is still a host's to hand over. */
  accepted: Schema.NullOr(Schema.String),
});
export type RunRow = typeof Run.Type;

/** A generation a host registered, so the next host can rebuild it from current files. */
const Generation = Schema.Struct({
  name: Schema.String,
  workflow: Schema.String,
  entry: Schema.String,
});
export type GenerationRow = typeof Generation.Type;

/** What a start asks to have recorded before anything is executed. */
export interface Admission {
  readonly request: string;
  readonly run: string;
  readonly workflow: string;
  readonly project: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly generation: string;
  readonly execution: string;
  readonly task: string | null;
  readonly parent: string | null;
}

export interface StoreApi {
  readonly remember: (generation: GenerationRow) => Effect.Effect<void>;
  readonly generations: Effect.Effect<ReadonlyArray<GenerationRow>>;
  /**
   * Claims a request id for a run, or hands back the run that already has it. `fresh` is
   * false for a retry, which is what tells a caller not to execute again.
   */
  readonly admit: (
    admission: Admission,
  ) => Effect.Effect<{ readonly row: RunRow; readonly fresh: boolean }, RequestConflict>;
  /** The engine has this work: the receipt a crash before it is what recovery looks for. */
  readonly accepted: (run: string) => Effect.Effect<void>;
  readonly pending: Effect.Effect<ReadonlyArray<RunRow>>;
  readonly run: (run: string) => Effect.Effect<RunRow | null>;
  readonly runs: Effect.Effect<ReadonlyArray<RunRow>>;
  /** Whatever this reads, again, whenever a run changes. */
  readonly watching: <A, E>(read: Effect.Effect<A, E>) => Stream.Stream<A, E>;
  /** Every run, again, whenever one is committed. */
  readonly changes: Stream.Stream<ReadonlyArray<RunRow>>;
  /** A run changed where the change was not one of these writes, so readers reread. */
  readonly announce: Effect.Effect<void>;
}

export class Store extends Context.Service<Store, StoreApi>()("collie/native/Store") {}

export const storeLayer: Layer.Layer<Store, never, SqlClient.SqlClient | Reactivity.Reactivity> =
  Layer.effect(Store)(makeStore());

/** What a committed write invalidates, and what a subscriber is listening for. */
const RUNS = ["collie/runs"];

const MIGRATIONS = {
  "1_runs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_generations (
        name TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        entry TEXT NOT NULL,
        at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE collie_runs (
        run TEXT PRIMARY KEY,
        request TEXT NOT NULL UNIQUE,
        workflow TEXT NOT NULL,
        project TEXT NOT NULL,
        input TEXT NOT NULL,
        generation TEXT NOT NULL,
        execution TEXT NOT NULL,
        admitted TEXT NOT NULL,
        accepted TEXT
      )
    `;
  }),
  "2_belongs": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN task TEXT`;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN parent TEXT`;
  }),
};

function makeStore(): Effect.Effect<StoreApi, never, SqlClient.SqlClient | Reactivity.Reactivity> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    // Before anything reads a table: a database that will not migrate is a broken host,
    // not a request that failed.
    yield* SqliteMigrator.run({
      loader: Migrator.fromRecord(MIGRATIONS),
      table: "collie_migrations",
    }).pipe(Effect.orDie);

    const columns = sql`run, request, workflow, project, input, generation, execution, task, parent, accepted`;

    const byRequest = SqlSchema.findAll({
      Request: Schema.String,
      Result: Run,
      execute: (request) => sql`SELECT ${columns} FROM collie_runs WHERE request = ${request}`,
    });

    const byRun = SqlSchema.findAll({
      Request: Schema.String,
      Result: Run,
      execute: (run) => sql`SELECT ${columns} FROM collie_runs WHERE run = ${run}`,
    });

    const everyRun = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Run,
      execute: () => sql`SELECT ${columns} FROM collie_runs ORDER BY admitted, run`,
    });

    const unaccepted = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Run,
      execute: () =>
        sql`SELECT ${columns} FROM collie_runs WHERE accepted IS NULL ORDER BY admitted, run`,
    });

    const everyGeneration = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Generation,
      execute: () => sql`SELECT name, workflow, entry FROM collie_generations ORDER BY rowid`,
    });

    const all = everyRun().pipe(Effect.orDie);

    return {
      remember: (generation: GenerationRow) =>
        Effect.gen(function* () {
          const at = yield* nowIso();
          yield* sql`
            INSERT INTO collie_generations (name, workflow, entry, at)
            VALUES (${generation.name}, ${generation.workflow}, ${generation.entry}, ${at})
            ON CONFLICT(name) DO NOTHING
          `;
        }).pipe(Effect.orDie),

      generations: everyGeneration().pipe(Effect.orDie),

      admit: Effect.fn("Store.admit")(function* (admission: Admission) {
        const input = canonical(admission.input);
        const at = yield* nowIso();
        // The claim is the insert, and what it returns is whether this caller made it:
        // one request id, one row, decided by the database rather than by a read another
        // caller could be between.
        const claimed = yield* reactivity
          .mutation(
            RUNS,
            sql`
              INSERT INTO collie_runs
                (run, request, workflow, project, input, generation, execution,
                 task, parent, admitted)
              VALUES (
                ${admission.run}, ${admission.request}, ${admission.workflow},
                ${admission.project}, ${input}, ${admission.generation},
                ${admission.execution}, ${admission.task}, ${admission.parent}, ${at}
              )
              ON CONFLICT(request) DO NOTHING
              RETURNING run
            `,
          )
          .pipe(Effect.orDie);

        const [row] = yield* byRequest(admission.request).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* Effect.die(new Error(`request "${admission.request}" claimed nothing`));
        }
        if (claimed.length > 0) return { row, fresh: true };
        if (
          row.workflow !== admission.workflow ||
          row.project !== admission.project ||
          row.input !== input
        ) {
          return yield* new RequestConflict({
            request: admission.request,
            reason: `request "${admission.request}" is already ${row.run}, started for "${row.workflow}" in ${row.project} with other arguments`,
          });
        }
        return { row, fresh: false };
      }),

      accepted: (run: string) =>
        Effect.gen(function* () {
          const at = yield* nowIso();
          yield* reactivity.mutation(
            RUNS,
            sql`UPDATE collie_runs SET accepted = ${at} WHERE run = ${run}`,
          );
        }).pipe(Effect.orDie),

      pending: unaccepted().pipe(Effect.orDie),
      runs: all,
      run: (run: string) =>
        byRun(run).pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.orDie,
        ),
      watching: (read) => reactivity.stream(RUNS, read),
      changes: sql.reactive(RUNS, all),
      announce: reactivity.invalidate(RUNS),
    } satisfies StoreApi;
  });
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));
const asJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * The same arguments written the same way, so a retry is compared rather than guessed at:
 * two objects that differ only in the order their keys arrived are one request.
 */
const canonical = (value: Schema.Json): string => asJsonText(ordered(value));

const ordered = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(ordered);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(value[key] ?? null)]),
  );
};
