// Two Machines on one computer, as a pairing test needs them: two installations, each with
// its state directory, its own fake herdr and its own `collie`, and a fake `ssh` on the
// first's PATH that runs a command as a login on the second would. Nothing above the
// sockets is faked: both hosts are the shipped `collie host`, started by the CLI as an
// installation's are, and the link between them is the real listener on 127.0.0.1.

import solidPlugin from "@opentui/solid/bun-plugin";
import { createServer } from "node:net";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Schema, type Scope } from "effect";
import { exec } from "./command";
import { suiteEnv } from "./effect";
import { writeFakeHerdrShim } from "./fake-herdr-core";
import { fixtures, root, stopHost } from "./host";
import { collie, collieCommand, type World } from "./world";

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
  /** `collie --json …` on this Machine, as an operator types it there. */
  readonly cli: (
    args: ReadonlyArray<string>,
    extra?: Readonly<Record<string, string>>,
  ) => ReturnType<typeof collie>;
  /** Says which of herdr's machines this Machine's herdr lists. */
  readonly lists: (machines: ReadonlyArray<Side>) => Effect.Effect<void>;
}

/** A port nothing on this computer is listening on now. */
const freePort = Effect.callback<number>((resume) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address !== null && Schema.is(Bound)(address) ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});
const Bound = Schema.Struct({ port: Schema.Number });

/** A fake `ssh`: `-G` resolves every target to 127.0.0.1; anything else runs as a login on `to`. */
const fakeSsh = (log: string, env: Readonly<Record<string, string>>) => {
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}='${value.replaceAll("'", `'\\''`)}'`)
    .join(" ");
  return `#!/bin/sh
if [ "$1" = "-G" ]; then printf 'hostname 127.0.0.1\\nport 22\\n'; exit 0; fi
master=; control=; operation=
while [ $# -gt 0 ]; do
  case "$1" in
    -S) control="$2"; echo "option $1 $2" >> '${log}'; shift 2 ;;
    -O) operation="$2"; shift 2 ;;
    -o|-L) echo "option $1 $2" >> '${log}'; shift 2 ;;
    -M) master=1; echo "option $1" >> '${log}'; shift ;;
    -T|-N) echo "option $1" >> '${log}'; shift ;;
    *) break ;;
  esac
done
target="$1"; shift
if [ -n "$master" ]; then
  touch "$control"
  trap 'rm -f "$control"; exit 0' TERM
  while :; do sleep 1; done
fi
if [ -n "$operation" ]; then [ -e "$control" ]; exit; fi
echo "login $target $*" >> '${log}'
exec env -i ${exports} /bin/sh -c "$*"
`;
};

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
  body: (first: Side, second: Side) => Effect.Effect<A, E, BunServices | Scope.Scope>,
  modules: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const command = yield* collieCommand;
    const suite = yield* suiteEnv;
    const make = (name: string, port: number) =>
      Effect.gen(function* () {
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: `${prefix}${name}-` });
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
        yield* writeFakeHerdrShim(herdr, `${root}test/support/fake-herdr.ts`);
        yield* fs.writeFileString(
          `${bin}/collie`,
          `#!/bin/sh\nexec ${command.map((part) => `'${part}'`).join(" ")} "$@"\n`,
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
          COLLIE_PEER_PORT: String(port),
          HERDR_BIN_PATH: herdr,
          FAKE_HERDR_LOG: herdrLog,
          ...suite,
        };
        const side: Side = {
          name,
          world,
          env,
          herdrLog,
          sshLog: `${dir}/ssh-calls.log`,
          cli: (args, extra = {}) => collie(world, args, { ...env, ...extra }),
          lists: (machines) =>
            fs
              .writeFileString(`${herdrLog}.machines.json`, encode(machines.map(machineOf)))
              .pipe(Effect.orDie),
        };
        return { side, bin };
      });
    const first = yield* make("first", yield* freePort);
    const second = yield* make("second", yield* freePort);
    yield* fs.writeFileString(`${first.bin}/ssh`, fakeSsh(first.side.sshLog, second.side.env), {
      mode: 0o755,
    });
    return yield* body(first.side, second.side);
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
              contents: manifest.replace(/^version = ".*"/m, `version = "${version}"`),
            }));
          },
        },
      ],
      compile: { outfile: file },
    }),
  );
  if (!built.success)
    return yield* Effect.fail(new Error(`could not build ${version}: ${built.logs.join("\n")}`));
});
