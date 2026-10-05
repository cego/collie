// Desktop's channel to a Machine's host: a bridge command started as `desktop`, whose
// output after the ready marker is the host's socket. Never Collie's own host client: over
// a channel that would start a host on this computer, or signal a pid that is not its own.

import { Effect, Layer, Stream } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { BRIDGE_READY, FrontDoorRpcs } from "../../../src/board-model";
import { type Machine, type MachineMessage, MachineUnreachable } from "../shared/flock";

/** The bridge `collie` runs for Desktop, which records Desktop's computer with what it does. */
export const bridgeCommand = (collie: ReadonlyArray<string>, client: string) => [
  ...collie,
  "bridge",
  "--as",
  "desktop",
  "--client",
  client,
];

/** Everything after the ready marker, whatever a login shell printed before it. */
const afterReady = (from: ReadableStream<Uint8Array>) => {
  const marker = new TextEncoder().encode(`${BRIDGE_READY}\n`);
  let seen = Buffer.alloc(0);
  let ready = false;
  return from.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, out) => {
        if (ready) return out.enqueue(chunk);
        // Searched as bytes, so a character split across chunks reaches the host whole.
        seen = Buffer.concat([seen, chunk]);
        const at = seen.indexOf(marker);
        if (at === -1) return;
        ready = true;
        const rest = seen.subarray(at + marker.length);
        if (rest.length > 0) out.enqueue(rest);
      },
    }),
  );
};

/** Starts the bridge and speaks `FrontDoorRpcs` over its stdio until the scope closes. */
export const openBridge = Effect.fn("Desktop.openBridge")(function* (
  command: ReadonlyArray<string>,
  env?: Readonly<Record<string, string>>,
) {
  const child = Bun.spawn([...command], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => child.kill()));
  const socket = yield* Socket.fromTransformStream(
    Effect.succeed({
      readable: afterReady(child.stdout),
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          void child.stdin.write(chunk);
          void child.stdin.flush();
        },
        close: () => {
          void child.stdin.end();
        },
      }),
    }),
  );
  const context = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Layer.succeed(Socket.Socket, socket)),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  );
  return yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
});

export type Door = Effect.Success<ReturnType<typeof openBridge>>;

/**
 * A Machine's board stream, each message named by its Machine. The host's snapshot comes
 * first and says which installation it is; every change after it is that installation's.
 */
export const machineBoard = (
  name: string,
  door: Door,
): Stream.Stream<MachineMessage, MachineUnreachable> =>
  door.board().pipe(
    Stream.mapAccum(
      (): Machine => ({ installation: "", name }),
      (machine, message) => {
        const now =
          message._tag === "Snapshot"
            ? { ...machine, installation: message.installation }
            : machine;
        return [now, [{ machine: now, message }]] as const;
      },
    ),
    Stream.mapError((error) => new MachineUnreachable({ machine: name, reason: error.message })),
  );
