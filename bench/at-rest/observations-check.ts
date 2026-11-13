/* oxlint-disable effecttsgo/node-builtin-import -- isolated file and SQLite boundary checks. */
import { Database } from "bun:sqlite";
import { deepStrictEqual, throws } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { wakeDeadline, writerMarkers } from "./observations";

const directory = mkdtempSync(`${tmpdir()}/collie-observations-check-`);
try {
  const path = `${directory}/log.txt`;
  writeFileSync(path, "bench-log:28:58000\n");
  const completed = Effect.sync(() =>
    writeFileSync(path, "bench-log:28:58000\nbench-log:29:61000\n"),
  );
  deepStrictEqual(await Effect.runPromise(writerMarkers(completed, path)), [
    { sequence: 28, at: 58000 },
    { sequence: 29, at: 61000 },
  ]);
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE collie_runs (run TEXT, execution TEXT);
      CREATE TABLE cluster_messages (entity_type TEXT, entity_id TEXT, deliver_at INTEGER, processed BOOLEAN);
      INSERT INTO collie_runs VALUES ('woke', 'execution-1'), ('other', 'execution-2');
      INSERT INTO cluster_messages VALUES
        ('Workflow/-/DurableClock', 'execution-1', 4000, 1),
        ('Workflow/-/DurableClock', 'execution-2', 9000, 0),
        ('unrelated', 'execution-1', 1000, 0);`);
    deepStrictEqual(wakeDeadline(db, "woke"), 4000);
    throws(() => wakeDeadline(db, "absent"), /no durable deadline/);
  } finally {
    db.close();
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
