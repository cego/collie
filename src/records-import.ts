// The files Collie kept its own records in before they were rows in `host.db`, each read
// once into its table by the migration that made it (ADR-draft-collies-own-records-live-in-the-hosts-database, D5).
// The files are left where they are, for a host of an older build.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Layer, Option, Path, PlatformError, Schema } from "effect";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { hostLockOf, withLock } from "./lock";
import * as SqlClient from "effect/sql/SqlClient";
import { decodeLaunchOption, LAUNCH_ORDER, LAUNCH_SUFFIX, stemOf } from "./launches";
import { decodeProposalLineOption } from "./proposals";
import { decodeRegisterOption, encodeAgentEntry } from "./registry";
import { LEDGER_FILE } from "./steering";
import { decodeTaskOption } from "./task";
import { RunReport } from "./board-model";
import {
  AREAS,
  LEGACY_FACT_PREFIXES,
  LEGACY_FACTS,
  LEGACY_JOURNALS,
  recordName,
  RUN_RECORDS_MIGRATION_ID,
  TEXT_JOURNALS,
} from "./run-records";

/**
 * Nothing there, or a file where a directory would be, is no records. Any other failure
 * fails the migration, so the next host retries it.
 */
const orMissing =
  <A>(none: A) =>
  <R>(read: Effect.Effect<A, PlatformError.PlatformError, R>) =>
    read.pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" || error.reason._tag === "BadResource"
          ? Effect.succeed(none)
          : Effect.fail(error),
      ),
    );

const isJson = (text: string) =>
  Option.isSome(Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text));

export const importReports = Effect.fn("RecordsImport.reports")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeOption(Schema.fromJsonString(RunReport));
  for (const row of yield* sql<{ run: string }>`SELECT run FROM collie_runs`) {
    const raw = yield* fs
      .readFileString(path.join(stateDir, "runs", row.run, "report.json"))
      .pipe(orMissing(""));
    if (Option.isSome(decode(raw)))
      yield* sql`UPDATE collie_runs SET report = ${raw} WHERE run = ${row.run}`;
  }
});

/** A journal's lines, less a torn last one: the append a crash cut short. */
const journalLines = (raw: string) => {
  const lines = Arr.filter(Str.split(raw, "\n"), (text) => Str.trim(text) !== "");
  const last = lines.at(-1);
  return last !== undefined && !isJson(last) ? lines.slice(0, -1) : lines;
};

/**
 * Every agent's delivery ledger file, `agents/<incarnation key>/`. A line that cannot be read is kept as it
 * is, so the ledger still counts it and still blocks the work it was about.
 */
export const importLedgers = Effect.fn("RecordsImport.ledgers")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "agents");
  for (const ledger of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
    if (!/^[0-9a-f]+$/.test(ledger)) continue;
    const raw = yield* fs.readFileString(path.join(root, ledger, LEDGER_FILE)).pipe(orMissing(""));
    for (const line of journalLines(raw))
      yield* sql`INSERT INTO collie_deliveries (ledger, line) VALUES (${ledger}, ${line})`;
  }
});

/** Every `herd/<key>/proposals.jsonl`, each line that is a proposal's. */
export const importProposals = Effect.fn("RecordsImport.proposals")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "herd");
  for (const journal of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
    const raw = yield* fs
      .readFileString(path.join(root, journal, "proposals.jsonl"))
      .pipe(orMissing(""));
    for (const line of journalLines(raw))
      if (Option.isSome(decodeProposalLineOption(line)))
        yield* sql`INSERT INTO collie_proposals (journal, line) VALUES (${journal}, ${line})`;
  }
});

/** Every `agents/<register>.json`, its entries in the order it kept them. */
export const importRegisters = Effect.fn("RecordsImport.registers")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "agents");
  for (const name of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
    if (!Str.endsWith(".json")(name)) continue;
    const raw = yield* fs.readFileString(path.join(root, name)).pipe(orMissing(""));
    const register = Str.slice(0, -".json".length)(name);
    for (const entry of Option.getOrElse(decodeRegisterOption(raw), () => []))
      yield* sql`
        INSERT OR REPLACE INTO collie_agents (register, agent, record)
        VALUES (${register}, ${entry.agent}, ${encodeAgentEntry(entry)})
      `;
  }
});

/** Every `tasks/<id>.json` that is a Task. */
export const importTasks = Effect.fn("RecordsImport.tasks")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "tasks");
  for (const name of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
    if (!Str.endsWith(".json")(name)) continue;
    const raw = Str.trim(yield* fs.readFileString(path.join(root, name)).pipe(orMissing("")));
    const task = Option.getOrUndefined(decodeTaskOption(raw));
    if (task !== undefined)
      yield* sql`INSERT OR REPLACE INTO collie_tasks (id, record) VALUES (${task.id}, ${raw})`;
  }
});

