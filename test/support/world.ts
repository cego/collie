import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import type { Scope } from "effect";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import type { PlatformServices } from "../../src/platform";
import { currentEnv } from "../../src/env";
import { Herdr } from "../../src/herdr";
import { exec } from "./command";
import { runEffect, suiteEnv } from "./effect";
import { serveFakeHc } from "./fake-hc";
import type { FakeHc } from "./fake-hc";
import { armTripwire, untripped } from "./herdr-tripwire";
import { fixtures, root, stopHost, until } from "./host";
import { answering } from "./forwarding";
import { marked } from "./sweep";
import { testBunfig } from "./packages";

export interface World {
  readonly install: string;
  readonly user: string;
  readonly state: string;
  readonly config: string;
  readonly home: string;
  readonly project: string;
}

const asCommand = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(Schema.String))),
  Result.getOrThrow,
);

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

export const collieCommand = Config.option(Config.String("COLLIE_TEST_BINARY")).pipe(
  Effect.map((binary) =>
    Option.isSome(binary) ? [binary.value] : [process.execPath, `${root}src/main.ts`],
  ),
);

export const collie = Effect.fn("World.collie")(function* (
  world: World,
  args: ReadonlyArray<string>,
  extra: Readonly<Record<string, string>> = {},
  onStderr: (text: string) => Effect.Effect<void> = () => Effect.void,
) {
  const command = yield* collieCommand;
  const suite = yield* suiteEnv;
  const child = Bun.spawn([...command, "--json", ...args], {
    cwd: world.project,
    env: {
      PATH: yield* Config.String("PATH").pipe(Config.withDefault("/usr/bin:/bin")),
      HOME: world.home,
      COLLIE_ROOT: world.install,
      COLLIE_STATE_DIR: world.state,
      COLLIE_USER_DIR: world.config,
      COLLIE_CWD: world.project,
      COLLIE_HOST: asCommand(command),
      ...suite,
      // WARNING: This env is otherwise built from nothing, so the world's own core is passed explicitly.
      HC_SOCKET: Bun.env.HC_SOCKET,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.all(
    [
      Effect.promise(() => new Response(child.stdout).text()),
      Stream.fromReadableStream({ evaluate: () => child.stderr, onError: (cause) => cause }).pipe(
        Stream.orDie,
        Stream.decodeText(),
        Stream.tap(onStderr),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      ),
      Effect.promise(() => child.exited),
    ],
    { concurrency: "unbounded" },
  );
  return {
    exit,
    stderr,
    envelope: yield* asEnvelope(stdout).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            `collie ${Arr.join(args, " ")} exited ${exit}: ${String(cause)}; stdout=${stdout}; stderr=${stderr}`,
          ),
      ),
      Effect.orDie,
    ),
  };
});

export const save = (into: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(into, { recursive: true });
    for (const name of names) yield* fs.copyFile(`${fixtures}/${name}`, `${into}/${name}`);
  }).pipe(Effect.orDie);

