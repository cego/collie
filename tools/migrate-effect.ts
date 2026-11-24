import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Path, Schema } from "effect";

class MigrationRefused extends Data.TaggedError("MigrationRefused")<{
  readonly message: string;
}> {}

const REGRESSION = "test/effect-sql-reset.test.ts";
const Manifest = Schema.fromJsonString(Schema.Struct({ version: Schema.String }));

const captured = (cwd: string, command: Array<string>) =>
  Effect.suspend(() => {
    const done = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
    return done.exitCode === 0
      ? Effect.succeed(done.stdout.toString())
      : Effect.fail(
          new MigrationRefused({
            message: `${Arr.join(command, " ")}: ${Str.trim(done.stderr.toString())}`,
          }),
        );
  });

const step = (cwd: string, command: Array<string>) =>
  Effect.suspend(() => {
    const done = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit" });
    return done.exitCode === 0
      ? Effect.void
      : Effect.fail(new MigrationRefused({ message: Arr.join(command, " ") }));
  });

// WARNING: the tracked files of the working tree, so an edit that is not committed yet is what is proved.
const copyThisTree = (root: string, into: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const listed = Str.split(yield* captured(root, ["git", "ls-files", "-z"]), "\0");
    for (const file of Arr.filter(listed, Boolean)) {
      const from = path.join(root, file);
      const info = yield* fs.stat(from);
      if (info.type !== "File") {
        continue;
      }
      yield* fs.makeDirectory(path.dirname(path.join(into, file)), { recursive: true });
      yield* fs.copyFile(from, path.join(into, file));
    }
  });

const copyMergeBase = (root: string, into: string, tar: string) =>
  Effect.gen(function* () {
    const base = Str.trim(yield* captured(root, ["git", "merge-base", "HEAD", "origin/master"]));
    yield* step(root, ["git", "archive", `--output=${tar}`, base]);
    yield* step(root, ["tar", "-xf", tar, "-C", into]);
    return `${base}, the merge-base this branch leaves`;
  });

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(import.meta.dir, "..");
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down") {
    return yield* new MigrationRefused({
      message: "usage: bun run tools/migrate-effect.ts up|down",
    });
  }
  const held = yield* fs.makeTempDirectory({ prefix: "collie-migrate-" });
  yield* Effect.gen(function* () {
    const tree = path.join(held, "tree");
    yield* fs.makeDirectory(tree);
    const where =
      direction === "up"
        ? `this tree at ${Str.trim(yield* captured(root, ["git", "rev-parse", "--short", "HEAD"]))}`
        : yield* copyMergeBase(root, tree, path.join(held, "base.tar"));
    if (direction === "up") {
      yield* copyThisTree(root, tree);
    }
    yield* Effect.log(`migrate-effect ${direction}: ${where}`);
    yield* step(tree, ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]);
    const installed = yield* Schema.decodeEffect(Manifest)(
      yield* fs.readFileString(path.join(tree, "node_modules", "effect", "package.json")),
    );
    yield* Effect.log(`migrate-effect ${direction}: effect ${installed.version} installed`);
    yield* step(tree, ["bun", "test", REGRESSION]);
  }).pipe(Effect.ensuring(fs.remove(held, { recursive: true, force: true }).pipe(Effect.orDie)));
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
