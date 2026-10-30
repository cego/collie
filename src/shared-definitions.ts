import * as Cause from "effect/Cause";
// The user Layer's files as a Flock shares them: each decided by its latest edit, a removal
// included, with what an edit replaced kept under `replaced/`
// (ADR-0061).

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import * as Rec from "effect/Record";
import { Data, Effect, FileSystem, Option, Schema } from "effect";
import type { SharedDefinition } from "./definitions-model";
import { TOOLCHAIN_NAMES } from "./engine";
import { latestEdits } from "./flock-settings";
import { epochMs, fileTime } from "./time";
import { ensureLockDir, withLock } from "./lock";

const KINDS = ["workflows", "personas"] as const;

/** What this Machine last saw of each shared definition, so a removal is noticed. */
const Seen = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ at: Schema.String, removed: Schema.Boolean })),
);
type Seen = typeof Seen.Type;
const SEEN_FILE = "definitions-set.json";

export const byPath = (definition: { readonly path: string }) => definition.path;

/**
 * A path a shared definition may have: a file directly in one of the two directories, and
 * neither the toolchain's nor a hidden or backup file an editor leaves beside one.
 */
const shareable = (path: string) => {
  const [kind, name, ...deeper] = Str.split(path, "/");
  return (
    Arr.some(KINDS, (one) => one === kind) &&
    name !== undefined &&
    deeper.length === 0 &&
    name !== "" &&
    !pipe_(name, Str.startsWith(".")) &&
    !pipe_(name, Str.endsWith("~")) &&
    !TOOLCHAIN_NAMES.includes(name)
  );
};

const isLink = Effect.fn("SharedDefinitions.isLink")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readLink(file)
    .pipe(Effect.match({ onFailure: () => false, onSuccess: () => true }));
});

/** Whether a part of `path` in the user directory is a link, which could reach outside it. */
const throughLink = Effect.fn("SharedDefinitions.throughLink")(function* (
  userDir: string,
  path: string,
) {
  const parts = Str.split(path, "/");
  for (let at = 1; at <= parts.length; at++)
    if (yield* isLink(`${userDir}/${Arr.join(parts.slice(0, at), "/")}`)) return true;
  return false;
});

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const isBase64 = (text: string) => base64(Buffer.from(text, "base64")) === text;

/** When the file at `file` was last modified; null where there is none. */
const modifiedAt = Effect.fn("SharedDefinitions.modifiedAt")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(
    Effect.map((info) => Option.getOrNull(info.mtime)?.toISOString() ?? null),
    Effect.orElseSucceed(() => null),
  );
});

const onDisk = Effect.fn("SharedDefinitions.onDisk")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const found: Array<SharedDefinition> = [];
  for (const kind of KINDS) {
    const dir = `${userDir}/${kind}`;
    if (!(yield* fs.exists(dir)) || (yield* isLink(dir))) continue;
    for (const name of (yield* fs.readDirectory(dir)).sort()) {
      const path = `${kind}/${name}`;
      if (!shareable(path) || (yield* isLink(`${dir}/${name}`))) continue;
      const info = yield* fs.stat(`${dir}/${name}`);
      const mtime = Option.getOrUndefined(info.mtime);
      if (info.type !== "File" || mtime === undefined) continue;
      found.push({
        path,
        base64: base64(yield* fs.readFile(`${dir}/${name}`)),
        at: mtime.toISOString(),
      });
    }
  }
  return found;
});

