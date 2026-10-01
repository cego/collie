import { Effect, FileSystem, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { shell, type Runner } from "./mr";
import { RELEASE_PUBLIC_KEY, SIGNATURE_SUFFIX, verifyRelease } from "./signing";

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

/** One string field of the plugin manifest at `root`, or "" where there is none. */
export const manifestField = Effect.fn("Doctor.manifestField")(function* (
  root: string,
  key: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = path.join(root, "herdr-plugin.toml");
  if (!(yield* fs.exists(manifest))) return "";
  const text = yield* fs.readFileString(manifest);
  return new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(text)?.[1] ?? "";
});

/** Where `install.sh` downloads a release's runner from. */
export const releaseBase = (raw: Readonly<Record<string, string>>, version: string) =>
  raw["COLLIE_RELEASE_BASE"] ?? `https://github.com/cego/collie/releases/download/${version}`;

/**
 * Why the runner `install.sh` left in `root` is refused, or null. A checkout with bun built
 * its own, as `install.sh` decides; any other was downloaded and must carry the release
 * key's signature. A refused runner is removed, so nothing runs it.
 */
export const refusedRunner = Effect.fn("release.refusedRunner")(function* (
  root: string,
  base: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  releaseKey: string = RELEASE_PUBLIC_KEY,
) {
  const fs = yield* FileSystem.FileSystem;
  const bun = yield* run("sh", ["-c", "command -v bun"], root);
  if ((yield* fs.exists(`${root}/.git`)) && bun.code === 0) return null;
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const signature = yield* run(
    "curl",
    ["-fsSL", `${base}/collie-${os}-${arch}${SIGNATURE_SUFFIX}`],
    root,
  );
  const runner = `${root}/bin/collie`;
  const bytes = yield* fs
    .readFile(runner)
    .pipe(Effect.catch(() => Effect.succeed(new Uint8Array())));
  const verdict = verifyRelease(bytes, signature.code === 0 ? signature.stdout : null, releaseKey);
  if (verdict.ok) return null;
  yield* fs.remove(runner, { force: true });
  return `${runner}: ${verdict.reason}`;
});
