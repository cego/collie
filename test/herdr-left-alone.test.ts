// Collie explains an old herdr and never upgrades it or stops its server (ADR-0048, D4):
// stopping a server ends the human's work, so when to do it is the human's choice.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

const RUNS_IN_TYPESCRIPT = [
  /\[\s*"update"\s*[,\]]/,
  /\[\s*"server"\s*,\s*"stop"/,
  /["']herdr (update|server stop)\b/,
];
const RUNS_IN_SHELL = [
  /^\s*(exec\s+)?herdr\s+(update|server\s+stop)\b/m,
  /[;&|(]\s*herdr\s+(update|server\s+stop)\b/,
];

const sources = (pattern: string) => Array.from(new Bun.Glob(pattern).scanSync({ cwd: root }));

const offenders = Effect.fn("herdrLeftAlone.offenders")(function* (
  pattern: string,
  runs: ReadonlyArray<RegExp>,
) {
  const fs = yield* FileSystem.FileSystem;
  const files = sources(pattern);
  expect(files.length).toBeGreaterThan(0);
  const found: string[] = [];
  for (const file of files) {
    const text = yield* fs.readFileString(`${root}${file}`);
    if (runs.some((run) => run.test(text))) found.push(file);
  }
  return found;
});

test("the patterns catch a call, and not the advice that names one", () => {
  expect(RUNS_IN_TYPESCRIPT.some((run) => run.test(`herdr.cli(["update"])`))).toBe(true);
  expect(RUNS_IN_TYPESCRIPT.some((run) => run.test(`cli(["server", "stop"])`))).toBe(true);
  expect(RUNS_IN_SHELL.some((run) => run.test("  herdr server stop\n"))).toBe(true);
  expect(RUNS_IN_SHELL.some((run) => run.test("x && herdr update"))).toBe(true);
  expect(RUNS_IN_TYPESCRIPT.some((run) => run.test("`\\`herdr update\\`, then`"))).toBe(false);
  expect(RUNS_IN_SHELL.some((run) => run.test(`step x "collie doctor says how"`))).toBe(false);
});

test("no Collie source runs `herdr update` or `herdr server stop`", () =>
  runEffect(
    Effect.gen(function* () {
      expect([
        ...(yield* offenders("{src,tools,workflows}/**/*.{ts,tsx}", RUNS_IN_TYPESCRIPT)),
        ...(yield* offenders("desktop/src/**/*.ts", RUNS_IN_TYPESCRIPT)),
        ...(yield* offenders("*.sh", RUNS_IN_SHELL)),
        ...(yield* offenders("tools/*.sh", RUNS_IN_SHELL)),
      ]).toEqual([]);
    }),
  ));
