/* oxlint-disable effecttsgo/global-console, effecttsgo/global-date, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-schema-over-json, no-restricted-globals, no-restricted-imports -- bounded offline fixture preparation. */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Manifest } from "./fixture";
import { relocate } from "./snapshot";

const root = new URL("../../", import.meta.url).pathname;

const run = (argv: string[]) => {
  const result = Bun.spawnSync(argv, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} exited ${result.exitCode}`);
};

if (!existsSync(`${root}node_modules/effect/package.json`)) {
  run(["bun", "install", "--frozen-lockfile"]);
  // Bun can cache an ancestor's Effect resolution before the install.
  run([process.execPath, ...Bun.argv.slice(1)]);
  process.exit(0);
}
const Rec = await import("effect/Record");
const { keptFixture, live, manifestPath } = await import("./world");
const source: { base: string; live: string; root: string; sha256: string } = JSON.parse(
  readFileSync(`${root}bench/at-rest/history.json`, "utf8"),
);
if (
  new Bun.CryptoHasher("sha256")
    .update(readFileSync(`${root}bench/at-rest/history.tar.gz`))
    .digest("hex") !== source.sha256
)
  throw new Error("fixture archive checksum differs");
rmSync(keptFixture, { recursive: true, force: true });
rmSync(manifestPath, { force: true });
mkdirSync(`${root}.scratch/at-rest`, { recursive: true });
run(["tar", "-xzf", `${root}bench/at-rest/history.tar.gz`, "-C", `${root}.scratch/at-rest`]);
relocate(keptFixture, source.live, live);
relocate(keptFixture, source.root, root);
const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const db = new Database(`${keptFixture}/state/host.db`, { readonly: true });
try {
  const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  if (integrity?.integrity_check !== "ok")
    throw new Error(`fixture integrity: ${JSON.stringify(integrity)}`);
  const expected = [
    ...manifest.settled,
    ...Rec.keys(manifest.reported),
    ...manifest.owing,
    ...manifest.asking,
    ...manifest.sleeping,
  ].sort();
  const actual = db
    .query<{ run: string }, []>("SELECT run FROM collie_runs ORDER BY run")
    .all()
    .map((row) => row.run);
  if (expected.length !== 800 || JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("fixture lost Runs");
  for (const table of ["cluster_messages", "cluster_replies"] as const)
    if (
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n !== manifest[table]
    )
      throw new Error(`fixture lost ${table}`);
  const wakes = Rec.values(manifest.wakes).map(Date.parse);
  if (
    wakes.length !== 4 ||
    wakes.some((at) => !Number.isFinite(at) || at <= Date.now() + 86_400_000)
  )
    throw new Error("fixture wakes expire within a day; rebuild the base snapshot");
} finally {
  db.close();
}
console.error(
  `restored 800 Runs from ${source.base}, with ${manifest.cluster_messages} cluster messages`,
);
