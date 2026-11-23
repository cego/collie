import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect } from "effect";
import { shell } from "./mr";

export interface FailedTest {
  readonly name: string;
  readonly file: string | null;
}

export interface BranchChange {
  readonly paths: ReadonlyArray<string>;
  readonly added: ReadonlyArray<string>;
}

const SHORTEST_LITERAL = 16;
const LITERAL = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;

const literalsOf = (line: string) =>
  Arr.flatMap(Array.from(pipe(line, Str.matchAll(LITERAL))), (m) =>
    Str.split(pipe(m[1] ?? m[2] ?? m[3] ?? "", Str.replaceAll(/\\(.)/g, "$1")), /\$\{[^}]*\}/),
  );

export const ownTests = (failed: ReadonlyArray<FailedTest>, change: BranchChange) => {
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

const FILE_HEADER = /^(\S+\.[cm]?[jt]sx?):$/;
const FAILED = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/;

export const failedTestsIn = (output: string) => {
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

export const branchChange = Effect.fn("OwnTests.branchChange")(function* (
  cwd: string,
  branch: string,
) {
  const git = (...args: Array<string>) => shell("git", args, cwd);
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
