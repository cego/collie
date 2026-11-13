import { Effect, Option, Stream } from "effect";
import { HostRefused, type BoardMessage } from "./board-model";
import type { RpcClientError } from "effect/rpc/RpcClientError";

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
