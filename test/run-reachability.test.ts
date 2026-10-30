// A Run outside the selected workspace's Task is not found by the doors that scope by Task,
// unless it is on another Machine.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { createConnection, createServer } from "node:net";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Config, Effect, FileSystem, Layer, Schema, Stream, type Scope } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { RunView } from "../src/engine";
import { BUILD, socketOf } from "../src/host";
import { relayOf } from "../src/peers";
import { RunMetrics } from "../src/run-record";
import { writeTask } from "../src/task";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { collieCommand } from "./support/world";

const ROOT = new URL("../", import.meta.url).pathname;

/** The calls `run show`, `run wait` and `run metrics` make, as a host answers them. */
const Asked = RpcGroup.make(
  Rpc.make("identity", {
    success: Schema.Struct({
      build: Schema.String,
      pid: Schema.Int,
      dir: Schema.String,
    }),
  }),
  Rpc.make("run", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunView),
  }),
  Rpc.make("shown", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(
      Schema.Struct({
        view: RunView,
        agents: Schema.Array(Schema.Never),
        disposition: Schema.Null,
        children: Schema.Array(RunView),
      }),
    ),
  }),
  Rpc.make("progress", {
    payload: { runId: Schema.String },
    success: Schema.Null,
  }),
  Rpc.make("watch", {
    payload: { runId: Schema.String },
    success: Schema.NullOr(RunView),
    stream: true,
  }),
  Rpc.make("runMetrics", {
    payload: { runId: Schema.String },
    success: RunMetrics,
  }),
);

const view = (runId: string, task: string): RunView => ({
  runId,
  workflow: "builds",
  project: "/project",
  task,
  parent: null,
  registration: "builds@1",
  entry: "/project/.collie/workflows/builds.workflow.ts",
  input: {},
  provenance: {},
  strategies: {},
  options: {},
  cwd: "/project",
  branch: null,
  workspace: null,
  worktree: null,
  outcome: "unspecified",
  created: "2026-10-15T10:00:00Z",
  status: { status: "complete", value: null },
  waiting: [],
  controls: [],
  diagnostic: null,
  parked: null,
  awaiting: null,
  mr: null,
  landing: null,
});

/** A host listening on `socket` for state directory `dir`, holding `views`; its `run` calls are counted. */
const hostOf = (socket: string, dir: string, views: ReadonlyArray<RunView>) =>
  Effect.gen(function* () {
    const asked = { run: 0 };
    const find = (runId: string) =>
      Option.getOrUndefined(Arr.findFirst(views, (one) => one.runId === runId)) ?? null;
    yield* Layer.build(
      RpcServer.layer(Asked).pipe(
        Layer.provide(
          Asked.toLayer({
            identity: () => Effect.succeed({ build: BUILD, pid: process.pid, dir }),
            run: ({ runId }) => Effect.sync(() => (asked.run++, find(runId))),
            shown: ({ runId }) =>
              Effect.succeed(
                find(runId) === null
                  ? null
                  : {
                      view: find(runId)!,
                      agents: [],
                      disposition: null,
                      children: [],
                    },
              ),
            progress: () => Effect.succeed(null),
            watch: ({ runId }) => Stream.make(find(runId)),
            runMetrics: () => Effect.succeed([]),
          }),
        ),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(BunSocketServer.layer({ path: socket })),
      ),
    );
    return asked;
  });

/** The relay to paired Machine `name`, as this Machine's host keeps it: one line said, then the peer's host. */
const relayTo = (state: string, name: string, peerSocket: string) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((conn) => {
        conn.once("data", () => {
          const peer = createConnection(peerSocket);
          conn.on("error", () => peer.end());
          peer.on("error", () => conn.destroy());
          peer.once("connect", () => {
            conn.write(`{"ok":true}\n`);
            conn.pipe(peer);
            peer.pipe(conn);
          });
        });
      });
      server.listen(relayOf(state, name), () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.sync(() => server.close()),
  );

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        details: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

const world = <A, E>(
  body: (at: {
    readonly state: string;
    readonly collie: (
      workspace: string | null,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<typeof Envelope.Type, never, PlatformServices | Scope.Scope>;
  }) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "collie-reach-",
      });
      const state = `${dir}/state`;
      yield* fs.makeDirectory(`${state}/peers`, { recursive: true });
      const command = yield* collieCommand;
      const suite = yield* suiteEnv;
      const path = yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin"));
      const collie = (workspace: string | null, args: ReadonlyArray<string>) =>
        exec([...command, "--json", ...args], {
          cwd: ROOT,
          env: {
            PATH: path,
            HOME: dir,
            HERDR_PLUGIN_ROOT: ROOT,
            HERDR_PLUGIN_STATE_DIR: state,
            COLLIE_USER_DIR: `${dir}/config`,
            HERDR_BIN_PATH: "/bin/false",
            ...suite,
            HERDR_WORKSPACE_ID: workspace ?? "",
          },
        }).pipe(
          Effect.flatMap((done) => Schema.decodeEffect(Envelope)(done.stdout)),
          Effect.orDie,
        );
      return yield* body({ state, collie });
    }).pipe(Effect.scoped),
  );

const task = (id: string, workspace: string) =>
  ({
    id,
    workspace,
    label: id,
    cwd: "/project",
    created_at: "2026-10-15T10:00:00Z",
  }) as const;

test(
  "show, wait and metrics do not find a Run of another Task than the selected one, unless it is on another Machine",
  () =>
    world(({ state, collie }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeTask(state, task("task-a", "ws-a"));
        yield* writeTask(state, task("task-b", "ws-b"));
        yield* fs.writeFileString(`${state}/host.db`, "");
        const here = yield* hostOf(socketOf(state), state, [view("in-b", "task-b")]);
        const peerSocket = `${state}/m2-host.sock`;
        yield* hostOf(peerSocket, "/m2", [view("away", "task-b")]);
        yield* fs.writeFileString(
          `${state}/peers.json`,
          `[{"installation":"m2","name":"m2","dials":"out","secret":"s"}]`,
        );
        yield* relayTo(state, "m2", peerSocket);

        const doors = [
          ["run", "show"],
          ["run", "wait"],
          ["run", "metrics"],
        ] as const;
        const asked = (door: (typeof doors)[number], workspace: string | null, run = "in-b") =>
          collie(
            workspace,
            run === "away" ? ["--machine", "m2", ...door, run] : [...door, run],
          ).pipe(Effect.map((said) => ({ door, workspace, run, said })));
        const answers = yield* Effect.all(
          Arr.flatMap(doors, (door) => [
            asked(door, "ws-a"),
            asked(door, null),
            asked(door, "ws-b"),
            asked(door, "ws-a", "away"),
          ]),
          { concurrency: "unbounded" },
        );
        for (const { door, workspace, run, said } of answers)
          expect({ door, workspace, run, said }).toEqual({
            door,
            workspace,
            run,
            said:
              workspace === "ws-a" && run === "in-b"
                ? {
                    ok: false,
                    error: {
                      code: "run_not_found",
                      message: `Run "in-b" is not part of task "task-a".`,
                      details: { run: "in-b", task: "task-a" },
                    },
                  }
                : { ok: true },
          });

        here.run = 0;
        yield* collie("ws-b", ["run", "show", "in-b"]);
        expect(here.run).toBe(2);
        here.run = 0;
        yield* collie("ws-b", ["run", "wait", "in-b"]);
        expect(here.run).toBe(2);
      }),
    ),
  60_000,
);
