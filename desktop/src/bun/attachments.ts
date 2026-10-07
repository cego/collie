// Desktop's copies of the files the human gives the Flock chat: staged from the view in
// parts, kept once by sha256 under Desktop's state directory, and read back by id for the
// model, a thumbnail or a Run (ADR-0046).

import { Clock, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { PART_BYTES } from "../../../src/board-model";
import { capRefusal, type Staged } from "../shared/attachments";

export class AttachmentRefused extends Schema.TaggedError<AttachmentRefused>()(
  "AttachmentRefused",
  { reason: Schema.String },
) {}

const refused = (reason: string) => new AttachmentRefused({ reason });

/** One part of a file on its way from the view. */
export interface StagedPart {
  /** The view's own name for this transfer, the same for all its parts. */
  readonly key: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly offset: number;
  /** This part's bytes, as base64. */
  readonly content: string;
  readonly scaledOf?: string | undefined;
}

const storeOf = (dir: string) => `${dir}/attachments`;

/** A name that stays one entry of the directory it is put in, and one line of a listing. */
const plainName = (name: string) =>
  !["", ".", "..", ".scaled"].includes(name) && !/[/\\\u0000-\u001f\u007f]/.test(name);

/** `<sha256>/<name>`, which is where a copy is kept under the store. */
const ID = /^[0-9a-f]{64}\/(.+)$/;
const validId = (id: string) => {
  const name = ID.exec(id)?.[1];
  return name !== undefined && plainName(name);
};

const mediaTypeOf = (path: string, given: string) =>
  Bun.file(path).type.split(";")[0] || given || "application/octet-stream";

/** Desktop's copy of an attachment, or null where it has none, or none any more. */
export const describeAttachment = Effect.fn("Attachments.describe")(function* (
  dir: string,
  id: string,
) {
  if (!validId(id)) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = `${storeOf(dir)}/${id}`;
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File") return null;
  const name = id.slice(65);
  return {
    id,
    name,
    size: Number(info.value.size),
    mediaType: mediaTypeOf(path, ""),
    path,
  } satisfies Staged;
});

/** Where the scaled copy of an image is kept beside its original. */
const scaledPath = (dir: string, id: string) =>
  `${storeOf(dir)}/${id.slice(0, 64)}/.scaled/${id.slice(65)}`;

/** The scaled copy of an image, where the view made one. */
export const scaledCopy = Effect.fn("Attachments.scaledCopy")(function* (dir: string, id: string) {
  if (!validId(id)) return null;
  const path = scaledPath(dir, id);
  return (yield* (yield* FileSystem.FileSystem).exists(path)) ? path : null;
});

/** `bytes` kept once under their sha256, by `name`, and the copy's descriptor. */
const keep = Effect.fn("Attachments.keep")(function* (
  dir: string,
  name: string,
  bytes: Uint8Array,
  mediaType: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const id = `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}/${name}`;
  const kept = `${storeOf(dir)}/${id}`;
  yield* fs.makeDirectory(kept.slice(0, kept.lastIndexOf("/")), { recursive: true });
  yield* fs.writeFile(kept, bytes);
  // Attached again, a copy is kept another 30 days from now.
  const now = (yield* Clock.currentTimeMillis) / 1000;
  yield* fs.utimes(kept.slice(0, kept.lastIndexOf("/")), now, now);
  return {
    id,
    name,
    size: bytes.length,
    mediaType: mediaTypeOf(kept, mediaType),
    path: kept,
  } satisfies Staged;
});

/**
 * A file on this computer, named by its path as a file manager names it, copied in; or why
 * it cannot be.
 */
export const stagePath = Effect.fn("Attachments.stagePath")(function* (dir: string, path: string) {
  const fs = yield* FileSystem.FileSystem;
  const name = path.split("/").at(-1) ?? "";
  if (!plainName(name)) return { refused: `${path} is not a file's name` };
  const info = yield* fs.stat(path).pipe(Effect.option);
  if (Option.isNone(info)) return { refused: `${path} cannot be read` };
  if (info.value.type === "Directory") return { refused: `${path} is a directory` };
  if (info.value.type !== "File") return { refused: `${path} is not a file` };
  const why = capRefusal([], { name, size: Number(info.value.size) });
  if (why !== null) return { refused: why };
  const bytes = yield* fs.readFile(path).pipe(Effect.option);
  if (Option.isNone(bytes)) return { refused: `${path} cannot be read` };
  return yield* keep(dir, name, bytes.value, "");
});

/**
 * One part of a file the view stages, appended to what came before it. The last part is
 * checked against the size, kept under its sha256 and answered with its descriptor; null
 * until then.
 */
export const stageAttachment = Effect.fn("Attachments.stage")(function* (
  dir: string,
  part: StagedPart,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!plainName(part.name)) return yield* refused(`${part.name} is not a file's name`);
  if (!/^[\w-]+$/.test(part.key)) return yield* refused(`${part.key} is not a transfer's key`);
  if (part.scaledOf !== undefined && !validId(part.scaledOf))
    return yield* refused(`${part.scaledOf} is not an attachment`);
  const why = capRefusal([], part);
  if (why !== null) return yield* refused(why);
  const decoded = Base64.decode(part.content);
  if (Result.isFailure(decoded)) return yield* refused(`a part of ${part.name} is not base64`);
  const bytes = decoded.success;
  const partial = `${storeOf(dir)}/.partial/${part.key}`;
  yield* fs.makeDirectory(path.dirname(partial), { recursive: true });
  const held =
    part.offset === 0 ? 0 : yield* fs.stat(partial).pipe(Effect.map((info) => Number(info.size)));
  if (held !== part.offset)
    return yield* refused(
      `${part.name} arrived out of order: ${held} bytes held, part at ${part.offset}`,
    );
  yield* fs.writeFile(partial, bytes, { flag: part.offset === 0 ? "w" : "a" });
  if (part.offset + bytes.length < part.size) return null;
  const whole = yield* fs.readFile(partial);
  if (whole.length !== part.size) {
    yield* fs.remove(partial);
    return yield* refused(`${part.name} came to ${whole.length} bytes, not ${part.size}`);
  }
  if (part.scaledOf !== undefined) {
    const to = scaledPath(dir, part.scaledOf);
    yield* fs.makeDirectory(path.dirname(to), { recursive: true });
    yield* fs.rename(partial, to);
    return yield* describeAttachment(dir, part.scaledOf);
  }
  yield* fs.remove(partial);
  return yield* keep(dir, part.name, whole, part.mediaType);
});

/** Part of Desktop's copy, for a thumbnail the view draws again. */
export const readAttachment = Effect.fn("Attachments.read")(function* (
  dir: string,
  id: string,
  offset = 0,
) {
  const held = yield* describeAttachment(dir, id);
  if (held === null) return yield* refused(`Desktop no longer has ${id}`);
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(held.path, { flag: "r" });
      yield* handle.seek(BigInt(offset), "start");
      const bytes = yield* handle.readAlloc(Math.max(0, Math.min(PART_BYTES, held.size - offset)));
      return {
        content: Base64.encode(Option.getOrElse(bytes, () => new Uint8Array())),
        size: held.size,
      };
    }),
  );
});
