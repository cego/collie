// What `bun test` printed about its failures, and how one of them is run again alone
// (ADR-0034, amended 2026-10-15).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import type { FailedTest } from "./verify-model";

// ponytail: more failures than this is a broken change, not flakiness; a check that names none is handled whole.
const MAX_FAILED = 20;

const FILE_HEADER = /^(\S+\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const LIST_HEADER = /^\d+ tests? failed:$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;
const ERROR_COUNT = /^\s*\d+ errors?$/;
// What bun names a failure outside any test, such as a file's afterAll.
const HOOK = "(unnamed)";

/**
 * The failed tests bun's output names, each under the file whose header is nearest above it;
 * null where the output cannot be read whole: its fail count disagrees, it reports an error
 * outside any test, a failure has no file or is a hook's, which no test run alone proves,
 * or there are over `MAX_FAILED`.
 */
export function failedTests(output: string): ReadonlyArray<FailedTest> | null {
  const lines = Str.split(output, "\n");
  const found = new Map<string, FailedTest>();
  let file: string | null = null;
  let listed = false;
  let failCount: number | null = null;
  for (const line of lines) {
    if (ERROR_COUNT.test(line)) return null;
    const count = FAIL_COUNT.exec(line);
    if (count !== null) failCount = Number(count[1]);
    // The closing list repeats the names without their files.
    if (LIST_HEADER.test(line)) listed = true;
    if (listed) continue;
    const header = FILE_HEADER.exec(line);
    if (header !== null) file = header[1]!;
    const failed = FAILED.exec(line);
    if (failed === null) continue;
    if (file === null || failed[1] === HOOK) return null;
    found.set(`${file}\0${failed[1]}`, { file, name: failed[1]! });
  }
  if (found.size === 0 || failCount !== found.size || found.size > MAX_FAILED) return null;
  return [...found.values()];
}

/**
 * A path, not a filter: bare, bun runs every file whose path contains it. `-t` matches a
 * nested name with its parts joined by one space, where bun prints ` > `.
 */
export function rerunArgv(test: FailedTest): ReadonlyArray<string> {
  const joined = Arr.join(Str.split(test.name, " > "), " ");
  const file = pipe(test.file, Str.startsWith("/")) ? test.file : `./${test.file}`;
  return ["test", file, "-t", `^${pipe(joined, Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}$`];
}

/** Whether a rerun ran exactly one test and it passed; "matched 0 tests" and two of that name do not. */
export function ranAlone(exit: number, output: string): boolean {
  return exit === 0 && /^\s*1 pass$/m.test(output) && /^\s*0 fail$/m.test(output);
}

/** Whether bun ran that one test in one file and named it failing: a test it did not find is not failing there. */
export function failedAlone(exit: number, output: string, test: FailedTest): boolean {
  return (
    exit !== 0 &&
    /^\s*0 pass$/m.test(output) &&
    /^\s*1 fail$/m.test(output) &&
    /^Ran 1 test across 1 file\./m.test(output) &&
    Arr.some(Str.split(output, "\n"), (line) => FAILED.exec(line)?.[1] === test.name)
  );
}
