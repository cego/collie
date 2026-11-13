/* oxlint-disable effecttsgo/node-builtin-import, no-restricted-imports -- isolated snapshot checks. */
import { Database } from "bun:sqlite";
import { deepStrictEqual } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { shiftHistory } from "./history-time";

const directory = mkdtempSync(`${tmpdir()}/collie-history-check-`);
try {
  mkdirSync(`${directory}/state`);
  const db = new Database(`${directory}/state/host.db`);
  db.exec(`CREATE TABLE collie_runs (id INTEGER PRIMARY KEY, admitted TEXT);
    INSERT INTO collie_runs VALUES (9007199254740993, '2026-11-11T09:00:00.000Z');
    CREATE TABLE cluster_messages (id INTEGER PRIMARY KEY, deliver_at INTEGER, payload TEXT);
    INSERT INTO cluster_messages VALUES (9007199254740994, 1794387600000, '{"at":"2026-11-11T09:00:00.000Z"}');`);
  db.close();
  const path = `${directory}/state/steps.jsonl`;
  writeFileSync(path, '{"at":"2026-11-11T09:00:00.000Z","key":"write#1"}\n');
  utimesSync(path, 1794387600, 1794387600);
  shiftHistory(directory, 3600000);
  const read = new Database(`${directory}/state/host.db`, { readonly: true });
  try {
    deepStrictEqual(read.query("SELECT CAST(id AS TEXT) AS id, admitted FROM collie_runs").get(), {
      id: "9007199254740993",
      admitted: "2026-11-11T10:00:00.000Z",
    });
    deepStrictEqual(
      read.query("SELECT CAST(id AS TEXT) AS id, deliver_at, payload FROM cluster_messages").get(),
      {
        id: "9007199254740994",
        deliver_at: 1794391200000,
        payload: '{"at":"2026-11-11T10:00:00.000Z"}',
      },
    );
  } finally {
    read.close();
  }
  deepStrictEqual(
    readFileSync(path, "utf8"),
    '{"at":"2026-11-11T10:00:00.000Z","key":"write#1"}\n',
  );
  deepStrictEqual(statSync(path).mtimeMs, 1794391200000);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
