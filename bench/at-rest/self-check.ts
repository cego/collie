/* oxlint-disable effecttsgo/node-builtin-import -- standalone harness self-check, without a host. */
import { Database } from "bun:sqlite";
import { deepStrictEqual } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { logArrivals, viewMismatches } from "./checks";
import { relocate } from "./snapshot";

const directory = mkdtempSync(`${tmpdir()}/collie-snapshot-check-`);
try {
  mkdirSync(`${directory}/state`);
  const db = new Database(`${directory}/state/host.db`);
  db.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, project TEXT, cwd TEXT AS (json_extract(project, '$.cwd')));
    INSERT INTO runs (id, project) VALUES (9007199254740993, '{"cwd":"/old/live/project"}');`);
  db.close();
  writeFileSync(`${directory}/state/record.json`, '{"cwd":"/old/live/project"}');
  relocate(directory, "/old/live", "/new/live");
  const read = new Database(`${directory}/state/host.db`, { readonly: true });
  deepStrictEqual(read.query("SELECT CAST(id AS TEXT) AS id, cwd FROM runs").get(), {
    id: "9007199254740993",
    cwd: "/new/live/project",
  });
  read.close();
  deepStrictEqual(
    readFileSync(`${directory}/state/record.json`, "utf8"),
    '{"cwd":"/new/live/project"}',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

deepStrictEqual(
  logArrivals([
    { at: 100, text: "old log" },
    { at: 200, text: "bench-log:1:150\n" },
    { at: 300, text: "bench-log:1:150\nbench-log:2:250\n" },
  ]),
  new Map([
    [1, 200],
    [2, 300],
  ]),
);

const expected = [
  { runId: "done", status: "complete", report: null, delivery: null, closed: false, wakes: null },
  {
    runId: "reported",
    status: "complete",
    report: "yesterday",
    delivery: "undelivered",
    closed: true,
    wakes: null,
  },
  {
    runId: "sleeping",
    status: "suspended",
    report: null,
    delivery: null,
    closed: false,
    wakes: "tomorrow",
  },
];
deepStrictEqual(viewMismatches(expected, expected), []);
deepStrictEqual(viewMismatches([...expected, expected[0]!], expected), ["duplicate Run ids"]);
deepStrictEqual(
  viewMismatches([{ ...expected[1]!, delivery: "delivered" }], expected.slice(1, 2)),
  ["reported"],
);
deepStrictEqual(
  viewMismatches(
    [
      { ...expected[1]!, report: "today", closed: false },
      { ...expected[2]!, wakes: null },
      { ...expected[0]!, runId: "unexpected" },
    ],
    expected,
  ),
  ["done", "reported", "sleeping", "unexpected"],
);
