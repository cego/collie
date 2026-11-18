import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect } from "effect";
import { shell } from "./mr";

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
        "-m",
        "-z",
        commit,
      );
      if (files.code !== 0) break;
      touched.push(...Arr.filter(Str.split(files.stdout, "\0"), Str.isNonEmpty));
      if (
        touched.length === 0 ||
        (yield* git("--literal-pathspecs", "diff", "--quiet", commit, at, "--", ...touched))
          .code === 0
      )
        held = index + 1;
    }
    return commits.slice(held);
  });
