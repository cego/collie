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

import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Option,
  Order,
  Schedule,
  type Scope,
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
  importLedgers,
  importProposals,
  importRegisters,
  importTasks,
} from "./records-import";
import { StoreWrites } from "./store-writes";
import { RequestConflict, type Solution } from "./board-model";
import { nowIso } from "./time";

/** A run as it was admitted: the claim, the arguments and the execution it became. */
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
  /** Where each settled value came from, and what the host itself was given beside them. */
  provenance: Schema.NullOr(Schema.String),
  options: Schema.NullOr(Schema.String),
  /** Where it works, as the host placed it; null while that is still to do, or from before. */
  checkout: Schema.NullOr(Schema.String),
  /** The host options, Task and parent as asked, canonical, which a retry is compared to. */
  asked: Schema.NullOr(Schema.String),
  /** What placing it starts from, so a placement a crash cut short is made again. */
  placing: Schema.NullOr(Schema.String),
  /** When this work was claimed, which is when the Run began. */
  admitted: Schema.String,
  /** When the engine took this work, or null while it is still a host's to hand over. */
  accepted: Schema.NullOr(Schema.String),
});
export type RunRow = typeof Run.Type;

const RUN_FIELDS = Struct.keys(Run.fields);

/** The Run's Task's rows, their parents and children, and every Run another asked for. */
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

/** As every Run is read: by admission, then id. */
const byAdmission = Order.mapInput(
  Order.Tuple([Order.String, Order.String]),
  (row: RunRow) => [row.admitted, row.run] as const,
);

/** Whether two reads of a Run's row read the same. */
export const sameRow = (one: RunRow, other: RunRow) =>
  one === other || Arr.every(RUN_FIELDS, (field) => one[field] === other[field]);

/**
 * A question one run is waiting on: what was asked, what may answer it, and the answer it
 * has if it has one. One row per run and decision, which is what makes a second answer a
 * thing the database refuses rather than a thing a reader has to notice.
 */
const Decision = Schema.Struct({
  run: Schema.String,
  decision: Schema.String,
  prompt: Schema.String,
  /** The answers this question takes, as JSON; empty is a question answered in words. */
  options: Schema.String,
  answer: Schema.NullOr(Schema.String),
  /** The claim the answer arrived under, so the same request twice is one answer. */
  request: Schema.NullOr(Schema.String),
  /** The operation whose agent asked it on its Run; null for the workflow's own question. */
  asker: Schema.NullOr(Schema.String),
  /** Who answered it, settled with the answer so no reader sees one without the other. */
  answerer: Schema.NullOr(Schema.fromJsonString(AuditLine.fields.actor)),
  asked: Schema.String,
  answered: Schema.NullOr(Schema.String),
  /** When a human's message set it aside, unanswered (ADR-draft-a-humans-message-supersedes-a-runs-open-question). */
  superseded: Schema.NullOr(Schema.String),
  /** The Delivery or submit that superseded it. */
  cause: Schema.NullOr(Schema.String),
  superseder: Schema.NullOr(Schema.fromJsonString(AuditLine.fields.actor)),
  /** Every agent a human messaged since, and when; any of them may still answer it (D8). */
  messaged: Schema.NullOr(
    Schema.fromJsonString(Schema.Array(Schema.Struct({ agent: Schema.String, at: Schema.String }))),
  ),
  /** The question this one asks again, or null for an original. */
  revises: Schema.NullOr(Schema.String),
  /** When its Workflow last reached it, which every replay renews; null for an agent's. */
  reached: Schema.NullOr(Schema.String),
  /** What keeps it short of standard; null for one that is not, or an older host's. */
  shortfall: Schema.NullOr(Schema.String),
});
export type DecisionRow = typeof Decision.Type;

export const isUnanswered = (one: {
  readonly answer: string | null;
  readonly superseded?: string | null | undefined;
}): boolean => one.answer === null && (one.superseded ?? null) === null;

/** Set aside by a human's message, and not answered since. */
export const isSuperseded = (one: {
  readonly answer: string | null;
  readonly superseded?: string | null | undefined;
}): boolean => one.answer === null && (one.superseded ?? null) !== null;

/** A Workflow's question set aside and not yet asked again: no Decision while its work runs. */
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
): boolean =>
  isSuperseded(one) &&
  (one.asker ?? null) === null &&
  !Arr.some(all, (r) => r.revises === one.name);

