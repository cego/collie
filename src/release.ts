import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { sha256Hex } from "./attachments";
import { nowIso } from "./time";
import type { ChildProcessSpawner } from "effect/process";
import { shell, type Runner } from "./mr";

export const RELEASE_TAG = /^\d+\.\d+\.\d+$/;

export type Installation =
  | { readonly release: true }
  | { readonly release: false; readonly build: string; readonly reason: string };

const RELEASED: Installation = { release: true };

export const atCollieDir = Effect.fn("release.atCollieDir")(function* (
  root: string,
  collieDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const real = (dir: string) => fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  return (yield* real(root)) === (yield* real(collieDir));
});

export const isCheckout = Effect.fn("release.isCheckout")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const prefix = yield* run("git", ["rev-parse", "--show-prefix"], root);
  return prefix.code === 0 && Str.trim(prefix.stdout) === "";
});

export const installation = Effect.fn("release.installation")(function* (
  root: string,
  collieDir: string,
  version: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const git = (...args: string[]) => run("git", args, root);
  if (!(yield* isCheckout(root, run))) return RELEASED;
  if (yield* atCollieDir(root, collieDir)) return RELEASED;
  const sha = Str.trim((yield* git("rev-parse", "--short", "HEAD")).stdout);
  return { release: false, build: `${version}+${sha}`, reason: "it is a development checkout" };
});

const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

export const releaseVersion = Effect.fn("release.releaseVersion")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = path.join(root, "package.json");
  if (!(yield* fs.exists(manifest))) return "";
  const text = yield* fs.readFileString(manifest);
  return Option.match(Schema.decodeOption(PackageVersion)(text), {
    onNone: () => "",
    onSome: (pkg) => pkg.version,
  });
});

export const CARRIED_TREE = "/$bunfs/root/release";
export const RECORD = "placed.json";

export interface Carried {
  readonly tree: string;
  readonly runner: string;
}

export const carriedRelease = (
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
) =>
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
      Effect.orElseSucceed(() => {
        const returned: Record<string, string> = {};
        return returned;
      }),
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
  return { root: current, kept, is: files };
});
