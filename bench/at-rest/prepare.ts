/* oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string, effecttsgo/prefer-schema-over-json, no-restricted-globals, no-restricted-properties -- the benchmark's drivers speak to processes, files and /proc on their own terms, as record-open's do. */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

/** The merge base this harness was written on: every tree's fixture is built by its code. */
const BASE = "0abec91ba11987e78819847be58b332004e62bd3";

const root = new URL("../../", import.meta.url).pathname;
const base = `${root}.scratch/at-rest/base`;
const stampPath = `${root}.scratch/at-rest/fixture.stamp`;
const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const run = (argv: ReadonlyArray<string>, cwd: string, env?: Record<string, string>) => {
  const ran = Bun.spawnSync([...argv], {
    cwd,
    env: { ...Bun.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (ran.exitCode !== 0) process.exit(ran.exitCode ?? 1);
};

if (!existsSync(`${root}node_modules/effect/package.json`))
  run(["bun", "install", "--frozen-lockfile"], root);

if (readOr(`${base}/.bench-base`) !== BASE) {
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const archive = Bun.spawn(["git", "archive", BASE], { cwd: root, stdout: "pipe" });
  const untar = Bun.spawn(["tar", "-x", "-C", base], { stdin: archive.stdout });
  if ((await archive.exited) !== 0 || (await untar.exited) !== 0) process.exit(1);
  if (readFileSync(`${base}/bun.lock`, "utf8") === readFileSync(`${root}bun.lock`, "utf8"))
    symlinkSync(`${root}node_modules`, `${base}/node_modules`);
  else run(["bun", "install", "--frozen-lockfile"], base);
  writeFileSync(`${base}/.bench-base`, BASE);
}
rmSync(`${base}/bench/at-rest`, { recursive: true, force: true });
cpSync(`${root}bench/at-rest`, `${base}/bench/at-rest`, { recursive: true });

const stamp = Bun.hash(
  [
    BASE,
    ...[
      "fixture.ts",
      "world.ts",
      "workflows/bench-wait.workflow.ts",
      "workflows/bench-report.workflow.ts",
      "workflows/bench-active.workflow.ts",
    ].map((file) => readFileSync(`${root}bench/at-rest/${file}`, "utf8")),
    ...Bun.argv.slice(2),
  ].join("\0"),
).toString(16);
if (existsSync(`${root}.scratch/at-rest/fixture.json`) && readOr(stampPath) === stamp) {
  console.error(`the fixture built by ${BASE.slice(0, 8)} is kept already`);
  process.exit(0);
}
rmSync(`${root}.scratch/at-rest/fixture.json`, { force: true });
run([process.execPath, `${base}/bench/at-rest/fixture.ts`, ...Bun.argv.slice(2)], base, {
  BENCH_AT_REST_TREE: root,
});
writeFileSync(stampPath, stamp);
