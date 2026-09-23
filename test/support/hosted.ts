// A Herd with a host in it: the installation, the state directory the host owns, and the
// Runs chat reads and acts on, which are the host's.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Crypto, Effect, FileSystem, type Scope } from "effect";
import { readEnv, type PluginEnv } from "../../src/env";
import { resetExecutors } from "../../src/executors";
import { connect } from "../../src/host";
import { seedIntent, writeIntent, type Authority } from "../../src/intent";
import { runDir } from "../../src/native";
import { stopHost, until } from "./native";
import { proves, type World } from "./world";

/** The fixture a hosted Run is started from: it records one launch and waits to be answered. */
const MODULES = ["proof.workflow.ts", "helper.ts", "notes.md"];

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
          HERDR_PLUGIN_CONFIG_DIR: world.config,
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
