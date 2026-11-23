import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Option,
  Order,
  Schedule,
  Schema,
  Semaphore,
  Stream,
  flow,
  Result,
} from "effect";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Migrator from "effect/sql/Migrator";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { AuditLine, whoActed } from "./audit";
import {
  importLaunches,
  importReports,
  importLedgers,
  importProposals,
  importRegisters,
  importTasks,
  importRunRecords,
} from "./records-import";
import { StoreWrites } from "./store-writes";
import { RUN_RECORDS_MIGRATION } from "./run-records";
import { RequestConflict, RunReport, type Solution } from "./board-model";
import { nowIso } from "./time";
import { Observed, WatchCursor, Woke } from "./mr-watch-model";
import { ShippingGo } from "./shipping";
import { PROOF_SQL } from "./verify-model";

const Run = Schema.Struct({
  run: Schema.String,
  request: Schema.String,
  workflow: Schema.String,
  project: Schema.String,
  input: Schema.String,
  generation: Schema.String,
  execution: Schema.String,
  task: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
  provenance: Schema.NullOr(Schema.String),
  options: Schema.NullOr(Schema.String),
  checkout: Schema.NullOr(Schema.String),
  asked: Schema.NullOr(Schema.String),
  // WARNING: so a placement a crash cut short is made again.
  placing: Schema.NullOr(Schema.String),
  report: Schema.NullOr(Schema.String),
  admitted: Schema.String,
  accepted: Schema.NullOr(Schema.String),
});
export type RunRow = typeof Run.Type;

const RUN_FIELDS = Struct.keys(Run.fields);

const nearOf = (rows: ReadonlyArray<RunRow>, run: string) => {
  const self = Option.getOrUndefined(Arr.findFirst(rows, (row) => row.run === run));
  const own = Arr.filter(rows, (row) =>
    self?.task == null ? row === self : row.task === self.task,
  );
  const runs = new Set(Arr.map(own, (row) => row.run));
  const parents = new Set(Arr.map(own, (row) => row.parent));
  return Arr.filter(
    rows,
    (row) =>
      runs.has(row.run) ||
      parents.has(row.run) ||
      (row.parent !== null && runs.has(row.parent)) ||
      /requestedby/i.test(row.placing ?? ""),
  );
};

const byAdmission = Order.mapInput(
  Order.Tuple([Order.String, Order.String]),
  (row: RunRow) => [row.admitted, row.run] as const,
);

export const sameRow = (one: RunRow, other: RunRow) =>
  one === other || Arr.every(RUN_FIELDS, (field) => one[field] === other[field]);

const Decision = Schema.Struct({
  run: Schema.String,
  decision: Schema.String,
  prompt: Schema.String,
  options: Schema.String,
  answer: Schema.NullOr(Schema.String),
  request: Schema.NullOr(Schema.String),
  asker: Schema.NullOr(Schema.String),
  answerer: Schema.NullOr(Schema.fromJsonString(AuditLine.fields.actor)),
  asked: Schema.String,
  answered: Schema.NullOr(Schema.String),
  superseded: Schema.NullOr(Schema.String),
  cause: Schema.NullOr(Schema.String),
  superseder: Schema.NullOr(Schema.fromJsonString(AuditLine.fields.actor)),
  messaged: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(Schema.Struct({ agent: Schema.String, at: Schema.String }))),
  ),
  revises: Schema.NullOr(Schema.String),
  reached: Schema.NullOr(Schema.String),
  shortfall: Schema.NullOr(Schema.String),
  shipping: Schema.NullOr(Schema.fromJsonString(ShippingGo)),
});
export type DecisionRow = typeof Decision.Type;

export const isUnanswered = (one: {
  readonly answer: string | null;
  readonly superseded?: string | null | undefined;
}) => one.answer === null && (one.superseded ?? null) === null;

export const isSuperseded = (one: {
  readonly answer: string | null;
  readonly superseded?: string | null | undefined;
}) => one.answer === null && (one.superseded ?? null) !== null;

export const isSetAside = <
  A extends {
    readonly name: string;
    readonly answer: string | null;
    readonly superseded?: string | null | undefined;
    readonly asker?: string | null | undefined;
    readonly revises?: string | null | undefined;
  },
>(
  all: ReadonlyArray<A>,
  one: A,
) =>
  isSuperseded(one) &&
  (one.asker ?? null) === null &&
  !Arr.some(all, (r) => r.revises === one.name);

export const supersededReason = (one: {
  readonly name: string;
  readonly superseded?: string | null | undefined;
  readonly cause?: string | null | undefined;
}) => `"${one.name}" was superseded at ${one.superseded} by ${one.cause}`;

export type Superseded =
  | { readonly _tag: "accepted"; readonly row: DecisionRow }
  | { readonly _tag: "refused"; readonly reason: string };

export type Answered =
  | { readonly _tag: "accepted"; readonly row: DecisionRow }
  | { readonly _tag: "repeat"; readonly row: DecisionRow }
  | { readonly _tag: "refused"; readonly reason: string };

const Generation = Schema.Struct({
  name: Schema.String,
  workflow: Schema.String,
  entry: Schema.String,
});
export type GenerationRow = typeof Generation.Type;

