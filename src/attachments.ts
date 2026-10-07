// What a Run was given beside its words: files the host copies into the Run's own
// directory, and every prompt of the Run lists (ADR-0045).

import { createHash } from "node:crypto";
import { Effect, FileSystem, Path } from "effect";

/** The most a host takes of one file. */
export const ATTACHMENT_BYTES = 100 * 1024 * 1024;

export const attachmentsDir = (runDir: string) => `${runDir}/attachments`;

/** A file in a Run's `attachments/`, as a prompt lists it. */
export interface Attachment {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly path: string;
}

/** What the request named, and the name the Run keeps it under. */
export type Attached = {
  readonly name: string;
  readonly from: string;
};

/** Why the first of these paths cannot be attached, naming it; null where all can. */
export const attachmentRefusal = Effect.fn("attachments.refusal")(function* (
  paths: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const path of paths) {
    const info = yield* fs.stat(path).pipe(Effect.option);
    if (info._tag === "None") return `attachment ${path} does not exist`;
    if (info.value.type !== "File") return `attachment ${path} is not a regular file`;
    if (Number(info.value.size) > ATTACHMENT_BYTES)
      return `attachment ${path} is larger than ${ATTACHMENT_BYTES / 1024 / 1024} MB`;
    const readable = yield* fs.access(path, { readable: true }).pipe(Effect.isSuccess);
    if (!readable) return `attachment ${path} cannot be read`;
  }
  return null;
});

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(b);

/**
 * The name each source takes in `dir`, or in an empty directory where that is null: its
 * own, unless that name holds other content, then under a short sha256 prefix. Nothing is
 * written.
 */
export const namesIn = Effect.fn("attachments.namesIn")(function* (
  dir: string | null,
  sources: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const planned = new Map<string, Uint8Array>();
  const held = (name: string) =>
    planned.has(name) || dir === null
      ? Effect.succeed(planned.get(name) ?? null)
      : fs.readFile(path.join(dir, name)).pipe(Effect.orElseSucceed(() => null));
  const named: Array<Attached & { readonly bytes: Uint8Array }> = [];
  for (const from of sources) {
    const bytes = yield* fs.readFile(from);
    const own = path.basename(from);
    const there = yield* held(own);
    const name =
      there === null || sameBytes(there, bytes) ? own : `${digest(bytes).slice(0, 8)}-${own}`;
    planned.set(name, bytes);
    named.push({ name, from, bytes });
  }
  return named;
});

/** Copies each source into `dir`, never a link, and answers the name each is kept under. */
export const copyInto = Effect.fn("attachments.copyInto")(function* (
  dir: string,
  sources: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (sources.length === 0) return [];
  const named = yield* namesIn(dir, sources);
  yield* fs.makeDirectory(dir, { recursive: true });
  for (const { name, bytes } of named) yield* fs.writeFile(path.join(dir, name), bytes);
  return named.map(({ name, from }): Attached => ({ name, from }));
});

/** Every file in `dir`, by name; none where there is no such directory. */
export const listAttachments = Effect.fn("attachments.list")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const found: Attachment[] = [];
  for (const name of names.toSorted()) {
    const file = path.join(dir, name);
    const info = yield* fs.stat(file).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") continue;
    found.push({ name, mediaType: mediaTypeOf(file), size: Number(info.value.size), path: file });
  }
  return found;
});

const mediaTypeOf = (file: string) =>
  Bun.file(file).type.split(";")[0] || "application/octet-stream";

/** The line a steer's text gains for each file it brought. */
export const attachedLine = (path: string) => `Attached: ${path}`;

/** Paths as typed at a prompt: separated by spaces, with shell-style quotes and `\` escapes. */
export const typedPaths = (typed: string) => {
  const paths: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let at = 0; at < typed.length; at++) {
    const char = typed[at]!;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && at + 1 < typed.length) word += typed[++at]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && at + 1 < typed.length) word = (word ?? "") + typed[++at]!;
    else if (/\s/.test(char)) {
      if (word !== null) paths.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (word !== null) paths.push(word);
  return paths;
};
