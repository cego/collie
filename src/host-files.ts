// A Machine's files as its host hands them to a front door: the Flock chat's Read, Glob,
// Grep, Write and Edit on a Machine it does not run on (ADR-0011, the Flock chat reaches
// files). Paths are absolute on this Machine; nothing is written inside the host's state.

import { Effect, Encoding, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mediaTypeOf } from "./attachments";
import { HostRefused, RUN_FILE_BYTES, type HostFile } from "./board-model";

/** The most paths a glob answers, and lines a grep does, unless asked for fewer. */
export const FOUND_LIMIT = 100;
/** Where a search stops looking; `omitted` past it is a lower bound. */
export const SEARCH_LIMIT = 10_000;

const refused = (reason: string) => new HostRefused({ reason });

const absolute = Effect.fn("HostFiles.absolute")(function* (path: string) {
  const paths = yield* Path.Path;
  return paths.isAbsolute(path)
    ? paths.normalize(path)
    : yield* refused(`${path} is not absolute: a path on a Machine is named from its root`);
});

export const readPart = Effect.fn("HostFiles.read")(function* (
  asked: string,
  offset = 0,
  length = RUN_FILE_BYTES,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* absolute(asked);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const info = yield* fs.stat(path);
      if (info.type !== "File") return yield* refused(`${path} is not a file`);
      const size = Number(info.size);
      const from = Math.min(Math.max(0, offset), size);
      const handle = yield* fs.open(path, { flag: "r" });
      yield* handle.seek(BigInt(from), "start");
      const bytes = yield* handle.readAlloc(
        Math.min(Math.max(0, Math.min(length, RUN_FILE_BYTES)), size - from),
      );
      const content = Encoding.encodeBase64(Option.getOrElse(bytes, () => new Uint8Array()));
      return { path, size, mediaType: mediaTypeOf(path), content } satisfies HostFile;
    }),
  ).pipe(
    Effect.mapError((cause) => (Schema.is(HostRefused)(cause) ? cause : refused(String(cause)))),
  );
});

/** Each name `segment` stands for, its braces expanded innermost first. */
const expanded = (segment: string): ReadonlyArray<string> => {
  const braces = /\{([^{}]*)\}/.exec(segment);
  if (braces === null) return [segment];
  const [before, after] = [
    segment.slice(0, braces.index),
    segment.slice(braces.index + braces[0].length),
  ];
  return braces[1]!.split(",").flatMap((one) => expanded(before + one + after));
};

/** The dot names `pattern` asks for, `{.env,.envrc}` as two. */
const dotNames = (pattern: string) =>
  pattern
    .split("/")
    .flatMap(expanded)
    .filter((name) => name.startsWith("."));

/**
 * Whether `pattern` reaches `relative`: it matches, and each dot-named segment is one the
 * pattern names with a dot, as Glob leaves `.git` to a pattern that asks for it.
 */
const reaches = (pattern: string) => {
  const glob = new Bun.Glob(pattern);
  const dotted = dotNames(pattern).map((segment) => new Bun.Glob(segment));
  return (relative: string) =>
    glob.match(relative) &&
    relative
      .split("/")
      .every((segment) => !segment.startsWith(".") || dotted.some((one) => one.match(segment)));
};

