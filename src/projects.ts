// The Projects root (ADR-0033): the one directory every checkout a human works in lives
// under, and the checkouts found there.

import { Effect, FileSystem, Path, Result } from "effect";
import { configValue, readConfig } from "./config";
import type { PluginEnv } from "./env";
import { isString } from "./schema";

export type ProjectsRootSource = "config" | "gitte" | "home";

/** The `workspace` option that roots a Run at the Projects root. */
export const PROJECTS_ROOT_OPTION = "projects-root";

export interface ProjectsRoot {
  path: string;
  source: ProjectsRootSource;
}

export const projectsRoot = Effect.fn("Projects.projectsRoot")(function* (env: PluginEnv) {
  const configured = configValue(yield* readConfig(env.userDir), "projects.root");
  if (isString(configured) && configured !== "")
    return { path: configured, source: "config" } satisfies ProjectsRoot;
  const gitte = env.raw["GITTE_CWD"];
  if (gitte) return { path: gitte, source: "gitte" } satisfies ProjectsRoot;
  return { path: env.home, source: "home" } satisfies ProjectsRoot;
});

const DEPTH = 5;
const SKIPPED = "node_modules";

/**
 * Every directory under `root`, to depth five, holding a `.git` directory, sorted. A
 * `.git` file is a worktree and is not a checkout; nothing below a checkout is looked at.
 */
export const checkoutsUnder = Effect.fn("Projects.checkoutsUnder")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: string[] = [];
  const isDirectory = (dir: string) =>
    fs.stat(dir).pipe(
      Effect.result,
      Effect.map((info) => Result.isSuccess(info) && info.success.type === "Directory"),
    );
  const visit = (dir: string, depth: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (yield* isDirectory(path.join(dir, ".git"))) {
        found.push(dir);
        return;
      }
      if (depth === DEPTH) return;
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      for (const name of names) {
        if (name.startsWith(".") || name === SKIPPED) continue;
        const child = path.join(dir, name);
        if (yield* isDirectory(child)) yield* visit(child, depth + 1);
      }
    });
  yield* visit(root, 0);
  return found.sort();
});
