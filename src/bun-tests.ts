import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import type { FailedTest } from "./verify-model";

// WARNING: more failures than this is a broken change, not flakiness.
const MAX_FAILED = 20;

const FILE_HEADER = /^(\S+\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;
const LIST_HEADER = /^\d+ tests? failed:$/;
const FAIL_COUNT = /^\s*(\d+) fail$/;
const ERROR_COUNT = /^\s*\d+ errors?$/;
const HOOK = "(unnamed)";

// WARNING: null where the output cannot be read whole: fail count disagrees, an error sits outside any test, a failure has no file or is a hook's, or there are over MAX_FAILED.
export function failedTests(output: string) {
  const lines = Str.split(output, "\n");
  const found = new Map<string, FailedTest>();
  let file: string | null = null;
  let listed = false;
  let failCount: number | null = null;
  for (const line of lines) {
    if (ERROR_COUNT.test(line)) return null;
    const count = FAIL_COUNT.exec(line);
    if (count !== null) failCount = Number(count[1]);
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

// WARNING: a path, not a filter: bare, bun runs every file whose path contains it; -t joins nested names with one space where bun prints ' > '.
export function rerunArgv(test: FailedTest) {
  const joined = Arr.join(Str.split(test.name, " > "), " ");
  const file = pipe(test.file, Str.startsWith("/")) ? test.file : `./${test.file}`;
  return [
    "test",
    file,
    "-t",
    `^${pipe(joined, Str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))}$`,
  ];
}

// WARNING: 'matched 0 tests' and two tests of that name do not count as ran alone.
export function ranAlone(exit: number, output: string) {
  return exit === 0 && /^\s*1 pass$/m.test(output) && /^\s*0 fail$/m.test(output);
}

export function failedAlone(exit: number, output: string, test: FailedTest) {
  return (
    exit !== 0 &&
    /^\s*0 pass$/m.test(output) &&
    /^\s*1 fail$/m.test(output) &&
    /^Ran 1 test across 1 file\./m.test(output) &&
    Arr.some(Str.split(output, "\n"), (line) => FAILED.exec(line)?.[1] === test.name)
  );
}

export const NAMED_FAILURES = 50;

export const failureReader = () => {
  let carry = "";
  let file: string | null = null;
  let listed = false;
  const seen = new Set<string>();
  const line = (text: string) => {
    if (LIST_HEADER.test(text)) listed = true;
    if (listed) return;
    const header = FILE_HEADER.exec(text);
    if (header !== null) file = header[1]!;
    const failed = FAILED.exec(text);
    if (failed !== null) seen.add(file === null ? failed[1]! : `${file} > ${failed[1]}`);
  };
  return {
    feed: (chunk: string) => {
      const lines = Str.split(carry + chunk, "\n");
      carry = lines.pop() ?? "";
      for (const one of lines) line(one);
    },
    names: () => {
      line(carry);
      carry = "";
      return [...seen];
    },
  };
};