/** Files under `dir` matching `pattern`, newest first, and how many beyond the bound. */
export const globFiles = Effect.fn("HostFiles.glob")(function* (
  pattern: string,
  dir: string,
  bound = SEARCH_LIMIT,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* absolute(dir);
  const paths = yield* Path.Path;
  const matches = reaches(pattern);
  const keep = (line: string) => matches(paths.relative(root, line));
  const dotted = dotNames(pattern);
  // The root must list; an unreadable directory below it is passed by.
  yield* fs
    .readDirectory(root)
    .pipe(Effect.mapError((cause) => refused(`${root} cannot be listed: ${String(cause)}`)));
  const rg = Bun.which("rg");
  // Links below the root are not followed, so a loop of them ends, and a dot directory is
  // entered only where the pattern names it: find prunes by those names, so it takes a
  // dotted pattern.
  const listed = yield* (
    rg === null || dotted.length > 0
      ? searched(
          "find",
          [
            "-H",
            root,
            "-mindepth",
            "1",
            "-name",
            ".*",
            ...dotted.flatMap((name) => ["!", "-name", name]),
            "-prune",
            "-o",
            "-type",
            "f",
            "-print",
          ],
          root,
          bound,
          bound,
          keep,
        )
      : searched(rg, ["--files", "--no-ignore", "--no-messages", root], root, bound, bound, keep)
  ).pipe(Effect.mapError((cause) => refused(`the search of ${root} failed: ${String(cause)}`)));
  const found = listed.lines;
  const matched: Array<{ readonly path: string; readonly at: number }> = [];
  for (const path of found) {
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (info._tag === "Some")
      matched.push({
        path,
        at: Option.match(info.value.mtime, { onNone: () => 0, onSome: (at) => at.getTime() }),
      });
  }
  matched.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  return {
    paths: matched.slice(0, FOUND_LIMIT).map(({ path }) => path),
    omitted: Math.max(0, matched.length - FOUND_LIMIT),
  };
});

export interface GrepAsked {
  readonly pattern: string;
  readonly path: string;
  readonly glob?: string | undefined;
  readonly type?: string | undefined;
  readonly outputMode?: "content" | "files_with_matches" | "count" | undefined;
  readonly ignoreCase?: boolean | undefined;
  readonly lineNumbers?: boolean | undefined;
  readonly before?: number | undefined;
  readonly after?: number | undefined;
  readonly context?: number | undefined;
  readonly headLimit?: number | undefined;
  readonly multiline?: boolean | undefined;
}

const count = (flag: string, value: number | undefined) =>
  value === undefined ? [] : [flag, String(value)];

/** Ripgrep's arguments for a search, as Claude Code's Grep asks it. */
const rgArgs = (asked: GrepAsked, mode: string) => [
  "--with-filename",
  ...(mode === "files_with_matches"
    ? ["--files-with-matches"]
    : mode === "count"
      ? ["--count"]
      : []),
  ...(asked.ignoreCase ? ["-i"] : []),
  ...(mode === "content" && asked.lineNumbers ? ["-n"] : []),
  ...(mode === "content" ? [...count("-B", asked.before), ...count("-A", asked.after)] : []),
  ...(mode === "content" ? count("-C", asked.context) : []),
  ...(asked.glob === undefined ? [] : ["--glob", asked.glob]),
  ...(asked.type === undefined ? [] : ["--type", asked.type]),
  ...(asked.multiline ? ["-U", "--multiline-dotall"] : []),
  "--",
  asked.pattern,
];

/** The same with `grep -r`, which has no file types and no multiline. */
const grepArgs = (asked: GrepAsked, mode: string) => [
  "-r",
  "-H",
  "-E",
  ...(mode === "files_with_matches" ? ["-l"] : mode === "count" ? ["-c"] : []),
  ...(asked.ignoreCase ? ["-i"] : []),
  ...(mode === "content" && asked.lineNumbers ? ["-n"] : []),
  ...(mode === "content" ? [...count("-B", asked.before), ...count("-A", asked.after)] : []),
  ...(mode === "content" ? count("-C", asked.context) : []),
  ...(asked.glob === undefined ? [] : [`--include=${asked.glob}`]),
  "--",
  asked.pattern,
];

/** The first `limit` lines a search prints, and how many more, counted to `bound`. */
const searched = (
  cmd: string,
  args: ReadonlyArray<string>,
  cwd: string,
  limit: number,
  bound: number,
  keep: (line: string) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd, args, { cwd, stdout: "pipe", stderr: "ignore", extendEnv: true }),
    );
    const lines: string[] = [];
    const seen = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line !== "" && keep(line)),
      Stream.take(bound),
      Stream.runFold(
        () => 0,
        (count, line) => {
          if (count < limit) lines.push(line);
          return count + 1;
        },
      ),
    );
    // Cut short, the search is stopped rather than waited on.
    const code = seen >= bound ? 0 : Number(yield* handle.exitCode);
    return { lines, omitted: seen - lines.length, code };
  }).pipe(Effect.scoped);

