// The Projects root (ADR-0033): the one directory every checkout a human works in lives
// under, and the checkouts found there.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Path, Result } from "effect";
import { configValue, readConfig } from "./config";
import type { PluginEnv } from "./env";
import { projectFromRemote, shell } from "./mr";
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
        if (pipe_(name, Str.startsWith(".")) || name === SKIPPED) continue;
        const child = path.join(dir, name);
        if (yield* isDirectory(child)) yield* visit(child, depth + 1);
      }
    });
  yield* visit(root, 0);
  return found.sort();
});

export const repositoryCheckout = Effect.fn("Projects.repositoryCheckout")(function* (
  env: PluginEnv,
  named: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expanded = pipe_(named, Str.startsWith("~/"))
    ? path.join(env.home, pipe_(named, Str.slice(2)))
    : named;
  const local = yield* fs.stat(path.resolve(env.cwd, expanded)).pipe(Effect.result);
  if (
    (Result.isSuccess(local) && local.success.type === "Directory") ||
    pipe_(named, Str.startsWith("/")) ||
    pipe_(named, Str.startsWith(".")) ||
    pipe_(named, Str.startsWith("~"))
  )
    return null;
  const project = projectFromRemote(pipe_(named, Str.replace(/\/+$/, "")));
  const bare = project === null && /^[^/:\s]+(?:\/[^/:\s]+)+$/.test(named);
  if (project === null && !bare) return null;
  const root = yield* projectsRoot(env);
  const found: Array<{ path: string; remote: string }> = [];
  for (const path of yield* checkoutsUnder(root.path)) {
    for (const remote of ["origin", "upstream"]) {
      const url = yield* shell("git", ["remote", "get-url", remote], path);
      const configured = yield* shell("git", ["config", "--get", `remote.${remote}.url`], path);
      const names = Arr.map(
        Arr.filter([url, configured], (one) => one.code === 0),
        (one) => projectFromRemote(one.stdout),
      );
      if (
        Arr.some(
          names,
          (actual) =>
            actual !== null &&
            (project === null
              ? pipe_(
                  actual,
                  Str.slice(Option.getOrElse(pipe_(actual, Str.indexOf("/")), () => -1) + 1),
                ) === named
              : actual === project),
        )
      ) {
        found.push({ path, remote });
        break;
      }
    }
  }
  if (found.length === 1) return found[0]!;
  return {
    error:
      found.length === 0
        ? `No checkout whose origin or upstream names "${named}" under the Projects root ${root.path}.`
        : `"${named}" names ${found.length} checkouts under ${root.path} (${Arr.join(
            Arr.map(found, (one) => one.path),
            ", ",
          )}); name its path.`,
  };
});
