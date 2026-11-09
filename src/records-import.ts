// The files Collie kept its own records in before they were rows in `host.db`, each read
// once into its table by the migration that made it (ADR-draft-collies-own-records-live-in-the-hosts-database, D5).
// The files are left where they are, for a host of an older build.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { decodeProposalLineOption } from "./proposals";
import { decodeRegisterOption, encodeAgentEntry } from "./registry";
import { decodeTaskOption } from "./task";

const isJson = (text: string) =>
  Option.isSome(Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text));

/** A journal's lines, less a torn last one: the append a crash cut short. */
const journalLines = (raw: string) => {
  const lines = Arr.filter(Str.split(raw, "\n"), (text) => Str.trim(text) !== "");
  const last = lines.at(-1);
  return last !== undefined && !isJson(last) ? lines.slice(0, -1) : lines;
};

/**
 * Every `agents/<incarnation key>/deliveries.jsonl`. A line that cannot be read is kept as it
 * is, so the ledger still counts it and still blocks the work it was about.
 */
export const importLedgers = Effect.fn("RecordsImport.ledgers")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const root = path.join(stateDir, "agents");
  for (const ledger of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (!/^[0-9a-f]+$/.test(ledger)) continue;
    const raw = yield* fs
      .readFileString(path.join(root, ledger, "deliveries.jsonl"))
      .pipe(Effect.orElseSucceed(() => ""));
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
  for (const journal of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    const raw = yield* fs
      .readFileString(path.join(root, journal, "proposals.jsonl"))
      .pipe(Effect.orElseSucceed(() => ""));
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
  for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (!Str.endsWith(".json")(name)) continue;
    const raw = yield* fs
      .readFileString(path.join(root, name))
      .pipe(Effect.orElseSucceed(() => ""));
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
  for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (!Str.endsWith(".json")(name)) continue;
    const raw = Str.trim(
      yield* fs.readFileString(path.join(root, name)).pipe(Effect.orElseSucceed(() => "")),
    );
    const task = Option.getOrUndefined(decodeTaskOption(raw));
    if (task !== undefined)
      yield* sql`INSERT OR REPLACE INTO collie_tasks (id, record) VALUES (${task.id}, ${raw})`;
  }
});
