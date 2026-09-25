// An installation, a project and a state directory, as an operator's machine has them.
//
// The suites that drive the real host need all three: a module is found by where it was
// saved, a Run belongs to a project, and the host that serves both owns a directory of
// its own. Building that is the same work for every one of them, so it is here.

import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { runEffect, watchedBy } from "./effect";
import { fixtures, root } from "./host";

export interface World {
  /** The installation whose user directory an author saves into. */
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly config: string;
  readonly home: string;
  readonly project: string;
}

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const Envelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.String,
        details: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
      }),
    ),
  }),
);
const asEnvelope = Schema.decodeUnknownEffect(Envelope);

/** The command itself, run as an operator runs it: another process, one JSON envelope. */
export const collie = Effect.fn("World.collie")(function* (
  world: World,
  args: ReadonlyArray<string>,
) {
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`];
  const watch = yield* watchedBy;
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: world.home,
      HERDR_PLUGIN_ROOT: world.install,
      HERDR_PLUGIN_STATE_DIR: world.state,
      HERDR_PLUGIN_CONFIG_DIR: world.config,
      COLLIE_CWD: world.project,
      // The host a client starts is this same program, as an installation's would be.
      COLLIE_HOST: asCommand(command),
      COLLIE_HOST_WATCH_PID: watch,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
  );
  return { exit, stderr, envelope: yield* asEnvelope(stdout).pipe(Effect.orDie) };
});

/** Fixture files, saved where an author saves them. */
export const save = (into: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(into, { recursive: true });
    for (const name of names) yield* fs.copyFile(`${fixtures}/${name}`, `${into}/${name}`);
  }).pipe(Effect.orDie);

/**
 * An installation with a workflow saved in it, a project to run it for, and a state
 * directory for the host that serves both. Exercised against the compiled binary when
 * `COLLIE_TEST_BINARY` names one, and the sources otherwise.
 */
export const proves = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, BunServices | Scope.Scope>,
  modules: ReadonlyArray<string>,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      const world: World = {
        install: `${dir}/install`,
        user: `${dir}/install/user/workflows`,
        state: `${dir}/state`,
        config: `${dir}/config`,
        home: `${dir}/home`,
        project: `${dir}/project`,
      };
      for (const made of [
        world.user,
        `${world.install}/workflows`,
        world.state,
        world.config,
        world.home,
        world.project,
      ]) {
        yield* fs.makeDirectory(made, { recursive: true }).pipe(Effect.orDie);
      }
      yield* save(world.user, modules);
      const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
      const command = Option.isSome(binary)
        ? [binary.value]
        : [process.execPath, `${root}src/main.ts`];
      return yield* body(world).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              HERDR_PLUGIN_CONFIG_DIR: world.config,
              HOME: world.home,
              COLLIE_CWD: world.project,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
