/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-string, no-restricted-imports -- relocates an offline benchmark fixture, never a host's live state. */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";

const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export const relocate = (directory: string, from: string, to: string) => {
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
          const field = identifier(column.name);
          db.query(
            `UPDATE ${identifier(name)} SET ${field} = replace(${field}, ?, ?) WHERE instr(${field}, ?) > 0`,
          ).run(from, to, from);
        }
      }
    })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  const rewrite = (path: string) => {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      if (file.name === ".git" || file.name === ".bun" || file.name.startsWith("host.db")) continue;
      const child = `${path}/${file.name}`;
      if (file.isDirectory()) rewrite(child);
      else if (file.isFile()) {
        const before = readFileSync(child, "utf8");
        if (!before.includes(from)) continue;
        const times = statSync(child);
        writeFileSync(child, before.replaceAll(from, to));
        utimesSync(child, times.atime, times.mtime);
      } else throw new Error(`unexpected fixture entry: ${child}`);
    }
  };
  rewrite(directory);
};
