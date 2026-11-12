import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect } from "effect";
import { shell } from "./mr";

/**
 * The harness `commits` that `at` lacks, in order: those after the longest prefix whose
 * touched files `at` holds exactly as that prefix left them. Content decides, not ancestry, so
 * copies under other SHAs count and a history whose harness was since changed or removed does not.
 */
export const harnessLacking = (cwd: string, at: string, commits: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const git = (...args: string[]) => shell("git", args, cwd);
    const touched: string[] = [];
    let held = 0;
    for (const [index, commit] of commits.entries()) {
      const files = yield* git(
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        commit,
      );
      if (files.code !== 0) break;
      touched.push(...Arr.filter(Str.split(files.stdout, "\n"), Str.isNonEmpty));
      // An empty pathspec would compare the whole tree.
      if (
        touched.length === 0 ||
        (yield* git("diff", "--quiet", commit, at, "--", ...touched)).code === 0
      )
        held = index + 1;
    }
    return commits.slice(held);
  });
