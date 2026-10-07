// The files a start, a follow-up or a steer carries from the Flock chat, as paths on the
// Machine it goes to. A file already there goes as its own path; any other is read, here
// or from its own Machine's host, and uploaded through that Machine's host once per
// session (ADR-0045). A host only ever receives paths on its own Machine.

import { createHash } from "node:crypto";
import { Effect, Encoding, FileSystem, Result } from "effect";
import {
  type BoardSnapshot,
  HostRefused,
  type HostFile,
  RUN_FILE_BYTES,
} from "../../../src/board-model";
import type { ChatMachine, FlockChat } from "./flock-tools";

/** The whole file, part by part, or as much as `enough` wants. */
export const readWhole = Effect.fn("Carried.readWhole")(function* (
  machine: ChatMachine,
  path: string,
  enough: (bytes: Uint8Array) => boolean = () => false,
) {
  const parts: Uint8Array[] = [];
  let first: HostFile | null = null;
  let offset = 0;
  for (;;) {
    const part = yield* machine.door.readFile({ path, offset, length: RUN_FILE_BYTES });
    first ??= part;
    const bytes = Encoding.decodeBase64(part.content).pipe(
      Result.getOrElse(() => new Uint8Array()),
    );
    parts.push(bytes);
    offset += bytes.length;
    const all = Buffer.concat(parts);
    if (bytes.length === 0 || offset >= part.size || enough(all))
      return { file: first, bytes: new Uint8Array(all) };
  }
});

/** `bytes` on `machine`, uploaded unless this session already did, and their path there. */
const uploaded = Effect.fn("Carried.upload")(function* (
  flock: FlockChat,
  machine: ChatMachine,
  name: string,
  bytes: Uint8Array,
) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const known = flock.uploaded.get(machine.name) ?? new Map<string, string>();
  flock.uploaded.set(machine.name, known);
  const held = known.get(sha256);
  if (held !== undefined) return held;
  for (let offset = 0; ; offset += RUN_FILE_BYTES) {
    const part = bytes.subarray(offset, offset + RUN_FILE_BYTES);
    const { path } = yield* machine.door.upload({
      name,
      size: bytes.length,
      sha256,
      offset,
      content: Encoding.encodeBase64(part),
    });
    if (path !== null) {
      known.set(sha256, path);
      return path;
    }
    if (offset + RUN_FILE_BYTES >= bytes.length)
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
      paths.push(yield* uploaded(flock, machine, name, (yield* readWhole(on, path)).bytes));
    else if (path.startsWith("/")) {
      const bytes = yield* fs
        .readFile(path)
        .pipe(
          Effect.mapError(
            () => new HostRefused({ reason: `${path} cannot be read on this computer` }),
          ),
        );
      paths.push(yield* uploaded(flock, machine, name, bytes));
    } else
      return yield* new HostRefused({
        reason: `${one} is neither a path on this computer nor <machine>:<path>. Nothing was done.`,
      });
  }
  return paths;
});
