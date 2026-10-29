import * as Cause from "effect/Cause";
// Two Machines on one computer, as a pairing test needs them: two installations, each with
// its state directory, its own fake herdr and its own `collie`, and the fake `ssh` on the
// first's PATH, whose sessions run as a login on the second would and whose forwards reach
// the second's loopback. Nothing above the
// sockets is faked: both hosts are the shipped `collie host`, started by the CLI as an
// installation's are, and the link between them is the real listener on 127.0.0.1.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import solidPlugin from "@opentui/solid/bun-plugin";
import type { PlatformServices } from "../../src/platform";
import { Effect, FileSystem, Schema, type Scope, flow, Result } from "effect";
import { exec } from "./command";
import { suiteEnv } from "./effect";
import { writeFakeHerdrShim } from "./fake-herdr-core";
import { type FakeSsh, writeFakeSsh, socketDir } from "./fake-ssh";
import { fixtures, root, stopHost } from "./host";
import { peersOf } from "../../src/peers";
import { collie, collieCommand, type World } from "./world";

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

/** One Machine of the pair. */
export interface Side {
  readonly name: string;
  readonly world: World;
  /** Everything a process of this Machine is started with. */
  readonly env: Readonly<Record<string, string>>;
  /** Every call its fake herdr answered. */
  readonly herdrLog: string;
  /** Every command its fake `ssh` was asked to run. */
  readonly sshLog: string;
  /** The first's fake `ssh`, which reaches the second Machine. */
  readonly ssh: FakeSsh;
  /** `collie --json …` on this Machine, as an operator types it there. */
  readonly cli: (
    args: ReadonlyArray<string>,
    extra?: Readonly<Record<string, string>>,
  ) => ReturnType<typeof collie>;
  /** Says which of herdr's machines this Machine's herdr lists. */
  readonly lists: (machines: ReadonlyArray<Side>) => Effect.Effect<void>;
}

/** The port `listener`'s host answered `dialler`'s invitation with. */
export const listenerPort = (dialler: Side, listener: Side) =>
  Effect.gen(function* () {
    const paired = Option.getOrUndefined(
      Arr.findFirst(yield* peersOf(dialler.world.state), (peer) => peer.name === listener.name),
    );
    if (paired?.url === undefined)
      return yield* Effect.die(new Error(`${dialler.name} has no url for ${listener.name}`));
    return new URL(paired.url).port;
  });

const machineOf = (side: Side) => ({
  id: side.name,
  label: side.name,
  target: `mk@${side.name}`,
  session: "default",
  enabled: true,
});

/**
 * Two Machines named `first` and `second`, with `modules` saved in each. The first's
 * `ssh` reaches the second; neither lists the other in herdr until a test says so.
 */
export const twoMachines = <A, E>(
  prefix: string,
  body: (first: Side, second: Side) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  modules: ReadonlyArray<string>,
  options: {
    /** Each Machine's `COLLIE_PEER_PORT`, by name; 0, where its listener binds what is free. */
    readonly ports?: Readonly<Record<string, number>>;
    /** Runs before any host starts, with the `COLLIE_PEER_PORT` each Machine was given. */
    readonly before?: (
      ports: Readonly<Record<string, string>>,
    ) => Effect.Effect<void, never, PlatformServices | Scope.Scope>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const command = yield* collieCommand;
    const suite = yield* suiteEnv;
    const make = (name: string) =>
      Effect.gen(function* () {
        const dir = yield* socketDir(`${pipe(prefix, Str.slice(0, 12))}${name}-`);
        const world: World = {
          install: `${dir}/install`,
          user: `${dir}/install/user/workflows`,
          state: `${dir}/state`,
          config: `${dir}/install/user`,
          home: `${dir}/home`,
          project: `${dir}/project`,
        };
        yield* Effect.addFinalizer(() => Effect.ignore(stopHost(world.state)));
        for (const made of [world.user, `${world.install}/workflows`, world.state, world.home])
          yield* fs.makeDirectory(made, { recursive: true });
        yield* fs.makeDirectory(world.project, { recursive: true });
        yield* exec(["git", "init", "-q"], { cwd: world.project });
        for (const module of modules)
          yield* fs.copyFile(`${fixtures}/${module}`, `${world.user}/${module}`);
        const bin = `${dir}/bin`;
        yield* fs.makeDirectory(bin);
        const herdr = `${bin}/herdr`;
        yield* writeFakeHerdrShim(herdr);
        yield* fs.writeFileString(
          `${bin}/collie`,
          `#!/bin/sh\nexec ${Arr.join(
            Arr.map(command, (part) => `'${part}'`),
            " ",
          )} "$@"\n`,
          { mode: 0o755 },
        );
        const herdrLog = `${dir}/herdr-calls.jsonl`;
        const env = {
          PATH: `${bin}:/usr/bin:/bin`,
          SHELL: "/bin/sh",
          HOME: world.home,
          HERDR_PLUGIN_ROOT: world.install,
          HERDR_PLUGIN_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          COLLIE_CWD: world.project,
          COLLIE_HOST: asCommand(command),
          COLLIE_PEER_PORT: String(options.ports?.[name] ?? 0),
          HERDR_BIN_PATH: herdr,
          FAKE_HERDR_LOG: herdrLog,
          ...suite,
        };
        const sshDir = `${dir}/ssh`;
        yield* fs.makeDirectory(sshDir);
        const side = (ssh: FakeSsh): Side => ({
          name,
          world,
          env,
          herdrLog,
          sshLog: ssh.log,
          ssh,
          cli: (args, extra = {}) => collie(world, args, { ...env, ...extra }),
          lists: (machines) =>
            fs
              .writeFileString(`${herdrLog}.machines.json`, encode(Arr.map(machines, machineOf)))
              .pipe(Effect.orDie),
        });
        return { side, bin, sshDir, env };
      });
    const first = yield* make("first");
    const second = yield* make("second");
    yield* (options.before ?? (() => Effect.void))({
      first: first.env.COLLIE_PEER_PORT,
      second: second.env.COLLIE_PEER_PORT,
    });
    const toSecond = yield* writeFakeSsh(`${first.bin}/ssh`, first.sshDir, second.env);
    // Off the second's PATH: only the first reaches the other over SSH.
    const unused = yield* writeFakeSsh(`${second.sshDir}/ssh`, second.sshDir);
    return yield* body(first.side(toSecond), second.side(unused));
  }).pipe(Effect.orDie);

export const releaseBinary = Effect.fn("PeerTest.releaseBinary")(function* (
  file: string,
  version: string,
) {
  const manifest = yield* (yield* FileSystem.FileSystem).readFileString(`${root}herdr-plugin.toml`);
  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [`${root}src/main.ts`],
      target: "bun",
      bytecode: true,
      format: "esm",
      plugins: [
        solidPlugin,
        {
          name: "peer-release",
          setup(builder) {
            builder.onLoad({ filter: /herdr-plugin\.toml$/ }, () => ({
              loader: "toml",
              contents: pipe(manifest, Str.replace(/^version = ".*"/m, `version = "${version}"`)),
            }));
          },
        },
      ],
      compile: { outfile: file },
    }),
  );
  if (!built.success)
    return yield* new Cause.UnknownError(
      built.logs,
      `could not build ${version}: ${Arr.join(
        Arr.map(built.logs, (part) =>
          part === null || part === undefined ? "" : globalThis.String(part),
        ),
        "\n",
      )}`,
    );
});
