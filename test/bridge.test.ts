import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Layer, Option, Schema, flow, Result } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { readAudit } from "../src/audit";
import { hostRecords } from "./support/records";
import { BRIDGE_READY, FrontDoorRpcs } from "../src/board-model";
import { runDir } from "../src/engine";
import { ownerOf } from "../src/host";
import { actorName } from "../src/proposals";
import { suiteEnv } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves } from "./support/world";
import type { World } from "./support/world";

const READY = `${BRIDGE_READY}\n`;
const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);

const afterReady = (from: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let seen = "";
  let ready = false;
  return from.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array | string>({
      transform: (chunk, out) => {
        if (ready) {
          return out.enqueue(chunk);
        }
        seen += decoder.decode(chunk, { stream: true });
        const at = Option.getOrElse(pipe_(seen, Str.indexOf(READY)), () => -1);
        if (at === -1) {
          return;
        }
        ready = true;
        const rest = pipe_(seen, Str.slice(at + READY.length));
        if (rest !== "") {
          out.enqueue(rest);
        }
      },
    }),
  );
};

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
        COLLIE_ROOT: world.install,
        COLLIE_STATE_DIR: world.state,
        COLLIE_USER_DIR: world.config,
        COLLIE_HOST: asCommand(command),
        ...(yield* suiteEnv),
        HC_SOCKET: Bun.env.HC_SOCKET ?? "",
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

const environOf = (pid: number) =>
  Effect.promise(() => Bun.file(`/proc/${pid}/environ`).text()).pipe(
    Effect.map((text) => Str.split(text, "\0")),
  );

test("a bridge starts the host it pipes without the Herdr 1 socket it inherited, and every operation on it is the front door it was started as", () =>
  proves(
    "collie-bridge-",
    (world) =>
      Effect.gen(function* () {
        const legacy = { HERDR_SOCKET_PATH: `${world.home}/../herdr.sock` };
        expect(yield* ownerOf(world.state)).toBeNull();
        const desktop = yield* bridged(world, ["--as", "desktop", "--client", "mk-pc"], {
          ...legacy,
          SSH_CONNECTION: "10.1.2.3 51234 10.0.0.2 22",
        });
        expect((yield* desktop.door.declare({ frontDoor: "board" }).pipe(Effect.flip)).reason).toBe(
          "this channel is already desktop",
        );

        const host = yield* ownerOf(world.state);
        expect(host).not.toBeNull();
        const environ = yield* environOf(host!.pid);
        expect(Arr.filter(environ, Str.startsWith("HERDR_SOCKET_PATH="))).toEqual([]);
        expect(environ).toContain(`COLLIE_STATE_DIR=${world.state}`);

        const { runId } = yield* desktop.door.start({
          project: world.project,
          id: "proof",
          request: "start-1",
          input: { note: "from afar" },
        });
        yield* desktop.door.control({ runId, control: "hold", set: true, request: "hold-1" });

        const chat = yield* bridged(world, ["--as", "chat"], legacy);
        yield* chat.door.control({ runId, control: "hold", set: false, request: "unhold-1" });

        const trail = yield* hostRecords(
          world.state,
          readAudit(runDir(world.state, runId)).pipe(
            Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
          ),
        );
        expect(Arr.map(trail, (line) => [line.operation, line.actor])).toEqual([
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

        void desktop.child.stdin.end();
        expect(yield* Effect.promise(() => desktop.child.exited)).toBe(0);
        expect((yield* ownerOf(world.state))?.pid).toBe(host!.pid);
        yield* stopHost(world.state);
      }).pipe(Effect.orDie),
    ["proof.workflow.ts", "helper.ts", "notes.md"],
  ));
