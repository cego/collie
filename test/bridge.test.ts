// The bridge: a front door on another computer reaches this Machine's host through one
// command's stdio, started as the front door it is, and starts that host when none runs.

import { expect, test } from "bun:test";
import { Config, Effect, Layer, Option, Schema } from "effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { readAudit } from "../src/audit";
import { FrontDoorRpcs } from "../src/board-model";
import { runDir } from "../src/engine";
import { ownerOf } from "../src/host";
import { actorName } from "../src/proposals";
import { watchedBy } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves, type World } from "./support/world";

const READY = "collie-bridge-ready\n";
const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Everything after the ready marker, whatever a login shell printed before it. */
const afterReady = (from: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let seen = "";
  let ready = false;
  return from.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array | string>({
      transform: (chunk, out) => {
        if (ready) return out.enqueue(chunk);
        seen += decoder.decode(chunk, { stream: true });
        const at = seen.indexOf(READY);
        if (at === -1) return;
        ready = true;
        const rest = seen.slice(at + READY.length);
        if (rest !== "") out.enqueue(rest);
      },
    }),
  );
};

/** A bridge started as a login shell over SSH would, and a front door over its stdio. */
const bridged = Effect.fn("BridgeTest.bridged")(function* (
  world: World,
  args: ReadonlyArray<string>,
  extra: Readonly<Record<string, string>> = {},
) {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const child = Bun.spawn(
    ["sh", "-c", 'echo "Welcome to vm-mk"; exec "$@"', "sh", ...command, "bridge", ...args],
    {
      cwd: world.home,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: world.home,
        HERDR_PLUGIN_ROOT: world.install,
        HERDR_PLUGIN_STATE_DIR: world.state,
        COLLIE_USER_DIR: world.config,
        COLLIE_HOST: asCommand(command),
        COLLIE_HOST_WATCH_PID: yield* watchedBy,
        HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH,
        FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG,
        ...extra,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
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
  const door = yield* RpcClient.make(FrontDoorRpcs).pipe(Effect.provideContext(context));
  return { door, child };
});

/** The environment the process owning this directory was started with. */
const environOf = (pid: number) =>
  Effect.promise(() => Bun.file(`/proc/${pid}/environ`).text()).pipe(
    Effect.map((text) => text.split("\0")),
  );

test(
  "a bridge starts the host it pipes, and every operation on it is the front door it was started as",
  () =>
    proves(
      "collie-bridge-",
      (world) =>
        Effect.gen(function* () {
          const session = `${world.home}/herdr.sock`;
          expect(yield* ownerOf(world.state)).toBeNull();
          const desktop = yield* bridged(world, ["--as", "desktop", "--client", "mk-pc"], {
            FAKE_HERDR_STATUS_SOCKET: session,
            SSH_CONNECTION: "10.1.2.3 51234 10.0.0.2 22",
          });
          // The channel is what it was started as, whatever the front door says next.
          expect(
            (yield* desktop.door.declare({ frontDoor: "board" }).pipe(Effect.flip)).reason,
          ).toBe("this channel is already desktop");

          const host = yield* ownerOf(world.state);
          expect(host).not.toBeNull();
          const environ = yield* environOf(host!.pid);
          expect(environ).toContain(`HERDR_SOCKET_PATH=${session}`);
          expect(environ).toContain(`HERDR_PLUGIN_STATE_DIR=${world.state}`);

          const { runId } = yield* desktop.door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "from afar" },
          });
          yield* desktop.door.control({ runId, control: "hold", set: true, request: "hold-1" });

          const chat = yield* bridged(world, ["--as", "chat"], {
            FAKE_HERDR_STATUS_SOCKET: session,
          });
          yield* chat.door.control({ runId, control: "hold", set: false, request: "unhold-1" });

          const trail = yield* readAudit(runDir(world.state, runId));
          expect(trail.map((line) => [line.operation, line.actor])).toEqual([
            [
              "start",
              {
                origin: "desktop",
                requestId: "start-1",
                from: { client: "mk-pc", ssh: "10.1.2.3" },
              },
            ],
            [
              "hold",
              {
                origin: "desktop",
                requestId: "hold-1",
                from: { client: "mk-pc", ssh: "10.1.2.3" },
              },
            ],
            ["unhold", { origin: "chat", requestId: "unhold-1" }],
          ]);
          expect(actorName({ origin: "desktop", requestId: "hold-1" })).toBe("human:hold-1");

          // A front door that hangs up ends its bridge, and leaves the host it reached alone.
          void desktop.child.stdin.end();
          expect(yield* Effect.promise(() => desktop.child.exited)).toBe(0);
          expect((yield* ownerOf(world.state))?.pid).toBe(host!.pid);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);
