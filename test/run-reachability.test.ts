// A Run outside the selected workspace's Task is refused by the doors that scope by Task, naming
// where it is, unless it is on another Machine or the caller's Run started or was asked about it.

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
import { recordAudit } from "../src/audit";
import { writeTask } from "../src/task";
import { seedIntent, writeIntent } from "../src/intent";
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
  Rpc.make("agentRun", {
    payload: { agent: Schema.String },
    success: Schema.NullOr(Schema.String),
  }),
);

const view = (runId: string, task: string, more: Partial<RunView> = {}): RunView => ({
  ...more,
  runId,
  workflow: "builds",
  project: "/project",
  task,
  parent: more.parent ?? null,
  registration: "builds@1",
  entry: "/project/.collie/workflows/builds.workflow.ts",
  input: more.input ?? {},
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

const hostOf = (
  socket: string,
  dir: string,
  views: ReadonlyArray<RunView>,
  agents: Readonly<Record<string, string>> = {},
) =>
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
            agentRun: ({ agent }) => Effect.succeed(agents[agent] ?? null),
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

const Shown = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Struct({ run: Schema.Struct({ runId: Schema.String }) }),
  }),
);

const world = <A, E>(
  body: (at: {
    readonly state: string;
    readonly collie: (
      workspace: string | null,
      args: ReadonlyArray<string>,
      caller?: string,
      more?: Readonly<Record<string, string>>,
    ) => Effect.Effect<typeof Envelope.Type, never, PlatformServices | Scope.Scope>;
    readonly shownRun: (
      workspace: string,
      run: string,
      caller: string,
    ) => Effect.Effect<string, never, PlatformServices | Scope.Scope>;
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
      const said = (
        workspace: string | null,
        args: ReadonlyArray<string>,
        caller?: string,
        more: Readonly<Record<string, string>> = {},
      ) =>
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
            COLLIE_RUN: caller ?? "",
            ...more,
          },
        }).pipe(Effect.map((done) => done.stdout));
      const collie = (
        workspace: string | null,
        args: ReadonlyArray<string>,
        caller?: string,
        more?: Readonly<Record<string, string>>,
      ) =>
        said(workspace, args, caller, more).pipe(
          Effect.flatMap(Schema.decodeEffect(Envelope)),
          Effect.orDie,
        );
      const shownRun = (workspace: string, run: string, caller: string) =>
        said(workspace, ["run", "show", run], caller).pipe(
          Effect.flatMap(Schema.decodeEffect(Shown)),
          Effect.map((shown) => shown.data.run.runId),
          Effect.orDie,
        );
      return yield* body({ state, collie, shownRun });
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
  "show, wait and metrics refuse a Run of another Task than the selected one, naming its Task and workspace, unless it is on another Machine",
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
                      code: "run_outside_task",
                      message: `Run "in-b" is in task "task-b", not task "task-a": \`--workspace ws-b\` reaches it.`,
                      details: { run: "in-b", task: "task-b", workspace: "ws-b" },
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

