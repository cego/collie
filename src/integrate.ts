// The default branch merged into a Run's branch where it has moved: a merge commit, never a
// rebase, and never over work the builder has not committed.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { defaultBase } from "./inputs";
import { whatItSaid, type Runner } from "./mr";

/**
 * What an integration did. `ref` and `sha` are what the branch is now measured against —
 * a reviewer's diff is `<sha>...HEAD`. `conflicted` leaves the merge in progress for the
 * builder to finish; `waiting` merged nothing because the checkout has work of its own;
 * `unavailable` could not tell where the default branch is, a failed fetch included.
 */
export const IntegrationSchema = Schema.Struct({
  status: Schema.Literals(["unchanged", "merged", "conflicted", "waiting", "unavailable"]),
  branch: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
  files: Schema.Array(Schema.String),
  reason: Schema.String,
});
export type Integration = typeof IntegrationSchema.Type;

/** The Run log's line for an integration, or null where nothing was merged. */
export const integratedLine = (done: Integration): string | null => {
  const at = `integrated ${done.branch}@${done.sha}`;
  if (done.status === "merged") return at;
  if (done.status === "conflicted")
    return `${at}, conflicts left to the builder: ${Arr.join(done.files, ", ")}`;
  return null;
};

export const integrateDefault = (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  cwd: string,
) =>
  Effect.gen(function* () {
    const git = (...args: string[]) => run("git", args, cwd);
    const none = { branch: "", ref: "", sha: "", files: [], reason: "" };
    const branch = yield* defaultBase(run, cwd);
    if (branch === null)
      return { ...none, status: "unavailable", reason: "no default branch" } satisfies Integration;
    const remote = (yield* git("remote", "get-url", "origin")).code === 0;
    if (remote) {
      const fetched = yield* git("fetch", "-q", "origin", branch);
      if (fetched.code !== 0)
        return {
          ...none,
          status: "unavailable",
          branch,
          reason: `could not fetch ${branch} from origin: ${whatItSaid(fetched)}`,
        } satisfies Integration;
    }
    const tracked = (yield* git("rev-parse", "--verify", "-q", `origin/${branch}^{commit}`)).code;
    const ref = remote && tracked === 0 ? `origin/${branch}` : branch;
    const resolved = yield* git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
    if (resolved.code !== 0)
      return {
        ...none,
        status: "unavailable",
        branch,
        reason: `${ref} cannot be read`,
      } satisfies Integration;
    const at = { ...none, branch, ref, sha: Str.trim(resolved.stdout) };
    const unmerged = Effect.map(git("diff", "--name-only", "--diff-filter=U"), (said) =>
      Arr.filter(Str.split(said.stdout, "\n"), (file) => file !== ""),
    );
    const merging = yield* git("rev-parse", "-q", "--verify", "MERGE_HEAD");
    // An unfinished merge is still the builder's, however often it is asked about.
    if (merging.code === 0) {
      const files = yield* unmerged;
      if (files.length > 0)
        return {
          ...at,
          status: "conflicted",
          sha: Str.trim(merging.stdout),
          files,
        } satisfies Integration;
    }
    if (merging.code === 0 || Str.trim((yield* git("status", "--porcelain")).stdout) !== "")
      return {
        ...at,
        status: "waiting",
        reason: "the checkout has uncommitted changes, so it waits for the builder's commit",
      } satisfies Integration;
    if ((yield* git("merge-base", "--is-ancestor", at.sha, "HEAD")).code === 0)
      return { ...at, status: "unchanged" } satisfies Integration;
    const merged = yield* git("merge", "--no-ff", "--no-edit", ref);
    if (merged.code === 0) return { ...at, status: "merged" } satisfies Integration;
    const files = yield* unmerged;
    if (files.length > 0) return { ...at, status: "conflicted", files } satisfies Integration;
    return { ...at, status: "unavailable", reason: whatItSaid(merged) } satisfies Integration;
  });
