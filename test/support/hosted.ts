// A Herd with a host in it: the installation, the state directory the host owns, and the
// Runs chat reads and acts on, which are the host's.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Crypto, Effect, FileSystem, type Scope } from "effect";
import { readEnv, type PluginEnv } from "../../src/env";
import { resetExecutors } from "../../src/executors";
import { connect } from "../../src/host";
import { seedIntent, writeIntent, type Authority } from "../../src/intent";
import { runDir } from "../../src/engine";
import { isSettled } from "../../src/lifecycle";
import { stopHost, until } from "./host";
import { proves, type World } from "./world";

/** A Run that waits to be answered, and ones that end as soon as they start. */
export const MODULES = [
  "proof.workflow.ts",
  "helper.ts",
  "notes.md",
  "hello.workflow.ts",
  "retains.workflow.ts",
];

/**
 * One test, in an installation of its own whose host is stopped when it ends. Executors
 * register once per process and close over the registering caller's state directory, so
 * the registry is emptied for every test — otherwise a confirmation runs against another
 * test's Runs.
 */
export const hosted = <A, E>(
  prefix: string,
  body: (herd: { world: World; env: PluginEnv }) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        resetExecutors();
        const env = readEnv({
          HERDR_PLUGIN_ROOT: world.install,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HERDR_SOCKET_PATH: `${world.state}/herd.sock`,
          HOME: world.home,
          COLLIE_CWD: world.project,
        });
        return yield* body({ world, env }).pipe(Effect.ensuring(stopHost(world.state)));
      }),
    MODULES,
  );

/** A Run the host is holding, waiting on its decision, with an Intent to read and amend. */
export const hostedRun = Effect.fn("test.hostedRun")(function* (
  world: World,
  goal: string,
  authority?: Authority,
) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const started = yield* client
    .start({ project: world.project, id: "proof", request, input: { note: goal } })
    .pipe(Effect.orDie);
  // Where it waits: every test starts from a Run that is asking.
  yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (view) => (view?.waiting.length ?? 0) > 0,
  );
  const dir = runDir(world.state, started.runId);
  yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
  const intent = seedIntent(started.runId, { goal });
  yield* writeIntent(dir, authority === undefined ? intent : { ...intent, authority });
  return { id: started.runId, dir };
});

/** A Run the host no longer holds: `hello` succeeds and `retains` fails, as soon as they start. */
export const settledRun = Effect.fn("test.settledRun")(function* (
  world: World,
  workflow: "hello" | "retains",
  options?: Readonly<Record<string, string>>,
) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const request = yield* (yield* Crypto.Crypto).randomUUIDv4;
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