export const grepFiles = Effect.fn("HostFiles.grep")(function* (
  asked: GrepAsked,
  bound = SEARCH_LIMIT,
) {
  const root = yield* absolute(asked.path);
  const mode = asked.outputMode ?? "files_with_matches";
  const rg = Bun.which("rg");
  // A search of one file runs beside it: a file is no working directory.
  const cwd = (yield* (yield* FileSystem.FileSystem).stat(root).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  ))
    ? root
    : (yield* Path.Path).dirname(root);
  const limit = Math.min(asked.headLimit ?? FOUND_LIMIT, FOUND_LIMIT);
  const found = yield* (
    rg === null
      ? searched("grep", [...grepArgs(asked, mode), root], cwd, limit, bound)
      : searched(rg, [...rgArgs(asked, mode), root], cwd, limit, bound)
  ).pipe(Effect.mapError((cause) => refused(`the search of ${root} failed: ${String(cause)}`)));
  // Exit 1 is "nothing matched"; anything above it is the search's own failure.
  if (found.code > 1) return yield* refused(`the search of ${root} failed (exit ${found.code})`);
  return { text: found.lines.join("\n"), omitted: found.omitted };
});

/**
 * Where `path` really is: the nearest part of it that exists with every link followed,
 * and the rest as written.
 */
const realOf = Effect.fn("HostFiles.realOf")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  let existing = path;
  let rest = "";
  for (let links = 0; ;) {
    const real = yield* fs.realPath(existing).pipe(Effect.option);
    if (real._tag === "Some") return rest === "" ? real.value : paths.join(real.value, rest);
    // A link to nothing yet is where a write through it lands.
    const target = yield* fs.readLink(existing).pipe(Effect.option);
    if (target._tag === "Some") {
      if (++links > 40) return yield* refused(`${path} has too many links to follow`);
      existing = paths.resolve(paths.dirname(existing), target.value);
      continue;
    }
    const parent = paths.dirname(existing);
    if (parent === existing) return path;
    rest = rest === "" ? paths.basename(existing) : paths.join(paths.basename(existing), rest);
    existing = parent;
  }
});

/** `path`, refused where it is inside `state`: a Run's state is changed through the host. */
const writable = Effect.fn("HostFiles.writable")(function* (asked: string, state: string) {
  const paths = yield* Path.Path;
  const path = yield* absolute(asked);
  const real = yield* realOf(path);
  const top = yield* realOf(state);
  if (real === top || real.startsWith(`${top}${paths.sep}`))
    return yield* refused(
      `${path} is inside the host's state directory ${state}, which only its operations change`,
    );
  return path;
});

export const writeWhole = Effect.fn("HostFiles.write")(function* (
  asked: string,
  content: string,
  state: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const path = yield* writable(asked, state);
  yield* fs.makeDirectory(paths.dirname(path), { recursive: true });
  yield* fs.writeFileString(path, content);
  return { path, bytes: new TextEncoder().encode(content).length };
});

export const editString = Effect.fn("HostFiles.edit")(function* (
  asked: {
    readonly path: string;
    readonly oldString: string;
    readonly newString: string;
    readonly replaceAll?: boolean | undefined;
  },
  state: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* writable(asked.path, state);
  if (asked.oldString === asked.newString)
    return yield* refused("old_string and new_string are the same: there is nothing to change");
  const text = yield* fs.readFileString(path);
  const replaced = asked.oldString === "" ? 0 : text.split(asked.oldString).length - 1;
  if (replaced === 0) return yield* refused(`old_string is not in ${path}`);
  if (replaced > 1 && !asked.replaceAll)
    return yield* refused(
      `old_string is in ${path} ${replaced} times: give more of the text around it to make it unique, or set replace_all`,
    );
  yield* fs.writeFileString(
    path,
    text.replaceAll(asked.oldString, () => asked.newString),
  );
  return { path, replaced };
});
