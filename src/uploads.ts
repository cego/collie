// Files a front door sends this Machine, so a Run here can be given them by path (ADR-0045).
// Kept once by sha256: a digest held whole is answered at once, and a retried part is the
// same part, so no request id is needed. Removed a week after each arrived.

import { createHash } from "node:crypto";
import { Clock, Effect, Encoding, FileSystem, Option, Path, Result, Semaphore } from "effect";
import { ATTACHMENT_BYTES } from "./attachments";
import { HostRefused, RUN_FILE_BYTES } from "./board-model";

export const uploadsDir = (stateDir: string) => `${stateDir}/uploads`;

const refused = (reason: string) => new HostRefused({ reason });

export interface UploadPart {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly offset: number;
  /** At most 4 MiB, as base64. */
  readonly content: string;
}

// ponytail: one upload part at a time on a host; a permit per sha256 if uploads ever contend.
const receiving = Semaphore.makeUnsafe(1);

/**
 * One part of a file appended to what came before it. The last is checked against the size
 * and the digest and answers the file's path; a part before it answers null.
 */
export const receive = (stateDir: string, part: UploadPart) =>
  receiving.withPermit(receivePart(stateDir, part));

const receivePart = Effect.fn("Uploads.receive")(function* (stateDir: string, part: UploadPart) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!/^[0-9a-f]{64}$/.test(part.sha256)) return yield* refused(`${part.sha256} is not a sha256`);
  if (part.name === "" || part.name === "." || part.name === ".." || /[/\\\0]/.test(part.name))
    return yield* refused(`${part.name} is not a file's name`);
  if (part.size > ATTACHMENT_BYTES)
    return yield* refused(`${part.name} is larger than ${ATTACHMENT_BYTES / 1024 / 1024} MB`);
  const dir = path.join(uploadsDir(stateDir), part.sha256);
  const whole = path.join(dir, part.name);
  const entries = yield* fs
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const held = entries.find((entry) => entry !== ".partial");
  if (held !== undefined) {
    // The same bytes asked for under another name are that name here too.
    if (!entries.includes(part.name)) yield* fs.link(path.join(dir, held), whole);
    const now = (yield* Clock.currentTimeMillis) / 1000;
    yield* fs.utimes(dir, now, now);
    return { path: whole, complete: false };
  }
  const decoded = Encoding.decodeBase64(part.content);
  if (Result.isFailure(decoded)) return yield* refused(`a part of ${part.name} is not base64`);
  const bytes = decoded.success;
  if (bytes.length > RUN_FILE_BYTES) return yield* refused(`a part is at most 4 MiB`);
  const partial = path.join(dir, ".partial");
  yield* fs.makeDirectory(dir, { recursive: true });
  const arrived = yield* fs.stat(partial).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
  // A part sent again after it arrived is the same part.
  if (part.offset + bytes.length <= arrived && part.offset + bytes.length < part.size)
    return { path: null, complete: false };
  if (part.offset !== arrived) {
    yield* fs.remove(partial);
    return yield* refused(
      `${part.name} has ${arrived} bytes here, not ${part.offset}; send it again from the start`,
    );
  }
  yield* fs.writeFile(partial, bytes, { flag: part.offset === 0 ? "w" : "a" });
  if (part.offset + bytes.length < part.size) return { path: null, complete: false };
  const all = yield* fs.readFile(partial);
  const digest = createHash("sha256").update(all).digest("hex");
  if (all.length !== part.size || digest !== part.sha256) {
    yield* fs.remove(dir, { recursive: true });
    return yield* refused(
      `${part.name} came to ${all.length} bytes with sha256 ${digest}, not ${part.size} with ${part.sha256}`,
    );
  }
  yield* fs.rename(partial, whole);
  return { path: whole, complete: true };
});

/** How long an upload is kept after it arrived. */
const KEPT_FOR = 7 * 24 * 60 * 60 * 1000;

/** Removes every upload that arrived more than a week before `now`. */
export const pruneUploads = Effect.fn("Uploads.prune")(function* (stateDir: string, now: number) {
  const fs = yield* FileSystem.FileSystem;
  const root = uploadsDir(stateDir);
  for (const entry of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (!/^[0-9a-f]{64}$/.test(entry)) continue;
    const at = Option.flatMap(
      yield* fs.stat(`${root}/${entry}`).pipe(Effect.option),
      (info) => info.mtime,
    );
    if (Option.isSome(at) && now - at.value.getTime() > KEPT_FOR)
      yield* fs.remove(`${root}/${entry}`, { recursive: true });
  }
});
