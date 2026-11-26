import * as BunSocket from "@effect/platform-bun/BunSocket";
import { Effect, Layer } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { FrontDoorRpcs } from "./board-model";

// WARNING: in a module of its own, so a hook helper does not load the host to say what it wrote.
// WARNING: a host that is not running reads the paths when it starts, so a failure is no one's to handle.
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