export const supersededReason = (one: {
  readonly name: string;
  readonly superseded?: string | null | undefined;
  readonly cause?: string | null | undefined;
}): string => `"${one.name}" was superseded at ${one.superseded} by ${one.cause}`;

export type Superseded =
  | { readonly _tag: "accepted"; readonly row: DecisionRow }
  | { readonly _tag: "refused"; readonly reason: string };

/** What became of an answer. Only `accepted` completes anything. */
export type Answered =
  | { readonly _tag: "accepted"; readonly row: DecisionRow }
  /** The same claim again: the answer already landed, and this is not a second one. */
  | { readonly _tag: "repeat"; readonly row: DecisionRow }
  | { readonly _tag: "refused"; readonly reason: string };

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
  /** The values as the author's own schema encodes them, never the text they came as. */
  readonly input: Readonly<Record<string, Schema.Json>>;
  /** Where each of those came from, and what the host was given that is not the author's. */
  readonly provenance: Readonly<Record<string, string>>;
  readonly options: Readonly<Record<string, string>>;
  readonly generation: string;
  readonly execution: string;
  readonly task: string | null;
  readonly parent: string | null;
  /** What the host places it from, as JSON; absent for work that is placed already. */
  readonly placing?: string;
  /** Paths on this Machine copied into the Run before it is handed over. */
  readonly attachments?: ReadonlyArray<string>;
}

/** What a retry of a claim has to ask again; attachments only where there were some. */
type AskedFor = {
  readonly options: Readonly<Record<string, string>>;
  readonly task: string | null;
  readonly parent: string | null;
  attachments?: ReadonlyArray<string>;
};

export interface StoreApi {
  readonly remember: (generation: GenerationRow) => Effect.Effect<void>;
  /**
   * Records that this run is waiting on this question. Replaying the wait says it again
   * and changes nothing: the row that is already there carries the answer.
   */
  readonly asking: (question: {
    readonly run: string;
    readonly decision: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string | Solution>;
    readonly asker?: string;
    readonly revises?: string;
    readonly shortfall?: string;
  }) => Effect.Effect<void>;
  /** Every question this run has been asked, answered or not, in the order they were. */
  readonly asked: (run: string) => Effect.Effect<ReadonlyArray<DecisionRow>>;
  /** `asked` for each of these Runs that was asked anything, in one read. */
  readonly askedOf: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<DecisionRow>>>;
  /**
   * Settles one open question, or says why this answer is not the one that settles it.
   * The write is the decision: one UPDATE over the unanswered row, so two answers racing
   * are separated by the database rather than by whoever reads first.
   */
  readonly settle: (answer: {
    readonly run: string;
    readonly decision: string;
    readonly value: string;
    readonly request: string;
    readonly answerer?: AuditLine["actor"] | undefined;
  }) => Effect.Effect<Answered>;
  /**
   * Sets one open question aside for a human's message, under the same guard as `settle`,
   * so whichever of the two reaches the database first stands.
   */
  readonly supersede: (superseding: {
    readonly run: string;
    readonly decision: string;
    readonly cause: string;
    readonly actor: AuditLine["actor"];
    readonly agent: string;
  }) => Effect.Effect<Superseded>;
  /**
   * Asks a superseded workflow question again as `name`, only while it is unanswered,
   * unrevised and still waits on exactly the `messaged` its caller found finished, so the
   * database orders it against the messaged agent's answer and a newer message. True where
   * this call opened it.
   */
  readonly revise: (revising: {
    readonly run: string;
    readonly decision: string;
    readonly name: string;
    readonly messaged: NonNullable<DecisionRow["messaged"]>;
  }) => Effect.Effect<boolean>;
  /** Every workflow question set aside by a human's message and not yet asked again. */
  readonly setAside: Effect.Effect<ReadonlyArray<DecisionRow>>;
  /** Every question a human's message can still set aside, or still extend the wait of. */
  readonly supersedable: Effect.Effect<ReadonlyArray<DecisionRow>>;
  /**
   * Adds `agent` to the agents a set-aside workflow question waits for, or restarts its
   * wait where it is already one, while no revision has opened. True where it did.
   */
  readonly alsoMessaged: (messaging: {
    readonly run: string;
    readonly decision: string;
    readonly agent: string;
  }) => Effect.Effect<boolean>;
  readonly generations: Effect.Effect<ReadonlyArray<GenerationRow>>;
  /**
   * Claims a request id for a run, or hands back the run that already has it. `fresh` is
   * false for a retry, which is what tells a caller not to execute again.
   */
  readonly admit: (
    admission: Admission,
  ) => Effect.Effect<{ readonly row: RunRow; readonly fresh: boolean }, RequestConflict>;
  /** Where the claimant placed it, and the Task that placement opened, if it opened one. */
  readonly place: (
    run: string,
    placed: { readonly checkout: string; readonly task: string | null },
  ) => Effect.Effect<RunRow>;
  /** What a placement has done outside so far, written before and after each change it makes. */
  readonly recordPlacing: (run: string, placing: string) => Effect.Effect<void>;
  /** A claim whose placement was refused, withdrawn so the request can be made again. */
  readonly forget: (run: string) => Effect.Effect<void>;
  /**
   * Forgets these Runs' rows in one transaction: `clear` first, for what the engine keeps
   * of each, then its decisions and its row. A row the engine never accepted is left, for
   * recovery to hand over (ADR-0017 D4). Answers with the Runs it forgot.
   */
  readonly retire: <E>(
    runs: ReadonlyArray<string>,
    clear: (row: RunRow) => Effect.Effect<void, E>,
  ) => Effect.Effect<ReadonlyArray<string>, E>;
  /** The engine has this work: the receipt a crash before it is what recovery looks for. */
  readonly accepted: (run: string) => Effect.Effect<void>;
  readonly pending: Effect.Effect<ReadonlyArray<RunRow>>;
  readonly run: (run: string) => Effect.Effect<RunRow | null>;
  /** The run a request id was already admitted as, or null. */
  readonly requested: (request: string) => Effect.Effect<RunRow | null>;
  readonly runs: Effect.Effect<ReadonlyArray<RunRow>>;
  /**
   * The rows a Run's record may read, a superset its reader narrows: the Run's Task's, or the
   * Run's alone outside one, their parents and children, and every Run another asked for.
   */
  readonly near: (run: string) => Effect.Effect<ReadonlyArray<RunRow>>;
  /** Whatever this reads, again, whenever a run changes. */
  readonly watching: <A, E>(read: Effect.Effect<A, E>) => Stream.Stream<A, E>;
  /** Every run, again, whenever one is committed. */
  readonly changes: Stream.Stream<ReadonlyArray<RunRow>>;
  /** A run changed where the change was not one of these writes, so readers reread. */
  readonly announce: Effect.Effect<void>;
  /** Moves whenever the Run's decisions may have changed, which no Run's row shows. Read when called. */
  readonly decided: Effect.Effect<(run: string) => number>;
}

