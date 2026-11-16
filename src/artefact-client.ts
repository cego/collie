import { Effect, FileSystem, Option, Path, Stream } from "effect";
import { HostRefused, PART_BYTES, type BoardMessage } from "./board-model";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { PlatformError } from "effect/PlatformError";
import type { HostClient } from "./host";
import { ATTACHMENT_BYTES, sha256Hex } from "./attachments";

export const withArtefacts = <A, E, R>(
  board: Stream.Stream<BoardMessage, RpcClientError>,
  operation: Effect.Effect<A, E, R>,
) =>
  board.pipe(
    Stream.runHead,
    Effect.flatMap((head): Effect.Effect<A, E | HostRefused, R> =>
      Option.isSome(head) && head.value._tag === "Snapshot" && head.value.artefacts === true
        ? operation
        : Effect.fail(
            new HostRefused({
              reason:
                "invalid_state: Upgrade this Machine's Collie host to use Artefacts. Legacy Plan and Evidence remain available.",
            }),
          ),
    ),
  );

export const uploadArtefact = Effect.fn("Artefacts.upload")(function* (
  client: Pick<HostClient, "upload">,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unreadable = (cause: PlatformError) =>
    new HostRefused({ reason: `${source}: ${cause.message}` });
  const info = yield* fs.stat(source).pipe(Effect.mapError(unreadable));
  if (info.type !== "File" || Number(info.size) > ATTACHMENT_BYTES)
    return yield* new HostRefused({ reason: "Upload needs a regular file of at most 100 MiB" });
  const bytes = yield* fs.readFile(source).pipe(Effect.mapError(unreadable));
  if (bytes.length > ATTACHMENT_BYTES)
    return yield* new HostRefused({ reason: "The source grew beyond 100 MiB" });
  const sha256 = sha256Hex(bytes);
  for (let offset = 0; ; offset += PART_BYTES) {
    const result = yield* client.upload({
      name: path.basename(source),
      size: bytes.length,
      sha256,
      offset,
      content: Buffer.from(bytes.subarray(offset, offset + PART_BYTES)).toString("base64"),
    });
    if (result.path !== null) return result.path;
    if (offset + PART_BYTES >= bytes.length)
      return yield* new HostRefused({
        reason: "The destination did not retain the complete upload",
      });
  }
});
