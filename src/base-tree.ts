import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Data, Effect, FileSystem } from "effect";
import { shell } from "./mr";
import type { Ran } from "./mr";

export class TreeRefused extends Data.TaggedError("TreeRefused")<{
  readonly why: string;
}> {}

export const baseTreesDir = (stateDir: string, runId: string) =>
  `${stateDir}/measurements/trees/${runId}`;

const git = (args: Array<string>, cwd: string) => shell("git", args, cwd);
const said = (ran: Ran) => Str.trim(ran.stderr || ran.stdout);
const AS_COLLIE = ["-c", "user.name=Collie", "-c", "user.email=collie@localhost"];

// WARNING: checked out as its own commit per request, so two requests not sharing a run never share a checkout.
export type TreeOf =
  | { readonly harness: ReadonlyArray<string> }
  | { readonly tree: string; readonly check: string; readonly request: string };

const keyOf = (commit: string, on: TreeOf) =>
  "tree" in on ? [commit, `tree ${on.tree}`, on.check, on.request] : [commit, ...on.harness];

const complete = (dir: string, commit: string, on: TreeOf) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(dir))) {
      return false;
    }
    if ("tree" in on) {
      const tree = yield* git(["rev-parse", "HEAD^{tree}"], dir);
      const changed = yield* git(["status", "--porcelain", "--untracked-files=all"], dir);
      return (
        tree.code === 0 &&
        Str.trim(tree.stdout) === on.tree &&
        changed.code === 0 &&
        Str.trim(changed.stdout) === ""
      );
    }
    const above = yield* git(["rev-list", "--count", `${commit}..HEAD`], dir);
    const on_ = yield* git(["merge-base", "--is-ancestor", commit, "HEAD"], dir);
    const changed = yield* git(["status", "--porcelain", "--untracked-files=no"], dir);
    return (
      above.code === 0 &&
      Number(Str.trim(above.stdout)) === on.harness.length &&
      on_.code === 0 &&
      changed.code === 0 &&
      Str.trim(changed.stdout) === ""
    );
  }).pipe(Effect.orElseSucceed(() => false));

// WARNING: a tree already there is reused only while it is clean.
export const baseTree = Effect.fn("BaseTree.make")(function* (
  root: string,
  repository: string,
  commit: string,
  on: TreeOf,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${root}/${Bun.hash(Arr.join(keyOf(commit, on), "\n")).toString(16)}`;
  if (yield* complete(dir, commit, on)) {
    return dir;
  }
  yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* git(["worktree", "prune"], repository);
  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orDie);
  let at = commit;
  if ("tree" in on) {
    const made = yield* git(
      [
        ...AS_COLLIE,
        "commit-tree",
        on.tree,
        ...(commit === "" ? [] : ["-p", commit]),
        "-m",
        `The tree "${on.check}" runs on, isolated`,
      ],
      repository,
    );
    if (made.code !== 0) {
      return yield* new TreeRefused({
        why: `the tree ${on.tree} could not be committed: ${said(made)}`,
      });
    }
    at = Str.trim(made.stdout);
  }
  const added = yield* git(["worktree", "add", "--detach", dir, at], repository);
  if (added.code !== 0) {
    return yield* new TreeRefused({
      why: `the ${"tree" in on ? "isolated" : "base"} tree could not be made at ${at}: ${said(added)}`,
    });
  }
  if (!("harness" in on) || on.harness.length === 0) {
    return dir;
  }
  const picked = yield* git(
    [...AS_COLLIE, "cherry-pick", "--keep-redundant-commits", ...on.harness],
    dir,
  );
  if (picked.code === 0) {
    return dir;
  }
  yield* git(["worktree", "remove", "--force", dir], repository);
  return yield* new TreeRefused({
    why: `the harness commits do not apply on ${commit}: ${said(picked)}`,
  });
});
