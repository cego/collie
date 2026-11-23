// How a process other than the host says what it wrote, since nothing watches
// (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs). Its own module, so a hook
// helper does not load the host to say it.

import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Layer } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { FrontDoorRpcs } from "./board-model";

/**
 * Tells the host answering in `stateDir` that these paths were written. A host that is not
 * running reads them when it starts, so a failure is no one's to handle.
 */
export const tellHost = (stateDir: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(BunSocket.layerNet({ path: `${stateDir}/host.sock` })),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    const door = yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
    yield* door.wrote({ paths });
  }).pipe(Effect.scoped, Effect.timeout("2 seconds"), Effect.ignore);