test(
  "an agent reaches a Run of another Task its Run started or was asked about, and is told where any other one is",
  () =>
    world(({ state, collie, shownRun }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const one of ["a", "b", "c", "d", "e", "f", "p"])
          yield* writeTask(state, task(`task-${one}`, `ws-${one}`));
        yield* fs.writeFileString(`${state}/host.db`, "");
        const here = yield* hostOf(socketOf(state), state, [
          view("run-a", "task-a", { input: { goal: "Find out why run-c failed" } }),
          view("run-b", "task-b", {
            requestedBy: {
              run: "run-a",
              agent: "run-a-agent",
              machine: { installation: "here", name: "here" },
            },
          }),
          view("run-p", "task-p", { parent: "run-a" }),
          view("run-c", "task-c"),
          view("run-d", "task-d"),
          view("run-e", "task-e"),
          view("run-f", "task-f"),
        ]);
        // A goal given with --goal, or amended since, is in the Run's Intent, not its input.
        yield* fs.makeDirectory(`${state}/runs/run-a`, { recursive: true });
        yield* writeIntent(
          `${state}/runs/run-a`,
          seedIntent("run-a", { goal: "Find out why run-c and run-f failed" }),
        );
        yield* recordAudit(`${state}/runs/run-a`, {
          operation: "deliver",
          request: "steer-1",
          origin: "agent",
          asked: { text: "Compare it with run-d", operation: null, agent: null, mode: null },
          result: Schema.Struct({}),
          value: {},
        });

        const doors = [
          ["run", "show"],
          ["run", "wait"],
          ["run", "metrics"],
        ] as const;
        const answers = yield* Effect.all(
          Arr.flatMap(doors, (door) =>
            Arr.map(["run-b", "run-p", "run-c", "run-d", "run-e", "run-f", "run-none"], (run) =>
              collie("ws-a", [...door, run], "run-a").pipe(
                Effect.map((said) => ({ door, run, said })),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        for (const { door, run, said } of answers)
          expect({ door, run, said }).toEqual({
            door,
            run,
            said:
              run === "run-e"
                ? {
                    ok: false,
                    error: {
                      code: "run_outside_task",
                      message: `Run "run-e" is in task "task-e", not task "task-a": \`--workspace ws-e\` reaches it.`,
                      details: { run: "run-e", task: "task-e", workspace: "ws-e" },
                    },
                  }
                : run === "run-none"
                  ? {
                      ok: false,
                      error: expect.objectContaining({ code: "run_not_found" }),
                    }
                  : { ok: true },
          });

        expect(yield* shownRun("ws-a", "run-b", "run-a")).toBe("run-b");
        expect(yield* shownRun("ws-e", "run-e", "run-a")).toBe("run-e");
        const runCalls = (caller?: string) =>
          Effect.sync(() => (here.run = 0)).pipe(
            Effect.andThen(collie("ws-a", ["run", "show", "run-e"], caller)),
            Effect.map(() => here.run),
          );
        expect(yield* runCalls("run-a")).toBe((yield* runCalls()) + 1);
      }),
    ),
  60_000,
);

test(
  "an agent known by its pane or COLLIE_AGENT, with no COLLIE_RUN, reaches a Run its Run started and no other Task's",
  () =>
    world(({ state, collie }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const one of ["a", "b", "e"])
          yield* writeTask(state, task(`task-${one}`, `ws-${one}`));
        yield* fs.writeFileString(`${state}/host.db`, "");
        yield* hostOf(
          socketOf(state),
          state,
          [
            view("run-a", "task-a"),
            view("run-b", "task-b", {
              requestedBy: {
                run: "run-a",
                agent: "run-a-agent",
                machine: { installation: "here", name: "here" },
              },
            }),
            view("run-e", "task-e"),
          ],
          { "run-a-agent": "run-a" },
        );
        const herdr = `${state}/herdr`;
        yield* fs.writeFileString(
          herdr,
          `#!/bin/sh\necho '{"result":{"agents":[{"name":"run-a-agent","pane_id":"pane-a","agent_status":"idle"}]}}'\n`,
        );
        yield* fs.chmod(herdr, 0o755);
        const shells = {
          pane: { HERDR_BIN_PATH: herdr, HERDR_PANE_ID: "pane-a", COLLIE_AGENT: "" },
          core: { HERDR_PANE_ID: "", COLLIE_AGENT: "run-a-agent" },
        } as const;

        const answers = yield* Effect.all(
          Arr.flatMap(["pane", "core"] as const, (shell) =>
            Arr.flatMap([["run", "show"] as const, ["run", "wait"] as const], (door) =>
              Arr.map(["run-b", "run-e"], (run) =>
                collie("ws-a", [...door, run], undefined, shells[shell]).pipe(
                  Effect.map((said) => ({ shell, door, run, said })),
                ),
              ),
            ),
          ),
          { concurrency: "unbounded" },
        );
        for (const { shell, door, run, said } of answers)
          expect({ shell, door, run, said }).toEqual({
            shell,
            door,
            run,
            said:
              run === "run-e"
                ? {
                    ok: false,
                    error: {
                      code: "run_outside_task",
                      message: `Run "run-e" is in task "task-e", not task "task-a": \`--workspace ws-e\` reaches it.`,
                      details: { run: "run-e", task: "task-e", workspace: "ws-e" },
                    },
                  }
                : { ok: true },
          });
      }),
    ),
  60_000,
);
