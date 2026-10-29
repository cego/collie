// A question about one Run asks the host for that Run, and an answer lists every Run at most once.

import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { OfferView } from "../src/board-model";
import { RunView } from "../src/engine";
import { readEnv } from "../src/env";
import { BUILD, socketOf } from "../src/host";
import { factsOfView, findRun } from "../src/runs";
import { toolNamed } from "../src/tools";
import { runEffect } from "./support/effect";

const ROOT = new URL("../", import.meta.url).pathname;

/** The few calls these answers make, as a host answers them. */
const Asked = RpcGroup.make(
  Rpc.make("identity", {
    success: Schema.Struct({ build: Schema.String, pid: Schema.Int, dir: Schema.String }),
  }),
  Rpc.make("run", { payload: { runId: Schema.String }, success: Schema.NullOr(RunView) }),
  Rpc.make("runs", {
    payload: { task: Schema.NullOr(Schema.String) },
    success: Schema.Array(RunView),
  }),
  Rpc.make("progress", { payload: { runId: Schema.String }, success: Schema.Null }),
  Rpc.make("offers", { payload: { runId: Schema.String }, success: Schema.Array(OfferView) }),
  Rpc.make("shown", { payload: { runId: Schema.String }, success: Schema.Null }),
);

const view = (runId: string, parent: string | null = null): RunView => ({
  runId,
  workflow: "builds",
  project: "/project",
  task: null,
  parent,
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

/** A host in `dir` answering as `build`, holding `views`, with each call it is asked counted. */
const hostOf = (dir: string, views: ReadonlyArray<RunView>, build = BUILD) =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    const count = (rpc: string) => Effect.sync(() => asked.push(rpc));
    yield* (yield* FileSystem.FileSystem).writeFileString(`${dir}/host.db`, "");
    yield* Layer.build(
      RpcServer.layer(Asked).pipe(
        Layer.provide(
          Asked.toLayer({
            identity: () => Effect.succeed({ build, pid: process.pid, dir }),
            run: ({ runId }) =>
              count("run").pipe(Effect.as(views.find((one) => one.runId === runId) ?? null)),
            runs: () => count("runs").pipe(Effect.as(views)),
            progress: () => Effect.succeed(null),
            offers: () => Effect.succeed([]),
            shown: () => Effect.succeed(null),
          }),
        ),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(BunSocketServer.layer({ path: socketOf(dir) })),
      ),
    );
    return asked;
  });

const inDir = <A, E>(
  body: (
    env: ReturnType<typeof readEnv>,
    dir: string,
  ) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
) =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-lookup-",
      });
      const env = readEnv({
        HERDR_PLUGIN_ROOT: ROOT,
        HERDR_PLUGIN_STATE_DIR: dir,
        COLLIE_USER_DIR: `${dir}/user`,
        HOME: dir,
      });
      return yield* body(env, dir);
    }).pipe(Effect.scoped),
  );

test("finding one Run asks the host for that Run and never lists them all", () =>
  inDir((env, dir) =>
    Effect.gen(function* () {
      const asked = yield* hostOf(dir, [view("r1"), view("r2")]);
      expect(yield* findRun(env, "r2")).toEqual(factsOfView(dir, view("r2")));
      expect(yield* findRun(env, "nope")).toBeNull();
      expect(asked).toEqual(["run", "run"]);
    }),
  ));

test("a host that cannot be read finds no Run", () =>
  inDir((env, dir) =>
    Effect.gen(function* () {
      yield* hostOf(dir, [view("r1")], "999.0.0");
      expect(yield* findRun(env, "r1")).toBeNull();
    }),
  ));

test("collie_run about a Run that started others lists the Runs once, and still names them", () =>
  inDir((env, dir) =>
    Effect.gen(function* () {
      const asked = yield* hostOf(dir, [view("parent"), view("child", "parent")]);
      const said = yield* Effect.suspend(() =>
        toolNamed("collie_run")!.call(env, { run: "parent" }),
      );
      expect(said).toContain("Runs it started");
      expect(said).toContain("child");
      expect(asked.filter((one) => one === "runs")).toHaveLength(1);
    }),
  ));