/** Every `agents/<run>/*.launch.json`, each placed where its Run's `launches` order last put it. */
export const importLaunches = Effect.fn("RecordsImport.launches")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "agents");
  for (const run of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
    const dir = path.join(root, run);
    const names = yield* fs.readDirectory(dir).pipe(orMissing<ReadonlyArray<string>>([]));
    const launched = Arr.filter(names, Str.endsWith(LAUNCH_SUFFIX));
    if (launched.length === 0) continue;
    const orderFile = path.join(dir, LAUNCH_ORDER);
    const order = Str.split(yield* fs.readFileString(orderFile).pipe(orMissing("")), "\n");
    const orderedAt = yield* fs.stat(orderFile).pipe(
      Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? null),
      orMissing<number | null>(null),
    );
    for (const name of launched) {
      const raw = Str.trim(yield* fs.readFileString(path.join(dir, name)).pipe(orMissing("")));
      const read = decodeLaunchOption(raw);
      if (Option.isNone(read)) continue;
      const stem = stemOf(read.value);
      const at = order.lastIndexOf(stem);
      yield* sql`
        INSERT OR REPLACE INTO collie_launches (run, stem, record, ordered, ordered_at)
        VALUES (${run}, ${stem}, ${raw}, ${at < 0 ? null : at}, ${at < 0 ? null : orderedAt})
      `;
    }
  }
});

/** A plain-text journal's lines, less a last one its newline never reached. */
const textLines = (raw: string) =>
  Arr.filter(Str.split(raw, "\n").slice(0, -1), (text) => Str.trim(text) !== "");

/**
 * When anything under these directories was last written, as the board measured it before
 * activity was recorded, less bookkeeping: what Collie wrote about the Run from outside it.
 */
const writtenIn = Effect.fn("RecordsImport.writtenIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const at = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => Option.getOrNull(info.mtime)?.getTime() ?? 0),
      orMissing(0),
    );
  let newest = 0;
  for (const name of yield* fs.readDirectory(dir).pipe(orMissing<ReadonlyArray<string>>([]))) {
    if (name === "diff.json" || name === "operations.jsonl" || name === "log-index.json") continue;
    if (name !== "steering") {
      newest = Math.max(newest, yield* at(path.join(dir, name)));
      continue;
    }
    const inside = yield* fs
      .readDirectory(path.join(dir, name))
      .pipe(orMissing<ReadonlyArray<string>>([]));
    for (const entry of inside)
      if (entry !== "disposition.jsonl" && entry !== "seen.jsonl")
        newest = Math.max(newest, yield* at(path.join(dir, name, entry)));
  }
  return newest;
});

/** Where in a Run's directory in `area` the record `name` was kept; null for another area's. */
const localName = (area: (typeof AREAS)[number], name: string) => {
  const of = Arr.findFirst(AREAS, (one) => one !== "runs" && Str.startsWith(`${one}/`)(name));
  const owner = Option.getOrElse(of, () => "runs");
  return owner !== area ? null : area === "runs" ? name : name.slice(area.length + 1);
};

/** The files of a Run's directory in `area` that an older build kept a fact in, by name. */
const legacyFacts = Effect.fn("RecordsImport.legacyFacts")(function* (
  area: (typeof AREAS)[number],
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const found: Array<{ readonly name: string; readonly file: string }> = [];
  for (const name of LEGACY_FACTS) {
    const file = localName(area, name);
    if (file !== null) found.push({ name, file: `${dir}/${file}` });
  }
  for (const prefix of LEGACY_FACT_PREFIXES) {
    const file = localName(area, prefix);
    if (file === null) continue;
    const parent = file.slice(0, file.lastIndexOf("/"));
    for (const entry of yield* fs
      .readDirectory(`${dir}/${parent}`)
      .pipe(orMissing<ReadonlyArray<string>>([])))
      if (Str.startsWith(file)(`${parent}/${entry}`))
        found.push({
          name: recordName(area, `${parent}/${entry}`),
          file: `${dir}/${parent}/${entry}`,
        });
  }
  return found;
});

/**
 * Every Run's journals and facts, under `runs/<run>/` and `evidence/<run>/`, each line and
 * value as it was written, and when each Run last did work.
 */