export class Store extends Context.Service<Store, StoreApi>()("collie/Store") {}

/** Over `host.db`; given the state directory, the files its first migration imports too. */
export const storeLayer = (
  stateDir?: string,
): Layer.Layer<
  Store,
  never,
  SqlClient.SqlClient | Reactivity.Reactivity | FileSystem.FileSystem | Path.Path
> => Layer.effect(Store)(makeStore(stateDir));

/** What a committed write invalidates, and what a subscriber is listening for. */
const RUNS = ["collie/runs"];

/** A field of a record kept as JSON, null where the line is not JSON. */
const field = (name: string) =>
  `CASE WHEN json_valid(line) THEN json_extract(line, '$.${name}') END`;

type ImportError = Effect.Error<
  ReturnType<
    | typeof importLedgers
    | typeof importTasks
    | typeof importRegisters
    | typeof importProposals
    | typeof importLaunches
  >
>;

const migrations = (imports: {
  readonly ledgers: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly tasks: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly registers: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly proposals: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
  readonly launches: Effect.Effect<void, ImportError, SqlClient.SqlClient>;
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
    // A proposal names its Runs in a JSON array, which no index reaches.
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
});

/** How often a commit by another connection, another process's, is looked for. */
const ELSEWHERE_EVERY = "250 millis";

function makeStore(
  stateDir: string | undefined,
): Effect.Effect<
  StoreApi,
  never,
  SqlClient.SqlClient | Reactivity.Reactivity | Scope.Scope | FileSystem.FileSystem | Path.Path
