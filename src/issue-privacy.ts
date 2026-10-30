import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";

interface DirectoryAlias {
  readonly from: string;
  readonly to: string;
}

export function remoteOf(url: string): { project: string; path: string } | null {
  const raw = Str.trim(url);
  const parsed = pipe_(raw, Str.includes("://")) ? URL.parse(raw) : null;
  const scp = parsed === null ? /^(?:[^@\s]+@)?([^:/\s]+)[:/](.+)$/.exec(raw) : null;
  const host = parsed?.host ?? scp?.[1];
  const path = Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(parsed), (present) => present.pathname),
        ) ??
          Option.getOrUndefined(Option.map(Option.fromNullishOr(scp), (present_) => present_[2])),
      ),
      (present__) => pipe_(present__, Str.replace(/^\/+/, ""), Str.replace(/\.git$/, "")),
    ),
  );
  return host && path ? { project: `${host}/${path}`, path } : null;
}

const DEPTH = 6;
const SKIPPED = new Set([
  ".git",
  "node_modules",
  ".cache",
  ".local",
  ".claude",
  ".codex",
  ".npm",
  ".bun",
  ".cargo",
  ".rustup",
  ".nvm",
  ".pnpm-store",
  ".yarn",
  ".gradle",
  ".m2",
  ".vscode-server",
]);

/**
 * Working repositories under each of `roots` to depth six, including hidden, nested and
 * linked ones, plus each of `known` that is one; dependencies, Git metadata and tool
 * directories are not looked into. A link to nothing or a path the user cannot access is
 * skipped, other inspection errors propagate.
 */
export const publicationCheckouts = Effect.fn("Issues.publicationCheckouts")(function* (
  roots: ReadonlyArray<string>,
  known: ReadonlyArray<string> = [],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkouts = new Set<string>();
  const aliases: DirectoryAlias[] = [];
  // A link to nothing, such as a forwarded agent socket left by a closed login, an entry
  // removed during the walk, or a path the user cannot access, holds no checkout their Runs
  // worked in.
  const unseen = (error: PlatformError) =>
    error.reason._tag === "NotFound" || error.reason._tag === "PermissionDenied"
      ? Effect.succeed(null)
      : Effect.fail(error);
  const record = (dir: string) =>
    Effect.gen(function* () {
      const canonical = yield* fs.realPath(dir);
      if (canonical !== dir) aliases.push({ from: dir, to: canonical });
      if (yield* fs.exists(path.join(dir, ".git"))) {
        checkouts.add(dir);
        checkouts.add(canonical);
      }
      return canonical;
    });
  // Levels a directory was last walked with; a shallower route walks it again.
  const walked = new Map<string, number>();
  const children = (root: string, dir: string, left: number) =>
    Effect.gen(function* () {
      const canonical = yield* record(dir);
      const fromRoot = path.relative(root, canonical);
      if (fromRoot === ".." || pipe_(fromRoot, Str.startsWith(`..${path.sep}`))) return [];
      if (left === 0 || (walked.get(canonical) ?? -1) >= left) return [];
      walked.set(canonical, left);
      const directories: string[] = [];
      for (const name of yield* fs.readDirectory(canonical)) {
        if (SKIPPED.has(name)) continue;
        const child = path.join(canonical, name);
        const info = yield* fs.stat(child).pipe(Effect.catchTag("PlatformError", unseen));
        if (info?.type === "Directory") directories.push(child);
      }
      return directories;
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "PermissionDenied" ? Effect.succeed([]) : Effect.fail(error),
      ),
    );
  for (const root of roots) {
    const canonicalRoot = yield* fs.realPath(root);
    let level = [root];
    for (let left = DEPTH; level.length > 0; left--) {
      const found = yield* Effect.forEach(level, (dir) => children(canonicalRoot, dir, left), {
        concurrency: 8,
      });
      level = found.flat();
    }
  }
  for (const dir of known) yield* record(dir).pipe(Effect.catchTag("PlatformError", unseen));
  return { checkouts: [...checkouts].sort(), aliases };
});

/** The Git directory `dir/.git` leads to, or null for an empty `.git` or a copied submodule's gitfile. */
export const gitDirOf = Effect.fn("Issues.gitDirOf")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const marker = path.join(dir, ".git");
  const gitfile =
    (yield* fs.stat(marker)).type === "Directory"
      ? null
      : pipe_(yield* fs.readFileString(marker), Str.replace(/[\r\n]+$/, ""));
  if (gitfile !== null && !pipe_(gitfile, Str.startsWith("gitdir: "))) return null;
  const named = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(gitfile), (present___) =>
      pipe_(present___, Str.slice("gitdir: ".length)),
    ),
  );
  // Joined unnormalised, as Git does, so `..` leaves a linked `dir` physically.
  const gitDir = named === undefined ? marker : path.isAbsolute(named) ? named : `${dir}/${named}`;
  return (yield* fs.exists(`${gitDir}/HEAD`)) ? gitDir : null;
});

export function throughAliases(text: string, aliases: ReadonlyArray<DirectoryAlias>): string {
  let expanded = text;
  for (let pass = 0; pass <= text.length; pass++) {
    let next = expanded;
    for (const alias of aliases)
      next = pipe_(next, Str.replaceAll(`${alias.from}/`, `${alias.to}/`));
    if (next === expanded) return expanded;
    expanded = next;
  }
  throw new Error("directory aliases could not be resolved");
}
