// An installation, a project and a state directory, as an operator's machine has them.
//
// The suites that drive the real host need all three: a module is found by where it was
// saved, a Run belongs to a project, and the host that serves both owns a directory of
// its own. Building that is the same work for every one of them, so it is here.

import { Config, ConfigProvider, Effect, FileSystem, Option, Schema, Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { exec } from "./command";
import { runEffect, suiteEnv } from "./effect";
import { fakeHerdrCommand } from "./fake-herdr-core";
import { fixtures, root, stopHost } from "./host";

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

/** `collie` as the suite runs it: the compiled binary where `COLLIE_TEST_BINARY` names one. */
export const collieCommand = Config.option(Config.String("COLLIE_TEST_BINARY")).pipe(
  Effect.map((binary) =>
    Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`],
  ),
);

/** The command itself, run as an operator runs it: another process, one JSON envelope. */
export const collie = Effect.fn("World.collie")(function* (
  world: World,
  args: ReadonlyArray<string>,
  /** More of the operator's environment, over this world's own. */
  extra: Readonly<Record<string, string>> = {},
) {
  const command = yield* collieCommand;
  const suite = yield* suiteEnv;
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: world.home,
      HERDR_PLUGIN_ROOT: world.install,
      HERDR_PLUGIN_STATE_DIR: world.state,
      COLLIE_USER_DIR: world.config,
      COLLIE_CWD: world.project,
      // The host a client starts is this same program, as an installation's would be.
      COLLIE_HOST: asCommand(command),
      ...suite,
      // The world's own herdr, which `proves` set: this env is otherwise built from nothing.
      HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH,
      FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG,
      ...extra,
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
 * The fake herdr on `HERDR_BIN_PATH`, set in the process environment too while the world
 * lasts: a host is a child that inherits it, not a reader of this world's Config.
 */
const fakeHerdrIn = Effect.fn("World.fakeHerdrIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const fake = `${root}test/support/fake-herdr.ts`;
  const bin = `${dir}/herdr`;
  yield* fs
    .writeFileString(bin, `#!/bin/sh\nexec ${fakeHerdrCommand(fake)} "$@"\n`, { mode: 0o755 })
    .pipe(Effect.orDie);
  const set = { HERDR_BIN_PATH: bin, FAKE_HERDR_LOG: `${dir}/herdr-calls.jsonl` };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = {
        HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH,
        FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG,
      };
      Object.assign(Bun.env, set);
      return before;
    }),
    (before) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(before))
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
      }),
  );
  return set;
});

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
        config: `${dir}/install/user`,
        home: `${dir}/home`,
        project: `${dir}/project`,
      };
      // Before the directory goes, or a host left running can write it back.
      yield* Effect.addFinalizer(() => Effect.ignore(stopHost(world.state)));
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
      // A project is a checkout, which is what an agent's start from inside it names.
      yield* exec(["git", "init", "-q"], { cwd: world.project });
      yield* save(world.user, modules);
      const command = yield* collieCommand;
      // A herdr of the world's own, for this process and the host it starts: the real one
      // is not on a CI runner, and on a desk it is the operator's live session.
      const herdr = yield* fakeHerdrIn(dir);
      return yield* body(world).pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              HERDR_PLUGIN_ROOT: world.install,
              HERDR_PLUGIN_STATE_DIR: world.state,
              COLLIE_USER_DIR: world.config,
              HOME: world.home,
              COLLIE_CWD: world.project,
              ...herdr,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );
