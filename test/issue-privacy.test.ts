import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { publicationCheckouts } from "../src/issue-privacy";

test("the checkout inventory stays under the Projects root, though a link leads out of it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/projects`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/deeper/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/service/.git`, { recursive: true });
      yield* fs.symlink(`${tmp}/elsewhere`, `${root}/elsewhere`);
      yield* fs.symlink(`${tmp}/service`, `${root}/service`);

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`, `${root}/service`, `${tmp}/service`]);
    }),
  ));

test("a link to nothing under the Projects root, like a closed login's agent socket, is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/.ssh`, { recursive: true });
      yield* fs.symlink(`${tmp}/gone/agent.12345`, `${root}/.ssh/agent.sock`);

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`]);
    }),
  ));

test("a directory the user cannot read, or cannot look for a .git in, is skipped beside a real checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/sealed/inner/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/unlisted/inner/.git`, { recursive: true });
      yield* fs.chmod(`${root}/sealed`, 0o000);
      yield* fs.chmod(`${root}/unlisted`, 0o300);
      yield* Effect.addFinalizer(() =>
        Effect.all([fs.chmod(`${root}/sealed`, 0o700), fs.chmod(`${root}/unlisted`, 0o700)]).pipe(
          Effect.ignore,
        ),
      );

      const inventory = yield* publicationCheckouts([root]);

      expect(inventory.checkouts).toEqual([`${root}/own`]);
    }),
  ));

test("the inventory skips dependencies, Git metadata, caches and tool directories, and stops six levels down", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/b/c/d/e/deep/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/a/b/c/d/e/f/deeper/.git`, { recursive: true });
      const skipped = [
        `${root}/own/node_modules/pkg`,
        `${root}/own/.git/modules/sub`,
        `${root}/.cache/tool/repo`,
        `${root}/.local/share/plugin`,
        `${root}/.claude/plugins/cache`,
        `${root}/.npm/_cacache/repo`,
        `${root}/.bun/install/cache/repo`,
      ];
      for (const dir of skipped) yield* fs.makeDirectory(`${dir}/.git`, { recursive: true });
      const wide = Array.from({ length: 40 }, (_, i) => `${root}/own/node_modules/p${i}`);
      yield* Effect.forEach(
        Arr.flatMap(wide, (dir) =>
          Array.from({ length: 40 }, (_, j) => `${dir}/node_modules/q${j}`),
        ),
        (dir) => fs.makeDirectory(dir, { recursive: true }),
        { concurrency: 32 },
      );

      const started = yield* Clock.currentTimeMillis;
      const inventory = yield* publicationCheckouts([root]);

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
      expect(inventory.checkouts).toEqual([`${root}/a/b/c/d/e/deep`, `${root}/own`]);
    }),
  ));

test("a checkout Collie knows of is in the inventory wherever it is", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      yield* fs.makeDirectory(`${root}/own/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/sibling/.git`, { recursive: true });
      yield* fs.makeDirectory(`${tmp}/elsewhere/plain`, { recursive: true });

      const inventory = yield* publicationCheckouts(
        [root],
        [`${tmp}/elsewhere/sibling`, `${tmp}/elsewhere/plain`, `${tmp}/gone`],
      );

      expect(inventory.checkouts).toEqual([`${tmp}/elsewhere/sibling`, `${root}/own`]);
    }),
  ));

test("a root inside another root is still walked its own six levels", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      const worktrees = `${root}/.herdr/worktrees`;
      yield* fs.makeDirectory(`${worktrees}/a/b/c/d/repo/.git`, { recursive: true });

      const inventory = yield* publicationCheckouts([root, worktrees]);

      expect(inventory.checkouts).toEqual([`${worktrees}/a/b/c/d/repo`]);
    }),
  ));

test("the walk keeps at most eight filesystem calls in flight however wide the tree", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmp = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const root = `${tmp}/home`;
      const names = ["a", "b", "c", "d"];
      let level = [root];
      for (let depth = 0; depth < 5; depth++)
        level = Arr.flatMap(level, (dir) => Arr.map(names, (name) => `${dir}/${name}`));
      yield* Effect.forEach(level, (dir) => fs.makeDirectory(dir, { recursive: true }), {
        concurrency: 32,
      });
      let inFlight = 0;
      let most = 0;
      const counted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          most = Math.max(most, ++inFlight);
          return effect;
        }).pipe(Effect.ensuring(Effect.sync(() => inFlight--)));

      yield* publicationCheckouts([root]).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          stat: (path) => counted(fs.stat(path)),
          readDirectory: (path, options) => counted(fs.readDirectory(path, options)),
          realPath: (path) => counted(fs.realPath(path)),
          exists: (path) => counted(fs.exists(path)),
        }),
      );

      expect(most).toBeGreaterThan(1);
      expect(most).toBeLessThanOrEqual(8);
    }),
  ));
