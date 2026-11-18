import * as Cause from "effect/Cause";

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import solidPlugin from "@opentui/solid/bun-plugin";
import manifest from "../../package.json";
import type { PlatformServices } from "../../src/platform";
import { Config, Effect, FileSystem, Schema, type Scope, flow, Result } from "effect";
import { exec } from "./command";
import { suiteEnv } from "./effect";
import { armTripwire, untripped } from "./herdr-tripwire";
import { type FakeHc, serveFakeHc } from "./fake-hc";
import { type FakeSsh, writeFakeSsh, socketDir } from "./fake-ssh";
import { fixtures, root, stopHost } from "./host";
import { peersOf } from "../../src/peers";
import { collie, collieCommand, type World } from "./world";

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

export interface Side {
  readonly name: string;
  readonly world: World;
  readonly env: Readonly<Record<string, string>>;
  readonly sshLog: string;
  readonly ssh: FakeSsh;
  readonly cli: (
    args: ReadonlyArray<string>,
    extra?: Readonly<Record<string, string>>,
  ) => ReturnType<typeof collie>;
  readonly lists: (machines: ReadonlyArray<Side>) => Effect.Effect<void>;
  readonly core: FakeHc;
  readonly coreLog: string;
}

export const listenerPort = (dialler: Side, listener: Side) =>
  Effect.gen(function* () {
    const paired = Option.getOrUndefined(
      Arr.findFirst(yield* peersOf(dialler.world.state), (peer) => peer.name === listener.name),
    );
    if (paired?.url === undefined)
      return yield* Effect.die(new Error(`${dialler.name} has no url for ${listener.name}`));
    return new URL(paired.url).port;
  });

export const twoMachines = <A, E>(
  prefix: string,
  body: (first: Side, second: Side) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  modules: ReadonlyArray<string>,
  options: {
    readonly ports?: Readonly<Record<string, number>>;
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
        const shell = `${bin}/login-shell`;
        yield* fs.writeFileString(
          shell,
          '#!/bin/sh\ncase "$1" in -lc|-ilc|-c) shift;; *) exit 64;; esac\nexec /bin/sh -c "$@"\n',
          { mode: 0o755 },
        );
        const tripwire = yield* armTripwire(dir);
        yield* Effect.addFinalizer(() => untripped(tripwire).pipe(Effect.ensuring(tripwire.stop)));
        yield* fs.writeFileString(
          `${bin}/claude`,
          `#!/bin/sh\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
          { mode: 0o755 },
        );
        for (const harness of ["codex", "pi", "opencode"])
          yield* fs.writeFileString(`${bin}/${harness}`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        yield* fs.writeFileString(
          `${bin}/collie`,
          `#!/bin/sh\nexec ${Arr.join(
            Arr.map(command, (part) => `'${part}'`),
            " ",
          )} "$@"\n`,
          { mode: 0o755 },
        );
        const coreLog = `${dir}/core-calls.jsonl`;
        const env = {
          PATH: `${bin}:${tripwire.binDir}:/usr/bin:/bin`,
          SHELL: shell,
          HOME: world.home,
          COLLIE_ROOT: world.install,
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          COLLIE_CWD: world.project,
          COLLIE_HOST: asCommand(command),
          COLLIE_PEER_PORT: String(options.ports?.[name] ?? 0),
          ...suite,
          HC_SOCKET: `${dir}/hc.sock`,
        };
        yield* fs.writeFileString(coreLog, "");
        const core = yield* serveFakeHc(
          `${dir}/hc.sock`,
          coreLog,
          yield* Effect.scope,
          `${world.home}/outputs.json`,
          {
            PATH: env.PATH,
          },
        );
        const sshDir = `${dir}/ssh`;
        yield* fs.makeDirectory(sshDir);
        const side: (ssh: FakeSsh) => Side = (ssh) => ({
          name,
          world,
          env,
          coreLog,
          core,
          sshLog: ssh.log,
          ssh,
          cli: (args, extra = {}) => collie(world, args, { ...env, ...extra }),
          lists: (machines) =>
            Effect.sync(() =>
              core.roster(
                Arr.map(machines, (one) => ({ name: one.name, target: `mk@${one.name}` })),
              ),
            ),
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
    const unused = yield* writeFakeSsh(`${second.sshDir}/ssh`, second.sshDir);
    return yield* body(first.side(toSecond), second.side(unused));
  }).pipe(Effect.orDie);

export const releaseBinary = Effect.fn("PeerTest.releaseBinary")(function* (
  file: string,
  version: string,
) {
  const musl = (yield* Config.String("OPENTUI_LIBC").pipe(Config.withDefault(""))) === "musl";
  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [`${root}src/main.ts`, `${root}src/door.ts`],
      target: "bun",
      define: { "process.env.OPENTUI_LIBC": musl ? '"musl"' : '"glibc"' },
      bytecode: true,
      format: "esm",
      plugins: [
        solidPlugin,
        {
          name: "peer-release",
          setup(builder) {
            builder.onLoad({ filter: /\/package\.json$/ }, (args) => {
              if (args.path !== `${root}package.json`) return undefined;
              return { loader: "json", contents: encode({ ...manifest, version }) };
            });
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
