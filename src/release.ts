import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Path, Schema } from "effect";
import { sha256Hex } from "./attachments";
import { nowIso } from "./time";
import type { ChildProcessSpawner } from "effect/process";
import { shell, type Runner } from "./mr";

// ponytail: the one branch releases are cut from; read origin/HEAD if that ever varies.
const RELEASE_BRANCH = "master";
export const RELEASE_TAG = /^\d+\.\d+\.\d+$/;

export type Installation =
  | { readonly release: true }
  | { readonly release: false; readonly build: string; readonly reason: string };

const RELEASED: Installation = { release: true };

/** Whether `root` is the Collie directory itself, however either is spelled. */
export const atCollieDir = Effect.fn("release.atCollieDir")(function* (
  root: string,
  collieDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const real = (dir: string) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  return (yield* real(root)) === (yield* real(collieDir));
});

/** Whether `root` is the top of a git worktree; a release placed inside a kept clone is not. */
export const isCheckout = Effect.fn("release.isCheckout")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const prefix = yield* run("git", ["rev-parse", "--show-prefix"], root);
  return prefix.code === 0 && Str.trim(prefix.stdout) === "";
});

/**
 * Not a checkout is a release, and so is a clone at the Collie directory, which its next
 * upgrade migrates. Any other checkout is a development checkout.
 */
export const installation = Effect.fn("release.installation")(function* (
  root: string,
  collieDir: string,
  version: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
): Effect.fn.Return<
  Installation,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  const git = (...args: string[]) => run("git", args, root);
  if (!(yield* isCheckout(root, run))) return RELEASED;
  if (yield* atCollieDir(root, collieDir)) return RELEASED;
  const sha = Str.trim((yield* git("rev-parse", "--short", "HEAD")).stdout);
  return { release: false, build: `${version}+${sha}`, reason: "it is a development checkout" };
});

/** One string field of the plugin manifest at `root`, or "" where there is none. */
export const manifestField = Effect.fn("release.manifestField")(function* (
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

/** The release a compiled runner carries, embedded by `tools/build.ts`. */
export const CARRIED_TREE = "/$bunfs/root/release";
/** Each placed file's sha256, written into the release it describes. */
export const RECORD = "placed.json";

export interface Carried {
  readonly tree: string;
  readonly runner: string;
}

/** What this runner carries: nothing unless it is a compiled build. */
export const carriedRelease = (
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
): Carried | null =>
  pipe_(modulePath, Str.startsWith("/$bunfs/")) ? { tree: CARRIED_TREE, runner: execPath } : null;

const Placed = Schema.fromJsonString(
  Schema.Struct({ version: Schema.String, files: Schema.Record(Schema.String, Schema.String) }),
);

const filesUnder = Effect.fn("release.filesUnder")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir, { recursive: true });
  const files: string[] = [];
  for (const name of names) {
    if ((yield* fs.stat(path.join(dir, name))).type === "File") files.push(name);
  }
  return files.sort();
});

/**
 * Writes `carried` into `<collieDir>/release` whole: beside the current one, recorded, then
 * swapped. Every file of the current release that differs from its own record is copied into
 * `kept/<when>/` first; the result names each, relative to `collieDir`. Unlocked: callers go
 * through `placeLocked`.
 */
export const placeRelease = Effect.fn("release.place")(function* (
  carried: Carried,
  collieDir: string,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = path.join(collieDir, "release");
  const next = path.join(collieDir, "release.new");
  const old = path.join(collieDir, "release.old");
  yield* fs.remove(next, { recursive: true, force: true });
  yield* fs.remove(old, { recursive: true, force: true });

  const files: Record<string, string> = {};
  for (const name of yield* filesUnder(carried.tree)) {
    const bytes = yield* fs.readFile(path.join(carried.tree, name));
    yield* fs.makeDirectory(path.dirname(path.join(next, name)), { recursive: true });
    yield* fs.writeFile(path.join(next, name), bytes);
    files[name] = sha256Hex(bytes);
  }
  const runner = yield* fs.readFile(carried.runner);
  yield* fs.makeDirectory(path.join(next, "bin"), { recursive: true });
  yield* fs.writeFile(path.join(next, "bin", "collie"), runner);
  yield* fs.chmod(path.join(next, "bin", "collie"), 0o755);
  files["bin/collie"] = sha256Hex(runner);
  yield* fs.writeFileString(
    path.join(next, RECORD),
    yield* Schema.encodeEffect(Placed)({ version, files }).pipe(Effect.orDie),
  );

  const kept: string[] = [];
  if (yield* fs.exists(current)) {
    const recorded = yield* fs.readFileString(path.join(current, RECORD)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Placed)),
      Effect.map((record) => record.files),
      Effect.orElseSucceed((): Record<string, string> => ({})),
    );
    const when = pipe_(yield* nowIso, Str.replace(/:/g, "-"));
    for (const name of yield* filesUnder(current)) {
      if (name === RECORD) continue;
      const bytes = yield* fs.readFile(path.join(current, name));
      if (recorded[name] === sha256Hex(bytes)) continue;
      const aside = path.join("kept", when, name);
      yield* fs.makeDirectory(path.dirname(path.join(collieDir, aside)), { recursive: true });
      yield* fs.writeFile(path.join(collieDir, aside), bytes);
      kept.push(aside);
    }
    yield* fs.rename(current, old);
  }
  yield* fs.rename(next, current);
  yield* fs.remove(old, { recursive: true, force: true });
  return { root: current, kept };
});