export const importRunRecords = Effect.fn("RecordsImport.runRecords")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  for (const area of AREAS) {
    const root = path.join(stateDir, area);
    for (const run of yield* fs.readDirectory(root).pipe(orMissing<ReadonlyArray<string>>([]))) {
      const dir = path.join(root, run);
      for (const journal of LEGACY_JOURNALS) {
        const file = localName(area, journal);
        if (file === null) continue;
        const raw = yield* fs.readFileString(path.join(dir, file)).pipe(orMissing(""));
        const lines = TEXT_JOURNALS.has(journal) ? textLines(raw) : journalLines(raw);
        for (const [seq, line] of lines.entries())
          yield* sql`
            INSERT INTO collie_run_lines (run, journal, seq, line) VALUES (${run}, ${journal}, ${seq}, ${line})
          `;
      }
      for (const { name, file } of yield* legacyFacts(area, dir)) {
        const data = yield* fs.readFileString(file).pipe(orMissing<string | null>(null));
        if (data === null) continue;
        yield* sql`
          INSERT INTO collie_run_facts (run, name, data) VALUES (${run}, ${name}, ${data})
        `;
      }
    }
  }
  for (const run of yield* fs
    .readDirectory(path.join(stateDir, "runs"))
    .pipe(orMissing<ReadonlyArray<string>>([]))) {
    const at = Math.max(
      yield* writtenIn(path.join(stateDir, "runs", run)),
      yield* writtenIn(path.join(stateDir, "agents", run)),
      yield* writtenIn(path.join(stateDir, "evidence", run)),
    );
    if (at > 0) yield* sql`INSERT INTO collie_run_activity (run, at) VALUES (${run}, ${at})`;
  }
});

/** Where an older build kept the record `name` of `run`. */
const legacyPath = (stateDir: string, run: string, name: string) => {
  const area = Arr.findFirst(AREAS, (one) => localName(one, name) !== null);
  const at = Option.getOrElse(area, () => "runs" as const);
  return `${stateDir}/${at}/${run}/${localName(at, name) ?? name}`;
};

/**
 * Undoes `RUN_RECORDS_MIGRATION` for a host that is not running: every Run's records are
 * written back where an older build reads them, a legacy fact the host has since removed is
 * removed, and only then are the tables and the migration's record dropped, in one
 * transaction, so a later upgrade imports the files again.
 */
export const rollbackRunRecords = Effect.fn("RecordsImport.rollback")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const [migrated] = yield* sql<{ readonly one: number }>`
    SELECT 1 AS one FROM collie_migrations WHERE migration_id = ${RUN_RECORDS_MIGRATION_ID}
  `;
  if (migrated === undefined) return false;
  const write = Effect.fnUntraced(function* (file: string, text: string) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(`${file}.rollback`, text);
    yield* fs.rename(`${file}.rollback`, file);
  });
  const journals = new Map<string, string[]>();
  for (const row of yield* sql<{ run: string; journal: string; line: string }>`
    SELECT run, journal, line FROM collie_run_lines ORDER BY run, journal, seq
  `) {
    const file = legacyPath(stateDir, row.run, row.journal);
    journals.set(file, [...(journals.get(file) ?? []), row.line]);
  }
  for (const [file, lines] of journals) yield* write(file, `${Arr.join(lines, "\n")}\n`);
  const facts = yield* sql<{ run: string; name: string; data: string }>`
    SELECT run, name, data FROM collie_run_facts
  `;
  for (const row of facts) yield* write(legacyPath(stateDir, row.run, row.name), row.data);
  const kept = new Set(Arr.map(facts, (row) => legacyPath(stateDir, row.run, row.name)));
  for (const area of AREAS)
    for (const run of yield* fs
      .readDirectory(path.join(stateDir, area))
      .pipe(orMissing<ReadonlyArray<string>>([])))
      for (const { file } of yield* legacyFacts(area, path.join(stateDir, area, run)))
        if (!kept.has(file)) yield* fs.remove(file).pipe(orMissing<void>(undefined));
  yield* Effect.gen(function* () {
    yield* sql`DROP TABLE collie_run_lines`;
    yield* sql`DROP TABLE collie_run_facts`;
    yield* sql`DROP TABLE collie_run_activity`;
    yield* sql`DELETE FROM collie_migrations WHERE migration_id >= ${RUN_RECORDS_MIGRATION_ID}`;
  }).pipe(sql.withTransaction);
  return true;
});

/** `rollbackRunRecords` on `stateDir`'s own database, while no host owns it. */
export const rollbackAt = (stateDir: string) =>
  withLock(
    hostLockOf(stateDir),
    Effect.succeed("owned" as const),
    rollbackRunRecords(stateDir).pipe(
      Effect.map((done) => (done ? ("rolled-back" as const) : ("not-migrated" as const))),
      Effect.provide(Layer.orDie(SqliteClient.layer({ filename: `${stateDir}/host.db` }))),
    ),
  );
