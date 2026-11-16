/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string, effecttsgo/global-date, no-restricted-imports, no-restricted-globals -- offline rebasing of the benchmark's private history. */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";

export const shiftDates = (text: string, by: number) =>
  text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/g, (iso) =>
    new Date(Date.parse(iso) + by).toISOString(),
  );

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const shiftHistory = (directory: string, by: number) => {
  const db = new Database(`${directory}/state/host.db`);
  try {
    db.transaction(() => {
      for (const { name } of db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        for (const column of db
          .query<{ name: string; type: string }, []>(`PRAGMA table_info(${identifier(name)})`)
          .all()) {
          if (!/TEXT|CHAR/i.test(column.type)) continue;
          const table = identifier(name);
          const field = identifier(column.name);
          const update = db.query(`UPDATE ${table} SET ${field} = ? WHERE rowid = ?`);
          for (const row of db
            .query<{ id: string; value: string }, []>(
              `SELECT CAST(rowid AS TEXT) AS id, ${field} AS value FROM ${table} WHERE ${field} LIKE '%T%Z%'`,
            )
            .all()) {
            const after = shiftDates(row.value, by);
            if (after !== row.value) update.run(after, row.id);
          }
        }
      }
      db.query(
        "UPDATE cluster_messages SET deliver_at = deliver_at + ? WHERE deliver_at IS NOT NULL",
      ).run(by);
    })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const files = (path: string) => {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      if (file.name === ".git" || file.name === ".bun" || file.name.startsWith("host.db")) continue;
      const child = `${path}/${file.name}`;
      if (file.isDirectory()) files(child);
      else if (file.isFile()) {
        const times = statSync(child);
        const before = readFileSync(child, "utf8");
        const after = shiftDates(before, by);
        if (after !== before) writeFileSync(child, after);
        utimesSync(child, (times.atimeMs + by) / 1000, (times.mtimeMs + by) / 1000);
      } else throw new Error(`unexpected fixture entry: ${child}`);
    }
  };
  files(directory);
};
