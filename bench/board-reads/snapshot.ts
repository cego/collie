/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, no-restricted-globals -- copies a state directory for an offline benchmark, never writing to it. */
// Copies a host's state directory without changing it: its files, less what no board reads,
// and its database through a read-only connection.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const [from, to] = Bun.argv.slice(2);
if (from === undefined || to === undefined) {
  console.error("usage: bun bench/board-reads/snapshot.ts <state directory> <snapshot>");
  process.exit(2);
}
if (existsSync(to)) rmSync(to, { recursive: true });
mkdirSync(to, { recursive: true });
const copied = Bun.spawnSync(
  [
    "rsync",
    "-a",
    "--no-specials",
    "--no-devices",
    "--exclude=/host.db*",
    "--exclude=/host.sock",
    "--exclude=/host.lock",
    "--exclude=/runners",
    "--exclude=/renovate-repositories",
    "--exclude=/measurements",
    "--exclude=node_modules",
    "--exclude=/runs/*/release",
    "--exclude=/runs/*/private-dependency-cache",
    `${from}/`,
    `${to}/`,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
// rsync's 24: a file vanished while it was read, as a live host's do.
if (copied.exitCode !== 0 && copied.exitCode !== 24) process.exit(copied.exitCode ?? 1);
const db = new Database(`${from}/host.db`, { readonly: true });
db.query("VACUUM INTO ?").run(`${to}/host.db`);
db.close();
