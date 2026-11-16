/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json, no-restricted-imports -- offline preparation regression with a fake installer. */
import { strictEqual } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
mkdirSync(`${root}.scratch/at-rest`, { recursive: true });
const directory = mkdtempSync(`${root}.scratch/at-rest/restore-check-`);
try {
  const cold = `${directory}/cold`;
  for (const path of ["node_modules/effect", "fresh", "bin", "cold/bench/at-rest"])
    mkdirSync(`${directory}/${path}`, { recursive: true });
  for (const path of ["node_modules/effect", "fresh"]) {
    writeFileSync(
      `${directory}/${path}/package.json`,
      JSON.stringify({ name: "effect", type: "module", exports: { "./*": "./*.js" } }),
    );
    writeFileSync(
      `${directory}/${path}/Record.js`,
      "export const keys = Object.keys; export const values = Object.values;\n",
    );
  }
  writeFileSync(`${directory}/node_modules/effect/process.js`, "export {};\n");
  writeFileSync(`${directory}/fresh/process.js`, "export const CommandLine = {};\n");
  writeFileSync(
    `${directory}/bin/bun`,
    "#!/bin/sh\nmkdir -p node_modules\ncp -R ../fresh node_modules/effect\n",
    { mode: 0o755 },
  );
  for (const file of ["restore.ts", "snapshot.ts", "history.json", "history.tar.gz"])
    cpSync(`${root}bench/at-rest/${file}`, `${cold}/bench/at-rest/${file}`);
  writeFileSync(
    `${cold}/bench/at-rest/world.ts`,
    `import { CommandLine } from "effect/process";
if (!CommandLine) throw new Error("local Effect required");
const root = new URL("../../", import.meta.url).pathname;
export const keptFixture = root + ".scratch/at-rest/fixture";
export const manifestPath = root + ".scratch/at-rest/fixture.json";
export const live = root + "live";
`,
  );
  const result = Bun.spawnSync([process.execPath, `${cold}/bench/at-rest/restore.ts`], {
    cwd: cold,
    env: { ...Bun.env, PATH: `${directory}/bin:${Bun.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  strictEqual(result.exitCode, 0, result.stderr.toString());
} finally {
  rmSync(directory, { recursive: true, force: true });
}