// WARNING: A host is a child that inherits the process environment, not this world's Config.
const fakesIn = Effect.fn("World.fakesIn")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const tripwire = yield* armTripwire(dir);
  yield* Effect.addFinalizer(() => tripwire.stop);
  // WARNING: A host asks claude --help before an agent starts; the operator's claude is too slow under a suite, so fake it.
  const harnesses = `${dir}/harnesses`;
  yield* fs.makeDirectory(harnesses).pipe(Effect.orDie);
  yield* fs
    .writeFileString(
      `${harnesses}/claude`,
      `#!/bin/sh\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
      { mode: 0o755 },
    )
    .pipe(Effect.orDie);
  for (const harness of ["codex", "pi", "opencode"])
    yield* fs.writeFileString(`${harnesses}/${harness}`, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const socket = `${dir}/hc.sock`;
  const core = yield* serveFakeHc(
    socket,
    `${dir}/core-calls.jsonl`,
    yield* Effect.scope,
    `${dir}/home/outputs.json`,
  );
  const set = { HC_SOCKET: socket, PATH: `${tripwire.binDir}:${harnesses}:/usr/bin:/bin` };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = { HC_SOCKET: Bun.env.HC_SOCKET, PATH: Bun.env.PATH };
      Object.assign(Bun.env, set, {
        PATH: `${tripwire.binDir}:${harnesses}:${Bun.env.PATH ?? ""}`,
      });
      return before;
    }),
    (before) =>
      Effect.sync(() => {
        for (const [key, value] of Rec.toEntries(before))
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
      }),
  );
  return { set, tripwire, core };
});

const neverModelled = (world: World) =>
  Effect.gen(function* () {
    const log = yield* (yield* FileSystem.FileSystem)
      .readFileString(`${world.state}/host.log`)
      .pipe(Effect.orElseSucceed(() => ""));
    const started = Str.split(log, "host started").length - 1;
    const off = Str.split(log, "the Run model is off").length - 1;
    if (Str.includes("the Run model holds")(log) || off !== started)
      return yield* Effect.die(
        new Error(`a host filled its Run model with run_model false:\n${log}`),
      );
  });

export const proves = <A, E>(
  prefix: string,
  body: (world: World, core: FakeHc) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  modules: ReadonlyArray<string>,
) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const marker = yield* Config.String("COLLIE_TEST_ROOT").pipe(Config.withDefault(""));
      const dir = yield* fs.makeTempDirectoryScoped({ prefix });
      const world: World = {
        install: `${dir}/install`,
        user: `${dir}/install/user/workflows`,
        state: `${dir}/state`,
        config: `${dir}/install/user`,
        home: `${dir}/home`,
        project: `${dir}/project`,
      };
      // WARNING: Stop the host before the directory goes, or a host left running can write it back.
      yield* Effect.addFinalizer(() =>
        stopHost(world.state).pipe(
          // WARNING: A forwarded call may outlive its host and write into this directory; let this world's finish before removing it.
          Effect.andThen(
            until(
              () =>
                Effect.sync(() => {
                  const log = { HC_SOCKET: `${dir}/hc.sock` };
                  return (marker === "" ? 0 : marked(marker, log).length) + answering(log);
                }),
              (left) => left === 0,
            ),
          ),
          Effect.ignore,
        ),
      );
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
      yield* fs.writeFileString(`${world.home}/.bunfig.toml`, testBunfig).pipe(Effect.orDie);
      yield* exec(["git", "init", "-q"], { cwd: world.project });
      yield* save(world.user, modules);
      const modelOff =
        (yield* Config.String("COLLIE_TEST_RUN_MODEL").pipe(Config.withDefault(""))) === "off";
      if (modelOff)
        yield* fs
          .writeFileString(`${world.config}/config.json`, `{"run_model": false}\n`)
          .pipe(Effect.orDie);
      const command = yield* collieCommand;
      const suite = yield* suiteEnv;
      // WARNING: Never the operator's live core, which on a desk is the real one.
      const fakes = yield* fakesIn(dir);
      return yield* body(world, fakes.core).pipe(
        Effect.tap(() => (modelOff ? neverModelled(world) : Effect.void)),
        Effect.tap(() => untripped(fakes.tripwire)),
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              COLLIE_HOST: asCommand(command),
              COLLIE_TEST_BINARY: command.length === 1 ? command[0] : undefined,
              ...suite,
              COLLIE_ROOT: world.install,
              COLLIE_STATE_DIR: world.state,
              COLLIE_USER_DIR: world.config,
              HOME: world.home,
              COLLIE_CWD: world.project,
              ...fakes.set,
            }),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

export const blockedAtItsPrompt = (core: FakeHc) =>
  Effect.gen(function* () {
    const herdr = new Herdr(yield* currentEnv.pipe(Effect.orDie));
    const [agent] = yield* until(
      () => herdr.agentList(),
      (all) => Arr.some(all, (one) => one.status === "idle"),
    );
    yield* core.report(agent!.name, "blocked");
  });
