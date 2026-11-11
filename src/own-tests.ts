// Whether a failed test is the branch's own (ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job, D4).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect } from "effect";
import { shell } from "./mr";

/** A test bun printed as failed, and its file where the output pairs one unambiguously. */
export interface FailedTest {
  readonly name: string;
  readonly file: string | null;
}

/** What the branch changed since its merge-base: the paths it adds or modifies, and its added lines. */
export interface BranchChange {
  readonly paths: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
}

const SHORTEST_LITERAL = 16;
const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

/** The text of each string literal on `line`, a template's split at its placeholders. */
const literalsOf = (line: string) =>
  Arr.flatMap(Array.from(pipe(line, Str.matchAll(LITERAL))), (m) =>
    Str.split(pipe(m[1] ?? m[2] ?? m[3] ?? "", Str.replace(/\\(.)/g, "$1")), /\$\{[^}]*\}/),
  );

/**
 * The failed tests that are the branch's own: its file is one the branch adds or modifies,
 * or its name contains a string literal of 16 or more characters on a line the branch adds.
 */
// ponytail: an edit only to a helper an existing test uses is not caught; reading imports would.
export const ownTests = (
  failed: ReadonlyArray<FailedTest>,
  change: BranchChange,
): ReadonlyArray<FailedTest> => {
  const strings = Arr.filter(
    Arr.flatMap(change.added, literalsOf),
    (s) => s.length >= SHORTEST_LITERAL,
  );
  return Arr.filter(
    failed,
    (test) =>
      (test.file !== null &&
        Arr.some(
          change.paths,
          (path) => path === test.file || pipe(path, Str.endsWith(`/${test.file}`)),
        )) ||
      Arr.some(strings, (s) => pipe(test.name, Str.includes(s))),
  );
};

const FILE_HEADER = /^(\S+[._](?:test|spec)\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;

/** The failed tests in plain bun output; a file is named only where the output has one file. */
export const failedTestsIn = (output: string): ReadonlyArray<FailedTest> => {
  const lines = Str.split(output, "\n");
  const files = Arr.dedupe(
    Arr.flatMap(lines, (line) => FILE_HEADER.exec(Str.trim(line))?.slice(1, 2) ?? []),
  );
  const file = files.length === 1 ? files[0]! : null;
  return Arr.map(
    Arr.dedupe(Arr.flatMap(lines, (line) => FAILED.exec(Str.trim(line))?.slice(1, 2) ?? [])),
    (name) => ({ name, file }),
  );
};

/** What the checkout at `cwd` changed since its merge-base with `branch`, nothing where none is found. */
export const branchChange = Effect.fn("OwnTests.branchChange")(function* (
  cwd: string,
  branch: string,
) {
  const git = (...args: string[]) => shell("git", args, cwd);
  const remote = yield* git("merge-base", "HEAD", `origin/${branch}`);
  const merged = remote.code === 0 ? remote : yield* git("merge-base", "HEAD", branch);
  const base = Str.trim(merged.stdout);
  if (merged.code !== 0 || base === "") return { paths: [], added: [] } satisfies BranchChange;
  const names = yield* git("diff", "--name-only", "--no-renames", "--diff-filter=AM", base, "HEAD");
  const diff = yield* git("diff", "--no-renames", "--unified=0", base, "HEAD");
  return {
    paths: Arr.filter(Str.split(names.stdout, "\n"), (path) => path !== ""),
    added: Arr.flatMap(Str.split(diff.stdout, "\n"), (line) =>
      pipe(line, Str.startsWith("+")) && !pipe(line, Str.startsWith("+++"))
        ? [pipe(line, Str.slice(1))]
        : [],
    ),
  } satisfies BranchChange;
});
