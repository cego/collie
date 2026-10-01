// The Projects root and the checkouts under it: where a Run started from the Home is
// rooted, and the one listing the router and an agent's refusal choose from.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { writeConfigValue } from "../src/config";
import { checkoutsUnder, projectsRoot } from "../src/projects";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("projects.root in the config wins, and says it came from there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeConfigValue(rig.userDir, "projects.root", "/work/mine");
      const env = rig.pluginEnv({ GITTE_CWD: "/work/gitte" });

      expect(yield* projectsRoot(env)).toEqual({ path: "/work/mine", source: "config" });
    }),
  ));

test("without a configured root, gitte's folder is the root", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv({ GITTE_CWD: "/work/gitte" });

      expect(yield* projectsRoot(env)).toEqual({ path: "/work/gitte", source: "gitte" });
    }),
  ));

test("with neither, the human's home is the root", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();

      expect(yield* projectsRoot(env)).toEqual({ path: rig.root, source: "home" });
    }),
  ));

test("the checkouts are the real ones, never a worktree, a hidden one or a dependency's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = `${rig.root}/projects`;
      const dirs = [
        "shallow/.git",
        "shallow/vendor/inner/.git",
        "a/b/c/deep/.git",
        "a/b/c/deep/sub/.git",
        "a/b/c/d/e/too-deep/.git",
        ".hidden/repo/.git",
        "web/node_modules/dep/.git",
      ];
      for (const dir of dirs) yield* fs.makeDirectory(`${root}/${dir}`, { recursive: true });
      yield* fs.makeDirectory(`${root}/worktree`, { recursive: true });
      yield* fs.writeFileString(`${root}/worktree/.git`, "gitdir: /elsewhere/.git/worktrees/w\n");

      expect(yield* checkoutsUnder(root)).toEqual([`${root}/a/b/c/deep`, `${root}/shallow`]);
    }),
  ));