const readSeen = Effect.fn("SharedDefinitions.readSeen")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(`${userDir}/${SEEN_FILE}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Seen)),
    Effect.orElseSucceed((): Seen => ({})),
  );
});

const writeSeen = Effect.fn("SharedDefinitions.writeSeen")(function* (userDir: string, seen: Seen) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    `${userDir}/${SEEN_FILE}`,
    `${yield* Schema.encodeEffect(Seen)(seen).pipe(Effect.orDie)}\n`,
  );
});

const locked = <A, E, R>(userDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = `${userDir}/definitions.lock`;
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new Cause.TimeoutError(`${lock} could not be acquired; not writing unlocked`)),
      effect,
    );
  });

/** What is on disk now, and each file seen before and gone since, removed when first missed. */
const readShared = Effect.fn("SharedDefinitions.read")(function* (userDir: string, now: string) {
  const present = yield* onDisk(userDir);
  const seen = yield* readSeen(userDir);
  const gone = Arr.flatMap(Rec.toEntries(seen), ([path, last]): SharedDefinition[] =>
    Arr.some(present, (one) => one.path === path)
      ? []
      : [{ path, base64: null, at: last.removed ? last.at : now }],
  );
  const next: Seen = Rec.fromEntries(
    Arr.map(
      [...present, ...gone],
      (one) => [one.path, { at: one.at, removed: one.base64 === null }] as const,
    ),
  );
  if (
    (yield* Schema.encodeEffect(Seen)(next).pipe(Effect.orDie)) !==
    (yield* Schema.encodeEffect(Seen)(seen).pipe(Effect.orDie))
  )
    yield* writeSeen(userDir, next);
  return [...present, ...gone].sort((a, b) => pipe_(a.path, Str.localeCompare(b.path)));
});

/** This Machine's shared definitions, each with when it was last edited. */
export const sharedDefinitions = (userDir: string, now: string) =>
  locked(userDir, readShared(userDir, now));

/** A shared definition given at a path that is not one, which nothing is written for. */
export class DefinitionRefused extends Data.TaggedError("DefinitionRefused")<{
  readonly reason: string;
}> {}

/**
 * The Flock's edits, each written where it is later than this Machine's, with the edit's
 * own time. The file a write replaces or removes is kept under `replaced/` first, and an
 * edit is left unwritten where that or its own path is through a link. Refused whole where
 * any path is not a shared definition's, or any time or content is malformed.
 */
export const takeDefinitions = (
  userDir: string,
  given: ReadonlyArray<SharedDefinition>,
  by: string,
  now: string,
) =>
  locked(
    userDir,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outside = Option.getOrUndefined(Arr.findFirst(given, (one) => !shareable(one.path)));
      if (outside !== undefined)
        return yield* new DefinitionRefused({
          reason: `${outside.path} is not a file directly in the user Layer's workflows/ or personas/`,
        });
      const malformed = Option.getOrUndefined(
        Arr.findFirst(
          given,
          (one) => Number.isNaN(epochMs(one.at)) || (one.base64 !== null && !isBase64(one.base64)),
        ),
      );
      if (malformed !== undefined)
        return yield* new DefinitionRefused({
          reason: `${malformed.path}'s edit has a malformed time or content`,
        });
      const held = yield* readShared(userDir, now);
      let seen = yield* readSeen(userDir);
      for (const edit of latestEdits(held, given, byPath).take) {
        const file = `${userDir}/${edit.path}`;
        const had = Option.getOrUndefined(Arr.findFirst(held, (one) => one.path === edit.path));
        const content = had?.base64 ?? null;
        if (yield* throughLink(userDir, edit.path)) continue;
        // Saved by hand since it was read: left alone.
        if ((yield* modifiedAt(file)) !== (content === null ? null : had?.at)) continue;
        if (had !== undefined && content !== null && content !== edit.base64) {
          const replaced = `replaced/${had.at}/${edit.path}`;
          if (yield* throughLink(userDir, replaced)) continue;
          const kept = `${userDir}/${replaced}`;
          yield* fs.makeDirectory(
            pipe_(
              kept,
              Str.slice(
                0,
                Option.getOrElse(pipe_(kept, Str.lastIndexOf("/")), () => -1),
              ),
            ),
            { recursive: true },
          );
          yield* fs.writeFile(kept, Buffer.from(content, "base64"));
          yield* Effect.logWarning(
            `${edit.path} ${edit.base64 === null ? "removed" : "replaced"} by a later edit from ${by}; it is kept at ${kept}`,
          );
        }
        if (edit.base64 === null) yield* fs.remove(file, { force: true });
        else {
          yield* fs.makeDirectory(
            pipe_(
              file,
              Str.slice(
                0,
                Option.getOrElse(pipe_(file, Str.lastIndexOf("/")), () => -1),
              ),
            ),
            { recursive: true },
          );
          yield* fs.writeFile(file, Buffer.from(edit.base64, "base64"));
          yield* fs.utimes(file, fileTime(edit.at), fileTime(edit.at));
        }
        seen = { ...seen, [edit.path]: { at: edit.at, removed: edit.base64 === null } };
      }
      yield* writeSeen(userDir, seen);
      return yield* readShared(userDir, now);
    }),
  );

/** The edits of `given` that `held` now has, which a write leaves out where it was later. */
export const landed = (
  given: ReadonlyArray<SharedDefinition>,
  held: ReadonlyArray<SharedDefinition>,
) =>
  Arr.filter(given, (one) => Arr.some(held, (has) => has.path === one.path && has.at === one.at));
