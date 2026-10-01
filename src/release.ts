import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { shell, type Runner } from "./mr";

// ponytail: the one branch releases are cut from; read origin/HEAD if that ever varies.
const RELEASE_BRANCH = "master";
export const RELEASE_TAG = /^\d+\.\d+\.\d+$/;

export type Installation =
  | { readonly release: true }
  | { readonly release: false; readonly build: string; readonly reason: string };

const RELEASED: Installation = { release: true };

/** A plain install, not a checkout, is a release: it is what `install.sh` fetched. */
export const installation = Effect.fn("release.installation")(function* (
  root: string,
  version: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
): Effect.fn.Return<Installation, never, ChildProcessSpawner.ChildProcessSpawner> {
  const git = (...args: string[]) => run("git", args, root);
  if ((yield* git("rev-parse", "--git-dir")).code !== 0) return RELEASED;
  const sha = (yield* git("rev-parse", "--short", "HEAD")).stdout.trim();
  const development = (reason: string): Installation => ({
    release: false,
    build: `${version}+${sha}`,
    reason,
  });

  const status = yield* git("status", "--porcelain");
  if (status.code !== 0 || status.stdout.trim() !== "") {
    return development("it has uncommitted changes");
  }
  const branch = yield* git("symbolic-ref", "--quiet", "--short", "HEAD");
  if (branch.code !== 0) {
    const tags = (yield* git("tag", "--points-at", "HEAD")).stdout.split("\n");
    return tags.some((tag) => RELEASE_TAG.test(tag.trim()))
      ? RELEASED
      : development("it is on a commit that is not a release");
  }
  const name = branch.stdout.trim();
  if (name !== RELEASE_BRANCH) return development(`it is on branch ${name}, not ${RELEASE_BRANCH}`);
  const ahead = yield* git("rev-list", "--count", "@{upstream}..HEAD");
  if (ahead.code !== 0) return development(`${name} has no remote to compare with`);
  if (ahead.stdout.trim() !== "0") return development("it is ahead of its remote");
  return RELEASED;
});