export interface Admission {
  readonly request: string;
  readonly run: string;
  readonly workflow: string;
  readonly project: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly provenance: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, string>>;
  readonly generation: string;
  readonly execution: string;
  readonly task: string | null;
  readonly parent: string | null;
  readonly placing?: string;
  readonly attachments?: ReadonlyArray<string>;
}

type AskedFor = {
  readonly options: Readonly<Record<string, string>>;
  readonly task: string | null;
  readonly parent: string | null;
  attachments?: ReadonlyArray<string>;
};

export interface WatchRow {
  readonly run: string;
  readonly mr: string;
  readonly name: string;
  readonly cursor: WatchCursor;
  readonly observed: Observed | null;
  readonly woke: Woke | null;
}

export interface StoreApi {
  readonly remember: (generation: GenerationRow) => Effect.Effect<void>;
  // WARNING: replaying the wait says it again and changes nothing.
  readonly asking: (question: {
    readonly run: string;
    readonly decision: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string | Solution>;
    readonly asker?: string;
    readonly revises?: string;
    readonly shortfall?: string;
    readonly shipping?: ShippingGo;
  }) => Effect.Effect<void>;
  readonly asked: (run: string) => Effect.Effect<ReadonlyArray<DecisionRow>>;
  readonly askedOf: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<DecisionRow>>>;
  readonly settle: (answer: {
    readonly run: string;
    readonly decision: string;
    readonly value: string;
    readonly request: string;
    readonly answerer?: AuditLine["actor"] | undefined;
  }) => Effect.Effect<Answered>;
  readonly supersede: (superseding: {
    readonly run: string;
    readonly decision: string;
    readonly cause: string;
    readonly actor: AuditLine["actor"];
    readonly agent: string;
  }) => Effect.Effect<Superseded>;
  // WARNING: the guard is the database's: ordered against the messaged agent's answer and any newer message.
  readonly revise: (revising: {
    readonly run: string;
    readonly decision: string;
    readonly name: string;
    readonly messaged: NonNullable<DecisionRow["messaged"]>;
  }) => Effect.Effect<boolean>;
  readonly setAside: Effect.Effect<ReadonlyArray<DecisionRow>>;
  readonly supersedable: Effect.Effect<ReadonlyArray<DecisionRow>>;
  readonly alsoMessaged: (messaging: {
    readonly run: string;
    readonly decision: string;
    readonly agent: string;
  }) => Effect.Effect<DecisionRow | undefined>;
  readonly generations: Effect.Effect<ReadonlyArray<GenerationRow>>;
  readonly admit: (
    admission: Admission,
  ) => Effect.Effect<{ readonly row: RunRow; readonly fresh: boolean }, RequestConflict>;
  readonly place: (
    run: string,
    placed: { readonly checkout: string; readonly task: string | null },
  ) => Effect.Effect<RunRow>;
  readonly recordPlacing: (run: string, placing: string) => Effect.Effect<void>;
  readonly forget: (run: string) => Effect.Effect<void>;
  // WARNING: a row the engine never accepted is left, for recovery to hand over.
  readonly retire: <E>(
    runs: ReadonlyArray<string>,
    clear: (row: RunRow) => Effect.Effect<void, E>,
  ) => Effect.Effect<ReadonlyArray<string>, E>;
  // WARNING: the engine has this work; a crash before this receipt is what recovery looks for.
  readonly accepted: (run: string) => Effect.Effect<void>;
  readonly pending: Effect.Effect<ReadonlyArray<RunRow>>;
  readonly reportsPending: Effect.Effect<ReadonlyArray<RunRow>>;
  readonly reported: (run: string, report: RunReport) => Effect.Effect<void>;
  readonly run: (run: string) => Effect.Effect<RunRow | null>;
  readonly requested: (request: string) => Effect.Effect<RunRow | null>;
  readonly releaseClaim: (row: RunRow) => Effect.Effect<void>;
  readonly requestedEnding: (suffix: string) => Effect.Effect<RunRow | null>;
  readonly runs: Effect.Effect<ReadonlyArray<RunRow>>;
  readonly near: (run: string) => Effect.Effect<ReadonlyArray<RunRow>>;
  readonly watching: <A, E>(read: Effect.Effect<A, E>) => Stream.Stream<A, E>;
  readonly changes: Stream.Stream<ReadonlyArray<RunRow>>;
  readonly announce: Effect.Effect<void>;
  readonly decided: Effect.Effect<(run: string) => number>;
  readonly watch: (row: {
    readonly run: string;
    readonly mr: string;
    readonly name: string;
    readonly cursor: WatchCursor;
  }) => Effect.Effect<void>;
  readonly watches: (mrs: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<WatchRow>>;
  readonly observe: (run: string, name: string, observed: Observed) => Effect.Effect<void>;
  readonly wake: (run: string, name: string, woke: Woke) => Effect.Effect<boolean>;
  readonly unwatch: (run: string, name?: string) => Effect.Effect<boolean>;
}

export class Store extends Context.Service<Store, StoreApi>()("collie/Store") {}

export const storeLayer = (stateDir?: string) => Layer.effect(Store)(makeStore(stateDir));

const RUNS = ["collie/runs"];

const field = (name: string) =>
  `CASE WHEN json_valid(line) THEN json_extract(line, '$.${name}') END`;

type ImportError = Effect.Error<
  ReturnType<
    | typeof importLedgers
    | typeof importTasks
    | typeof importRegisters
    | typeof importProposals
    | typeof importLaunches
    | typeof importReports
    | typeof importRunRecords
  >
>;

const migrations = (imports: {
  readonly ledgers: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly tasks: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly registers: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly proposals: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly launches: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly reports: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly runRecords: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
}) => ({
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
  "3_settled": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN provenance TEXT`;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN options TEXT`;
  }),
  "6_checkout": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN checkout TEXT`;
  }),
  "7_asked": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN asked TEXT`;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN placing TEXT`;
  }),
  "8_asker": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN asker TEXT`;
  }),
  "9_answerer": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN answerer TEXT`;
  }),
  "10_superseded": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN superseded TEXT`;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN cause TEXT`;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN superseder TEXT`;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN messaged TEXT`;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN revises TEXT`;
  }),
  "11_reached": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN reached TEXT`;
  }),
  "4_decisions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_decisions (
        run TEXT NOT NULL,
        decision TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options TEXT NOT NULL,
        asked TEXT NOT NULL,
        answer TEXT,
        request TEXT,
        answered TEXT,
        PRIMARY KEY (run, decision)
      )
    `;
  }),
  "12_deliveries": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE collie_deliveries (
        seq INTEGER PRIMARY KEY,
        ledger TEXT NOT NULL,
        line TEXT NOT NULL,
        id TEXT AS (${field("id")}),
        run TEXT AS (${field("run")}),
        state TEXT AS (${field("state")}),
        kind TEXT AS (${field("kind")}),
        human INTEGER AS (${field("human")} IS NOT NULL),
        causal_key TEXT AS (${field("causal_key")})
      )
    `);
    yield* sql`CREATE INDEX collie_deliveries_ledger ON collie_deliveries (ledger, seq)`;
    yield* sql`CREATE INDEX collie_deliveries_run ON collie_deliveries (run, ledger, id)`;
    yield* sql`CREATE INDEX collie_deliveries_kind ON collie_deliveries (ledger, seq) WHERE kind IS NOT NULL`;
    yield* sql`CREATE INDEX collie_deliveries_human ON collie_deliveries (id, seq) WHERE human = 1`;
    yield* sql`CREATE INDEX collie_deliveries_causal ON collie_deliveries (ledger, causal_key, id)`;
    yield* imports.ledgers;
  }),
  "13_tasks": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_tasks (
        id TEXT PRIMARY KEY,
        record TEXT NOT NULL,
        workspace TEXT AS (json_extract(record, '$.workspace')),
        created_at TEXT AS (json_extract(record, '$.created_at'))
      )
    `;
    yield* sql`CREATE INDEX collie_tasks_workspace ON collie_tasks (workspace)`;
    yield* imports.tasks;
  }),
  "14_agents": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_agents (
        register TEXT NOT NULL,
        agent TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (register, agent)
      )
    `;
    yield* imports.registers;
  }),
  "15_proposals": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_proposals (
        seq INTEGER PRIMARY KEY,
        journal TEXT NOT NULL,
        line TEXT NOT NULL,
        kind TEXT AS (json_extract(line, '$.kind')),
        proposal TEXT AS (coalesce(json_extract(line, '$.proposal'), json_extract(line, '$.id')))
      )
    `;
    yield* sql`CREATE INDEX collie_proposals_journal ON collie_proposals (journal)`;
    yield* sql`CREATE INDEX collie_proposals_proposal ON collie_proposals (proposal)`;
    yield* sql`
      CREATE TABLE collie_proposal_runs (
        run TEXT NOT NULL,
        proposal TEXT NOT NULL,
        PRIMARY KEY (run, proposal)
      )
    `;
    yield* sql`
      CREATE TRIGGER collie_proposal_runs_of AFTER INSERT ON collie_proposals
      WHEN NEW.kind = 'proposal'
      BEGIN
        INSERT OR IGNORE INTO collie_proposal_runs (run, proposal)
        SELECT json_extract(value, '$.run'), NEW.proposal FROM json_each(NEW.line, '$.targets');
      END
    `;
    yield* imports.proposals;
  }),
  "16_shortfall": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN shortfall TEXT`;
  }),
  "17_launches": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_launches (
        run TEXT NOT NULL,
        stem TEXT NOT NULL,
        record TEXT NOT NULL,
        ordered INTEGER,
        ordered_at INTEGER,
        agent TEXT AS (json_extract(record, '$.agent')),
        PRIMARY KEY (run, stem)
      )
    `;
    yield* sql`CREATE INDEX collie_launches_agent ON collie_launches (agent)`;
    yield* imports.launches;
  }),
  "18_shipping_go": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_decisions ADD COLUMN shipping TEXT`;
  }),
  "19_reports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN report TEXT`;
    yield* imports.reports;
    yield* sql`ALTER TABLE collie_runs ADD COLUMN report_pending INTEGER AS (
      CASE WHEN json_valid(placing) THEN
        (json_extract(placing, '$.requestedBy') IS NOT NULL OR json_extract(placing, '$.closes') = 'reported')
        AND (report IS NULL OR (json_extract(placing, '$.closes') = 'reported' AND json_extract(report, '$.closed') = 0))
      ELSE 0 END
    )`;
    yield* sql`CREATE INDEX collie_runs_reports ON collie_runs (admitted, run) WHERE report_pending = 1`;
  }),
  "20_artefacts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE collie_artefacts (run TEXT NOT NULL, id TEXT NOT NULL, origin TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run, id), UNIQUE (run, origin))`;
    yield* sql`CREATE TABLE collie_artefact_revisions (run TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (run, id, revision))`;
    yield* sql`CREATE TABLE collie_artefact_receipts (run TEXT NOT NULL, request TEXT NOT NULL, asked TEXT NOT NULL, data TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (run, request))`;
  }),
  "21_artefact_registration": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE collie_artefact_registrations (run TEXT NOT NULL, request TEXT NOT NULL, asked TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run, request))`;
  }),
  "22_artefact_index": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE collie_artefact_index (run TEXT PRIMARY KEY, cursor TEXT NOT NULL, done INTEGER NOT NULL)`;
  }),
  "23_narrative_reports": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE collie_narratives (run TEXT NOT NULL, key TEXT NOT NULL, ordinal INTEGER NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run, key))`;
    yield* sql`CREATE TABLE collie_narrative_work (run TEXT PRIMARY KEY, cursor TEXT NOT NULL)`;
  }),
  "24_watches": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE collie_watches (
        run TEXT PRIMARY KEY,
        mr TEXT NOT NULL,
        name TEXT NOT NULL,
        cursor TEXT NOT NULL,
        observed TEXT,
        woke TEXT
      )
    `;
    yield* sql`CREATE INDEX collie_watches_mr ON collie_watches (mr)`;
  }),
  [RUN_RECORDS_MIGRATION]: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      CREATE TABLE collie_run_lines (
        run TEXT NOT NULL,
        journal TEXT NOT NULL,
        seq INTEGER NOT NULL,
        line TEXT NOT NULL,
        kind TEXT AS (coalesce(${field("kind")}, ${field("operation")})),
        key TEXT AS (${field("key")}),
        brief TEXT AS (${PROOF_SQL}) STORED,
        PRIMARY KEY (run, journal, seq)
      ) WITHOUT ROWID
    `);
    yield* sql`CREATE INDEX collie_run_lines_kind ON collie_run_lines (journal, kind, run, key) WHERE kind IS NOT NULL`;
    yield* sql`
      CREATE TABLE collie_run_facts (
        run TEXT NOT NULL,
        name TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (run, name)
      ) WITHOUT ROWID
    `;
    yield* sql`CREATE TABLE collie_run_activity (run TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID`;
    yield* sql`
      CREATE TABLE collie_controls (
        control TEXT NOT NULL,
        run TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (control, run, key)
      ) WITHOUT ROWID
    `;
    yield* sql`CREATE INDEX collie_controls_run ON collie_controls (run)`;
    yield* sql`
      CREATE TABLE collie_step_times (
        run TEXT NOT NULL,
        key TEXT NOT NULL,
        workflow TEXT NOT NULL,
        step TEXT NOT NULL,
        at TEXT NOT NULL,
        ms INTEGER NOT NULL,
        PRIMARY KEY (run, key)
      )
    `;
    yield* imports.runRecords;
  }),
});

const ELSEWHERE_EVERY = "250 millis";

function makeStore(stateDir: string | undefined) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const imported = (
      read: (
        stateDir: string,
      ) => Effect.Effect<
        void,
        ImportError,
        SqlClient.SqlClient | FileSystem.FileSystem | Path.Path
      >,
    ) => (stateDir === undefined ? Effect.void : Effect.provideContext(read(stateDir), files));
    // WARNING: a database that will not migrate is a broken host, not a request that failed.
    yield* SqliteMigrator.run({
      loader: Migrator.fromRecord(
        migrations({
          ledgers: imported(importLedgers),
          tasks: imported(importTasks),
          registers: imported(importRegisters),
          proposals: imported(importProposals),
          launches: imported(importLaunches),
          reports: imported(importReports),
          runRecords: imported(importRunRecords),
        }),
      ),
      table: "collie_migrations",
    }).pipe(Effect.orDie);
    // WARNING: SQLite moves data_version only for another connection's commits.
    const dataVersion = sql<{ readonly data_version: number }>`PRAGMA data_version`.pipe(
      Effect.map((rows) => rows[0]?.data_version ?? 0),
      Effect.orElseSucceed(() => 0),
    );
    let seen = yield* dataVersion;
    let written = 0;
    let dirty: Set<string> | "all" = "all";
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const wrote = (runs?: ReadonlyArray<string>) =>
      Effect.sync(() => {
        written++;
        // WARNING: another connection's commit names no Run, and only the host writes a Run's row.
        if (runs !== undefined) told?.(runs);
        if (runs === undefined) dirty = "all";
        else if (dirty !== "all") for (const run of runs) dirty.add(run);
      });
    const invalidate = Effect.andThen(wrote(), reactivity.invalidate(RUNS));
    const mutation = <A, E, R>(runs: ReadonlyArray<string>, effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation(RUNS, Effect.ensuring(effect, wrote(runs)));
    let elsewhere = 0;
    const decisions = new Map<string, number>();
    const decide = (run: string) =>
      Effect.sync(() => {
        decisions.set(run, (decisions.get(run) ?? 0) + 1);
        told?.([run]);
      });
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const now = yield* dataVersion;
        if (now === seen) return;
        seen = now;
        elsewhere++;
        yield* invalidate;
      }).pipe(Effect.repeat(Schedule.spaced(ELSEWHERE_EVERY))),
    );

    const columns = sql`run, request, workflow, project, input, generation, execution, task, parent, provenance, options, checkout, asked, placing, report, admitted, accepted`;

    const byRequest = SqlSchema.findAll({
      Request: Schema.String,
      Result: Run,
      execute: (request) => sql`SELECT ${columns} FROM collie_runs WHERE request = ${request}`,
    });

    const byRequestEnding = SqlSchema.findAll({
      Request: Schema.String,
      Result: Run,
      execute: (suffix) =>
        sql`SELECT ${columns} FROM collie_runs WHERE substr(request, ${-suffix.length}) = ${suffix}`,
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

    const reportsPending = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Run,
      execute: () =>
        sql`SELECT ${columns} FROM collie_runs WHERE report_pending = 1 ORDER BY admitted, run`,
    });
    const encodeReport = flow(
      Schema.encodeResult(Schema.fromJsonString(RunReport)),
      Result.getOrThrow,
    );

    const decisionColumns = sql`run, decision, prompt, options, answer, request, asker, answerer, asked, answered, superseded, cause, superseder, messaged, revises, reached, shortfall, shipping`;

    const decisionsOf = SqlSchema.findAll({
      Request: Schema.String,
      Result: Decision,
      execute: (run) =>
        sql`SELECT ${decisionColumns} FROM collie_decisions WHERE run = ${run} ORDER BY asked, decision`,
    });

    const decisionsOfRuns = SqlSchema.findAll({
      Request: Schema.Array(Schema.String),
      Result: Decision,
      execute: (runs) =>
        sql`SELECT ${decisionColumns} FROM collie_decisions WHERE run IN ${sql.in(runs)} ORDER BY run, asked, decision`,
    });

    const decodeDecisions = Schema.decodeUnknownEffect(Schema.Array(Decision));

    const decisionRow = SqlSchema.findAll({
      Request: Schema.Struct({ run: Schema.String, decision: Schema.String }),
      Result: Decision,
      execute: (key) =>
        sql`SELECT ${decisionColumns} FROM collie_decisions WHERE run = ${key.run} AND decision = ${key.decision}`,
    });

    const setAsideRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Decision,
      execute: () =>
        sql`SELECT ${decisionColumns} FROM collie_decisions
          WHERE asker IS NULL AND answer IS NULL AND superseded IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM collie_decisions revision
              WHERE revision.run = collie_decisions.run AND revision.revises = collie_decisions.decision
            )
          ORDER BY run, asked`,
    });

    const supersedableRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Decision,
      execute: () =>
        sql`SELECT ${decisionColumns} FROM collie_decisions
          WHERE answer IS NULL AND (superseded IS NULL OR (asker IS NULL AND NOT EXISTS (
            SELECT 1 FROM collie_decisions revision
            WHERE revision.run = collie_decisions.run AND revision.revises = collie_decisions.decision
          )))
          ORDER BY run, asked`,
    });

    const whyClosed = Effect.fn("Store.whyClosed")(function* (row: DecisionRow) {
      if (row.answer !== null)
        return `"${row.decision}" was already answered "${row.answer}"${row.answerer === null ? "" : ` by ${whoActed(row.answerer)}`}`;
      const rows = yield* decisionsOf(row.run).pipe(Effect.orDie);
      let newest: DecisionRow | undefined;
      let next = Arr.findFirst(rows, (one) => one.revises === row.decision);
      while (Option.isSome(next)) {
        const revision = next.value;
        newest = revision;
        next = Arr.findFirst(rows, (one) => one.revises === revision.decision);
      }
      const why = supersededReason({ ...row, name: row.decision });
      return newest === undefined ? why : `${why}; answer "${newest.decision}" instead`;
    });

    const everyGeneration = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Generation,
      execute: () => sql`SELECT name, workflow, entry FROM collie_generations ORDER BY rowid`,
    });

    let read: { readonly at: number; readonly rows: ReadonlyArray<RunRow> } | null = null;
    const refreshing = Semaphore.makeUnsafe(1);
    const refresh = Effect.suspend(() => {
      if (read?.at === written) return Effect.succeed(read.rows);
      const at = written;
      const which = dirty;
      dirty = new Set();
      const kept = read?.rows ?? [];
      const fresh =
        which === "all" || read === null
          ? everyRun()
          : Effect.map(
              Effect.forEach([...which], (run) => byRun(run)),
              (written) => {
                const now = new Map(Arr.map(written.flat(), (row) => [row.run, row] as const));
                const rows = Arr.filter(kept, (row) => !which.has(row.run) || now.has(row.run));
                const known = new Set(Arr.map(rows, (row) => row.run));
                const added = Arr.filter([...now.values()], (row) => !known.has(row.run));
                const merged = Arr.map(rows, (row) => now.get(row.run) ?? row);
                return added.length === 0 ? merged : Arr.sort([...merged, ...added], byAdmission);
              },
            );
      return fresh.pipe(
        Effect.orDie,
        Effect.map((fresh) => {
          const before = new Map(Arr.map(kept, (row) => [row.run, row] as const));
          const rows = Arr.map(fresh, (row) => {
            const was = before.get(row.run);
            return was !== undefined && sameRow(was, row) ? was : row;
          });
          read = { at, rows };
          return rows;
        }),
        Effect.onError(() =>
          Effect.sync(() => {
            if (which === "all") dirty = "all";
            else if (dirty !== "all") for (const run of which) dirty.add(run);
          }),
        ),
      );
    });
    const all = Effect.suspend(() =>
      read?.at === written ? Effect.succeed(read.rows) : refreshing.withPermit(refresh),
    );

    const returned: StoreApi = {
      remember: (generation: GenerationRow) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* sql`
            INSERT INTO collie_generations (name, workflow, entry, at)
            VALUES (${generation.name}, ${generation.workflow}, ${generation.entry}, ${at})
            ON CONFLICT(name) DO NOTHING
          `;
        }).pipe(Effect.orDie),

      generations: everyGeneration().pipe(Effect.orDie),

      asking: (question) =>
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* sql`
              INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker, revises, reached, shortfall, shipping)
              VALUES (
                ${question.run}, ${question.decision}, ${question.prompt},
                ${asJsonText([...question.options])}, ${at}, ${question.asker ?? null},
                ${question.revises ?? null}, ${question.asker === undefined ? at : null},
                ${question.shortfall ?? null}, ${question.shipping === undefined ? null : asJsonText(question.shipping)}
              )
              ON CONFLICT(run, decision) DO UPDATE SET reached = excluded.reached
                WHERE excluded.reached IS NOT NULL
            `;
          yield* decide(question.run);
          yield* wrote([question.run]);
          yield* reactivity.invalidate(RUNS);
        }).pipe(Effect.orDie),

      asked: (run: string) => decisionsOf(run).pipe(Effect.orDie),
      askedOf: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : decisionsOfRuns(runs).pipe(
              Effect.map((rows) => {
                const byRun = new Map<string, Array<DecisionRow>>();
                for (const row of rows) byRun.set(row.run, [...(byRun.get(row.run) ?? []), row]);
                return byRun;
              }),
              Effect.orDie,
            ),

      settle: Effect.fn("Store.settle")(function* (answer) {
        const at = yield* nowIso;
        const messaged =
          answer.answerer?.origin === "agent" && answer.answerer.from?.run === answer.run
            ? (answer.answerer.from.agent ?? null)
            : null;
        yield* decide(answer.run);
        // WARNING: a superseded workflow question with no revision still takes the messaged agent's answer.
        const settled = yield* mutation(
          [answer.run],
          sql`
              UPDATE collie_decisions
              SET answer = ${answer.value}, request = ${answer.request}, answered = ${at},
                answerer = ${answer.answerer === undefined ? null : answererText(answer.answerer)}
              WHERE run = ${answer.run} AND decision = ${answer.decision} AND answer IS NULL
                AND (superseded IS NULL OR (
                  asker IS NULL AND EXISTS (
                    SELECT 1 FROM json_each(collie_decisions.messaged)
                    WHERE json_extract(value, '$.agent') = ${messaged}
                  ) AND NOT EXISTS (
                    SELECT 1 FROM collie_decisions revision
                    WHERE revision.run = collie_decisions.run
                      AND revision.revises = collie_decisions.decision
                  )
                ))
              RETURNING decision
            `,
        ).pipe(Effect.orDie);
        const [row] = yield* decisionRow({ run: answer.run, decision: answer.decision }).pipe(
          Effect.orDie,
        );
        if (row === undefined) {
          return {
            _tag: "refused" as const,
            reason: `run "${answer.run}" is not waiting on a decision called "${answer.decision}"`,
          };
        }
        if (settled.length > 0) return { _tag: "accepted" as const, row };
        if (row.request === answer.request && row.answer === answer.value) {
          return { _tag: "repeat" as const, row };
        }
        return { _tag: "refused" as const, reason: yield* whyClosed(row) };
      }),

      supersede: Effect.fn("Store.supersede")(function* (superseding) {
        const at = yield* nowIso;
        yield* decide(superseding.run);
        const written = yield* mutation(
          [superseding.run],
          sql`
            UPDATE collie_decisions
            SET superseded = ${at}, cause = ${superseding.cause},
              superseder = ${answererText(superseding.actor)},
              messaged = ${asJsonText([{ agent: superseding.agent, at }])}
            WHERE run = ${superseding.run} AND decision = ${superseding.decision}
              AND answer IS NULL AND superseded IS NULL
            RETURNING decision
          `,
        ).pipe(Effect.orDie);
        const [row] = yield* decisionRow({
          run: superseding.run,
          decision: superseding.decision,
        }).pipe(Effect.orDie);
        if (row === undefined)
          return {
            _tag: "refused" as const,
            reason: `run "${superseding.run}" is not waiting on a decision called "${superseding.decision}"`,
          };
        return written.length > 0
          ? { _tag: "accepted" as const, row }
          : { _tag: "refused" as const, reason: yield* whyClosed(row) };
      }),

      revise: Effect.fn("Store.revise")(function* (revising) {
        const at = yield* nowIso;
        yield* decide(revising.run);
        const opened = yield* mutation(
          [revising.run],
          sql`
            INSERT INTO collie_decisions (run, decision, prompt, options, asked, revises, shortfall, shipping)
            SELECT run, ${revising.name}, prompt, options, ${at}, decision, shortfall, shipping
            FROM collie_decisions
            WHERE run = ${revising.run} AND decision = ${revising.decision}
              AND asker IS NULL AND answer IS NULL AND superseded IS NOT NULL
              AND json(messaged) = json(${asJsonText(revising.messaged)})
              AND NOT EXISTS (
                SELECT 1 FROM collie_decisions revision
                WHERE revision.run = ${revising.run} AND revision.revises = ${revising.decision}
              )
            ON CONFLICT(run, decision) DO NOTHING
            RETURNING decision
          `,
        ).pipe(Effect.orDie);
        return opened.length > 0;
      }),

      setAside: setAsideRows().pipe(Effect.orDie),

      supersedable: supersedableRows().pipe(Effect.orDie),

      alsoMessaged: Effect.fn("Store.alsoMessaged")(function* (messaging) {
        const at = yield* nowIso;
        yield* decide(messaging.run);
        const written = yield* mutation(
          [messaging.run],
          sql`
            UPDATE collie_decisions
            SET messaged = json_insert(
              (SELECT json_group_array(json(value)) FROM json_each(collie_decisions.messaged)
                WHERE json_extract(value, '$.agent') <> ${messaging.agent}),
              '$[#]', json_object('agent', ${messaging.agent}, 'at', ${at})
            )
            WHERE run = ${messaging.run} AND decision = ${messaging.decision}
              AND asker IS NULL AND answer IS NULL AND superseded IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM collie_decisions revision
                WHERE revision.run = ${messaging.run} AND revision.revises = ${messaging.decision}
              )
            RETURNING ${decisionColumns}
          `,
        ).pipe(Effect.flatMap(decodeDecisions), Effect.orDie);
        return written[0];
      }),

      admit: Effect.fn("Store.admit")(function* (admission: Admission) {
        const input = canonical(admission.input);
        const askedFor: AskedFor = {
          options: { ...admission.options },
          task: admission.task,
          parent: admission.parent,
        };
        if (admission.attachments?.length) askedFor.attachments = [...admission.attachments];
        const asked = canonical(askedFor);
        const at = yield* nowIso;
        // WARNING: the claim is the insert: the database, not a read, decides which caller made it.
        const claimed = yield* mutation(
          [admission.run],
          sql`
              INSERT INTO collie_runs
                (run, request, workflow, project, input, generation, execution,
                 task, parent, provenance, options, asked, placing, admitted)
              VALUES (
                ${admission.run}, ${admission.request}, ${admission.workflow},
                ${admission.project}, ${input}, ${admission.generation},
                ${admission.execution}, ${admission.task}, ${admission.parent},
                ${asJsonText(admission.provenance)}, ${asJsonText(admission.options)},
                ${asked}, ${admission.placing ?? null}, ${at}
              )
              ON CONFLICT(request) DO NOTHING
              RETURNING run
            `,
        ).pipe(Effect.orDie);

        const [row] = yield* byRequest(admission.request).pipe(Effect.orDie);
        if (row === undefined) {
          return yield* Effect.die(new Error(`request "${admission.request}" claimed nothing`));
        }
        if (claimed.length > 0) return { row, fresh: true };
        if (
          row.workflow !== admission.workflow ||
          row.project !== admission.project ||
          row.input !== input ||
          (row.asked !== null && row.asked !== asked)
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
          const at = yield* nowIso;
          yield* mutation([run], sql`UPDATE collie_runs SET accepted = ${at} WHERE run = ${run}`);
        }).pipe(Effect.orDie),

      place: Effect.fn("Store.place")(function* (run, placed) {
        yield* mutation(
          [run],
          sql`
              UPDATE collie_runs
              SET checkout = ${placed.checkout}, task = COALESCE(${placed.task}, task)
              WHERE run = ${run}
            `,
        ).pipe(Effect.orDie);
        const [row] = yield* byRun(run).pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die(new Error(`run "${run}" is not admitted`));
        return row;
      }),

      recordPlacing: (run, placing) =>
        mutation(
          [run],
          sql`UPDATE collie_runs SET placing = ${placing} WHERE run = ${run} AND checkout IS NULL`,
        ).pipe(Effect.asVoid, Effect.orDie),

      forget: (run: string) =>
        mutation([run], sql`DELETE FROM collie_runs WHERE run = ${run} AND accepted IS NULL`).pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      retire: <E>(runs: ReadonlyArray<string>, clear: (row: RunRow) => Effect.Effect<void, E>) =>
        mutation(
          runs,
          sql.withTransaction(
            Effect.gen(function* () {
              const gone: Array<string> = [];
              for (const run of runs) {
                const row = (yield* byRun(run).pipe(Effect.orDie))[0];
                if (row === undefined || row.accepted === null) continue;
                yield* clear(row);
                yield* decide(run);
                yield* sql`DELETE FROM collie_decisions WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_launches WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_artefact_receipts WHERE run = ${run}`.pipe(
                  Effect.orDie,
                );
                yield* sql`DELETE FROM collie_artefact_revisions WHERE run = ${run}`.pipe(
                  Effect.orDie,
                );
                yield* sql`DELETE FROM collie_artefacts WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_artefact_registrations WHERE run = ${run}`.pipe(
                  Effect.orDie,
                );
                yield* sql`DELETE FROM collie_artefact_index WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_narratives WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_narrative_work WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_watches WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_run_lines WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_run_facts WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_run_activity WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_controls WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_runs WHERE run = ${run}`.pipe(Effect.orDie);
                gone.push(run);
              }
              return gone;
            }),
          ),
        ).pipe(Effect.catchTag("SqlError", Effect.die)),
      pending: unaccepted().pipe(Effect.orDie),
      reportsPending: reportsPending().pipe(Effect.orDie),
      reported: (run, report) =>
        mutation(
          [run],
          sql`UPDATE collie_runs SET report = ${encodeReport(report)} WHERE run = ${run}`,
        ).pipe(Effect.asVoid, Effect.orDie),
      runs: all,
      near: (run: string) => Effect.map(all, (rows) => nearOf(rows, run)),
      run: (run: string) =>
        byRun(run).pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.orDie,
        ),
      requested: (request: string) =>
        byRequest(request).pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.orDie,
        ),
      releaseClaim: (row) =>
        mutation(
          [row.run],
          sql`UPDATE collie_runs SET request = ${`${row.request}:finished:${row.run}`} WHERE run = ${row.run} AND request = ${row.request}`,
        ).pipe(Effect.asVoid, Effect.orDie),
      requestedEnding: (suffix: string) =>
        byRequestEnding(suffix).pipe(
          Effect.map((rows) => rows[0] ?? null),
          Effect.orDie,
        ),
      watching: (read) => reactivity.stream(RUNS, read),
      changes: sql.reactive(RUNS, all),
      announce: reactivity.invalidate(RUNS),
      decided: Effect.succeed((run: string) => elsewhere + (decisions.get(run) ?? 0)),
      watch: (row) =>
        sql`
          INSERT INTO collie_watches (run, mr, name, cursor) VALUES (
            ${row.run}, ${row.mr}, ${row.name}, ${cursorText(row.cursor)}
          )
          ON CONFLICT (run) DO UPDATE SET
            mr = excluded.mr, name = excluded.name, cursor = excluded.cursor,
            observed = NULL, woke = NULL
          WHERE collie_watches.name != excluded.name
        `.pipe(Effect.asVoid, Effect.orDie),
      watches: (mrs) =>
        mrs.length === 0
          ? Effect.succeed([])
          : sql<{
              readonly run: string;
              readonly mr: string;
              readonly name: string;
              readonly cursor: string;
              readonly observed: string | null;
              readonly woke: string | null;
            }>`SELECT * FROM collie_watches WHERE mr IN ${sql.in(mrs)}`.pipe(
              Effect.flatMap(Effect.forEach(watchRowOf)),
              Effect.orDie,
            ),
      observe: (run, name, observed) =>
        sql`UPDATE collie_watches SET observed = ${observedText(observed)} WHERE run = ${run} AND name = ${name}`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      wake: (run, name, woke) =>
        sql<{ readonly run: string }>`
          UPDATE collie_watches SET woke = ${wokeText(woke)}
          WHERE run = ${run} AND name = ${name} AND woke IS NULL
          RETURNING run
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      unwatch: (run, name) =>
        sql<{ readonly run: string }>`
          DELETE FROM collie_watches
          WHERE run = ${run} AND (${name ?? null} IS NULL OR name = ${name ?? null})
          RETURNING run
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
    };
    return returned;
  });
}

const cursorText = flow(Schema.encodeResult(Schema.fromJsonString(WatchCursor)), Result.getOrThrow);
const observedText = flow(Schema.encodeResult(Schema.fromJsonString(Observed)), Result.getOrThrow);
const wokeText = flow(Schema.encodeResult(Schema.fromJsonString(Woke)), Result.getOrThrow);
const watchRowOf = (row: {
  readonly run: string;
  readonly mr: string;
  readonly name: string;
  readonly cursor: string;
  readonly observed: string | null;
  readonly woke: string | null;
}) =>
  Effect.all({
    cursor: Schema.decodeEffect(Schema.fromJsonString(WatchCursor))(row.cursor),
    observed:
      row.observed === null
        ? Effect.succeed(null)
        : Schema.decodeEffect(Schema.fromJsonString(Observed))(row.observed),
    woke:
      row.woke === null
        ? Effect.succeed(null)
        : Schema.decodeEffect(Schema.fromJsonString(Woke))(row.woke),
  }).pipe(Effect.map((decoded) => ({ run: row.run, mr: row.mr, name: row.name, ...decoded })));

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));
const asJsonText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

const answererText = flow(
  Schema.encodeResult(Schema.fromJsonString(AuditLine.fields.actor)),
  Result.getOrThrow,
);

// WARNING: key order is ignored: two objects that differ only in key order are one request.
const canonical = (value: Schema.Json) => asJsonText(ordered(value));

const ordered: (value: Schema.Json) => Schema.Json = (value) => {
  if (Arr.isArray<typeof value>(value)) return Arr.map(value, ordered);
  if (!isRecord(value)) return value;
  return Rec.fromEntries(
    Arr.map(Struct.keys(value).sort(), (key) => [key, ordered(value[key] ?? null)] as const),
  );
};
