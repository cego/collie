// The files a Flock chat action carries, as paths on the Machine it goes to (ADR-0046).

import { createHash } from "node:crypto";
import { Clock, Effect, FileSystem, Result } from "effect";
import { Base64 } from "effect/encoding";
import { ATTACHMENT_BYTES } from "../../../src/attachments";
import {
  type BoardSnapshot,
  HostRefused,
  type HostFile,
  PART_BYTES,
} from "../../../src/board-model";
import type { ChatMachine, FlockChat } from "./flock-tools";

const tooLarge = (path: string) =>
  new HostRefused({ reason: `${path} is larger than ${ATTACHMENT_BYTES / 1024 / 1024} MB` });

/** The whole file, part by part, or until `enough` says of the latest part. */
export const readWhole = Effect.fn("Carried.readWhole")(function* (
  machine: ChatMachine,
  path: string,
  enough: (part: Uint8Array) => boolean = () => false,
  most = Number.POSITIVE_INFINITY,
) {
  const parts: Uint8Array[] = [];
  let first: HostFile | null = null;
  let offset = 0;
  for (;;) {
    const part = yield* machine.door.readFile({ path, offset, length: PART_BYTES });
    first ??= part;
    if (part.size > most) return yield* tooLarge(`${machine.name}:${path}`);
    const bytes = Base64.decode(part.content).pipe(Result.getOrElse(() => new Uint8Array()));
    parts.push(bytes);
    offset += bytes.length;
    if (bytes.length === 0 || offset >= part.size || enough(bytes))
      return { file: first, bytes: new Uint8Array(Buffer.concat(parts)) };
  }
});

/** How long an upload is taken as still held: well inside the week a host keeps one. */
const REMEMBERED = 24 * 60 * 60 * 1000;

/** `bytes` on `machine`, uploaded unless this session did today, and their path there. */
const uploaded = Effect.fn("Carried.upload")(function* (
  flock: FlockChat,
  machine: ChatMachine,
  name: string,
  bytes: Uint8Array,
) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const known = flock.uploaded.get(machine.name) ?? new Map();
  flock.uploaded.set(machine.name, known);
  const now = yield* Clock.currentTimeMillis;
  const held = known.get(sha256);
  if (held !== undefined && now - held.at < REMEMBERED) return held.path;
  for (let offset = 0; ; offset += PART_BYTES) {
    const part = bytes.subarray(offset, offset + PART_BYTES);
    const { path } = yield* machine.door.upload({
      name,
      size: bytes.length,
      sha256,
      offset,
      content: Base64.encode(part),
    });
    if (path !== null) {
      known.set(sha256, { path, at: now });
      return path;
    }
    if (offset + PART_BYTES >= bytes.length)
      return yield* new HostRefused({ reason: `${machine.name} did not keep ${name}` });
  }
});

/**
 * What an action carries, as paths on `machine`: the files it names, or, named nowhere,
 * those of the human's message this turn. Undefined where it carries nothing to resolve.
 */
export const carriedPaths = Effect.fn("Carried.paths")(function* (
  flock: FlockChat,
  machine: ChatMachine,
  board: BoardSnapshot | null,
  given: ReadonlyArray<string> | undefined,
) {
  const named = given ?? flock.attachments()?.map(({ path }) => path);
  if (named === undefined || named.length === 0) return given;
  if (board === null)
    return yield* new HostRefused({
      reason: `${machine.name}'s board could not be read, so Desktop cannot tell whether it takes files. Nothing was done there.`,
    });
  if (board.files !== true)
    return yield* new HostRefused({
      reason: `${machine.name}'s Collie does not take files; upgrade Collie on ${machine.name}. Nothing was done there.`,
    });
  const fs = yield* FileSystem.FileSystem;
  const paths: string[] = [];
  for (const one of named) {
    const colon = one.indexOf(":");
    const on =
      colon > 0 ? flock.machines().find(({ name }) => name === one.slice(0, colon)) : undefined;
    const path = on === undefined ? one : one.slice(colon + 1);
    const name = path.split("/").at(-1) ?? path;
    if (on?.name === machine.name) paths.push(path);
    else if (on !== undefined)
      paths.push(
        yield* uploaded(
          flock,
          machine,
          name,
          (yield* readWhole(on, path, undefined, ATTACHMENT_BYTES)).bytes,
        ),
      );
    else if (path.startsWith("/")) {
      const unreadable = () =>
        new HostRefused({ reason: `${path} cannot be read on this computer` });
      const info = yield* fs.stat(path).pipe(Effect.mapError(unreadable));
      if (info.type !== "File") return yield* unreadable();
      if (Number(info.size) > ATTACHMENT_BYTES) return yield* tooLarge(path);
      const bytes = yield* fs.readFile(path).pipe(Effect.mapError(unreadable));
      paths.push(yield* uploaded(flock, machine, name, bytes));
    } else
      return yield* new HostRefused({
        reason: `${one} is neither a path on this computer nor <machine>:<path>. Nothing was done.`,
      });
  }
  return paths;
});