> {
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
    // Before anything reads a table: a database that will not migrate is a broken host,
    // not a request that failed.
    yield* SqliteMigrator.run({
      loader: Migrator.fromRecord(
        migrations({
          ledgers: imported(importLedgers),
          tasks: imported(importTasks),
          registers: imported(importRegisters),
          proposals: imported(importProposals),
          launches: imported(importLaunches),
        }),
      ),
      table: "collie_migrations",
    }).pipe(Effect.orDie);
    // SQLite moves `data_version` only for another connection's commits.
    const dataVersion = sql<{ readonly data_version: number }>`PRAGMA data_version`.pipe(
      Effect.map((rows) => rows[0]?.data_version ?? 0),
      Effect.orElseSucceed(() => 0),
    );
    let seen = yield* dataVersion;
    /** Moves with every write to the Runs, so a read of them stands until the next. */
    let written = 0;
    /** The Runs written since the last read, or every Run where that is not known. */
    let dirty: Set<string> | "all" = "all";
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const wrote = (runs?: ReadonlyArray<string>) =>
      Effect.sync(() => {
        written++;
        // Another connection's commit names no Run, and only the host writes a Run's row (ADR-0040).
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

    const columns = sql`run, request, workflow, project, input, generation, execution, task, parent, provenance, options, checkout, asked, placing, admitted, accepted`;

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

    const decisionColumns = sql`run, decision, prompt, options, answer, request, asker, answerer, asked, answered, superseded, cause, superseder, messaged, revises, reached, shortfall`;

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

    /** Why `row` takes no answer now, naming the question asked in its place. */
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
    /** Every Run, read again only after a write, each unchanged row the one read before. */
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
          // Writes made since `at` are in `dirty`, so these rows stand for every one before.
          read = { at, rows };
          return rows;
        }),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() => {
                if (which === "all") dirty = "all";
                else if (dirty !== "all") for (const run of which) dirty.add(run);
              }),
        ),
      );
    });
    const all = Effect.suspend(() =>
      read?.at === written ? Effect.succeed(read.rows) : refreshing.withPermit(refresh),
    );

    return {
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
              INSERT INTO collie_decisions (run, decision, prompt, options, asked, asker, revises, reached, shortfall)
              VALUES (
                ${question.run}, ${question.decision}, ${question.prompt},
                ${asJsonText([...question.options])}, ${at}, ${question.asker ?? null},
                ${question.revises ?? null}, ${question.asker === undefined ? at : null},
                ${question.shortfall ?? null}
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
                const byRun = new Map<string, DecisionRow[]>();
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
        // One write over the row while it is still open. Whoever it returns a row to is the
        // answer; everybody else reads what landed and is told so. A superseded workflow
        // question with no revision still takes the messaged agent's answer (D8).
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
            INSERT INTO collie_decisions (run, decision, prompt, options, asked, revises, shortfall)
            SELECT run, ${revising.name}, prompt, options, ${at}, decision, shortfall
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
            RETURNING decision
          `,
        ).pipe(Effect.orDie);
        return written.length > 0;
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
        // The claim is the insert, and what it returns is whether this caller made it:
        // one request id, one row, decided by the database rather than by a read another
        // caller could be between.
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
              const gone: string[] = [];
              for (const run of runs) {
                const row = (yield* byRun(run).pipe(Effect.orDie))[0];
                if (row === undefined || row.accepted === null) continue;
                yield* clear(row);
                yield* decide(run);
                yield* sql`DELETE FROM collie_decisions WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_launches WHERE run = ${run}`.pipe(Effect.orDie);
                yield* sql`DELETE FROM collie_runs WHERE run = ${run}`.pipe(Effect.orDie);
                gone.push(run);
              }
              return gone;
            }),
          ),
        ).pipe(Effect.catchTag("SqlError", Effect.die)),
      pending: unaccepted().pipe(Effect.orDie),
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
      watching: (read) => reactivity.stream(RUNS, read),
      changes: sql.reactive(RUNS, all),
      // Only this store writes the Runs, so an announce moves none of their rows.
      announce: reactivity.invalidate(RUNS),
      decided: Effect.succeed((run: string) => elsewhere + (decisions.get(run) ?? 0)),
    } satisfies StoreApi;
  });
}

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));
const asJsonText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

const answererText = flow(
  Schema.encodeResult(Schema.fromJsonString(AuditLine.fields.actor)),
  Result.getOrThrow,
);

/**
 * The same arguments written the same way, so a retry is compared rather than guessed at:
 * two objects that differ only in the order their keys arrived are one request.
 */
const canonical = (value: Schema.Json): string => asJsonText(ordered(value));

const ordered = (value: Schema.Json): Schema.Json => {
  if (Arr.isArray<typeof value>(value)) return Arr.map(value, ordered);
  if (!isRecord(value)) return value;
  return Rec.fromEntries(
    Arr.map(Struct.keys(value).sort(), (key) => [key, ordered(value[key] ?? null)] as const),
  );
};
