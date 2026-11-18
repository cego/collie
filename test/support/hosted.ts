import type { PlatformServices } from "../../src/platform";
import { Effect, FileSystem, type Scope } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { readEnv, type PluginEnv } from "../../src/env";
import { resetExecutors } from "../../src/executors";
import { connect } from "../../src/host";
import { seedIntent, writeIntent, type Authority } from "../../src/intent";
import { runDir } from "../../src/engine";
import { isSettled } from "../../src/lifecycle";
import { stopHost, until } from "./host";
import { overHost } from "./records";
import { proves, type World } from "./world";
import type { FakeHc } from "./fake-hc";

export const MODULES = [
  "proof.workflow.ts",
  "helper.ts",
  "notes.md",
  "hello.workflow.ts",
  "retains.workflow.ts",
];

export const hosted = <A, E>(
  prefix: string,
  body: (herd: {
    world: World;
    env: PluginEnv;
    core: FakeHc;
  }) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  modules: ReadonlyArray<string> = MODULES,
) =>
  proves(
    prefix,
    (world, core) =>
      Effect.gen(function* () {
        resetExecutors();
        const env = readEnv({
          COLLIE_ROOT: world.install,
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HC_SOCKET: core.socketPath,
          HOME: world.home,
          COLLIE_CWD: world.project,
        });
        return yield* body({ world, env, core }).pipe(Effect.ensuring(stopHost(world.state)));
      }),
    modules,
  );

export const hostedRun = Effect.fn("test.hostedRun")(function* (
  world: World,
  goal: string,
  authority?: Authority,
) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const started = yield* client
    .start({ project: world.project, id: "proof", request, input: { note: goal } })
    .pipe(Effect.orDie);
  yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (view) => (view?.waiting.length ?? 0) > 0,
  );
  const dir = runDir(world.state, started.runId);
  yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  const intent = seedIntent(started.runId, { goal });
  yield* writeIntent(dir, authority === undefined ? intent : { ...intent, authority }).pipe(
    overHost(() => world.state),
  );
  return { id: started.runId, dir };
});

export const settledRun = Effect.fn("test.settledRun")(function* (
  world: World,
  workflow: "hello" | "retains",
  options?: Readonly<Record<string, string>>,
) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
  const input = workflow === "hello" ? { name: "picker" } : { note: "picker" };
  const started = yield* client
    .start({ project: world.project, id: workflow, request, input, options })
    .pipe(Effect.orDie);
  yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (view) => view !== null && isSettled(view),
  );
  const dir = runDir(world.state, started.runId);
  yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  return { id: started.runId, dir };
});
