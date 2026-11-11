// The host's own engine, store, registry and merge watch, in process on a fast clock, over a
// fake GitLab: what a Run that waits on its merge request is driven through.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Result,
  Schedule,
  Schema,
  flow,
  type Scope,
} from "effect";
import type { PlatformServices } from "../../src/platform";
import { FakeHerdr, type Rig } from "./recorder";
import { fastForward, runEffect as runLive } from "./effect";
import { FakeBin } from "./bin";
import { forgeOnPath, serveForges, type ForgeModel } from "./forge";
import { agentsLayer } from "../../src/agents";
import {
  Registry,
  foundationLayer,
  registryLayer,
  type Generation,
  type HostServices,
} from "../../src/engine";
import { Store } from "../../src/store";
import { buildBoard } from "../../src/board";
import { mrId } from "../../src/board-model";
import { factsOfView } from "../../src/runs";
import { mergeWatch } from "../../src/side-jobs";
import { Woke } from "../../src/mr-watch-model";
import type { MrPanels } from "../../src/merges";

const asJson = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

export const ROOT = new URL("../../", import.meta.url).pathname;

export const watching = (rig: Rig) => {
  const env = () => rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT });
  const dir = () => env().stateDir;
  const toasts: string[] = [];

  /** glab on PATH and GitLab served, for the whole test, as a host's restart leaves the forge as it was. */
  const gitlab = (model: ForgeModel) =>
    Effect.gen(function* () {
      const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (made) =>
        made.restore(),
      );
      const faked = yield* forgeOnPath(bin, "gitlab", model);
      let before = (_url: string, _init?: RequestInit): Promise<void> => Promise.resolve();
      let after = (_url: string, _init: RequestInit | undefined, response: Response) =>
        Promise.resolve(response);
      const face = (url: string, init?: RequestInit) =>
        before(url, init)
          .then(() => faked.face(url, init))
          .then((response) => after(url, init, response));
      return {
        ...faked,
        api: yield* serveForges({ forge: faked.forge, face }),
        /** Runs ahead of each HTTP request the forge is sent, as what changes it in between. */
        before: (hook: typeof before) => {
          before = hook;
        },
        /** Stands between the forge's answer and its caller, as a host that dies before it hears one. */
        after: (hook: typeof after) => {
          after = hook;
        },
      };
    });
  type Forge = Effect.Success<ReturnType<typeof gitlab>>;

  /** One host over the state directory, ended with its scope. */
  const session = <A, E>(
    forge: Forge,
    work: Effect.Effect<A, E, Registry | Store | HostServices | PlatformServices | Scope.Scope>,
  ) =>
    work.pipe(
      Effect.provide(
        registryLayer(dir(), {
          userDir: rig.userDir,
          placing: { herdr: new FakeHerdr(env()), env: env() },
        }).pipe(
          Layer.provideMerge(
            agentsLayer({
              dir: dir(),
              env: env(),
              herdr: new FakeHerdr(env()),
              harness: "claude",
              model: "opus",
              permissions: "auto",
              compactAtTokens: 0,
              pollMs: 20,
              collectMs: 60_000,
            }),
          ),
          Layer.provideMerge(
            foundationLayer({
              dir: dir(),
              userDir: rig.userDir,
              placing: { herdr: new FakeHerdr(env()), env: env() },
              toast: (title) => Effect.sync(() => toasts.push(title)),
            }),
          ),
          Layer.provideMerge(
            ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forge.api })),
          ),
        ),
      ),
      Effect.scoped,
    );

  /** The host's merge watch, over the board its Runs make. */
  const mergeWatched = Effect.gen(function* () {
    const registry = yield* Registry;
    const store = yield* Store;
    const hosted = yield* Effect.context<HostServices>();
    const platform = yield* Effect.context<PlatformServices>();
    const panels: MrPanels = new Map();
    const board = Effect.gen(function* () {
      const runs = Arr.map(yield* registry.views(null), (view) => factsOfView(dir(), view));
      const views = yield* buildBoard({
        env: env(),
        runs,
        alive: [],
        offers: () => Effect.succeed([]),
      });
      return { runs, views };
    }).pipe(Effect.provideContext(platform), Effect.orDie);
    yield* Effect.forkScoped(
      mergeWatch({
        env: env(),
        board,
        panels,
        record: () => Effect.void,
        stop: () => Effect.void,
        watches: {
          list: store.watches,
          observe: store.observe,
          wake: (run, name, woke) =>
            registry.wake(run, name, woke).pipe(Effect.provideContext(hosted)),
        },
      }).pipe(Effect.provideContext(platform)),
    );
    return { board };
  });

  const started = Effect.fn("Watching.started")(function* (
    entry: string,
    request: string,
    input: Readonly<Record<string, Schema.Json>>,
  ) {
    const registry = yield* Registry;
    const generation: Generation = (yield* registry.load(entry))!;
    return yield* registry.start({
      generation,
      request,
      project: rig.projectDir,
      input,
      text: {},
      task: null,
    });
  });

  const status = (runId: string) =>
    Registry.pipe(Effect.flatMap((registry) => registry.view(runId)));

  const watchOf = (runId: string, target: string) =>
    Store.pipe(
      Effect.flatMap((store) => store.watches([mrId(target)!])),
      Effect.map((rows) => Option.getOrNull(Arr.findFirst(rows, (row) => row.run === runId))),
    );

  const agentStarts = Effect.map(
    Effect.suspend(() => rig.cmds()),
    Arr.filter((cmd) => cmd === "agent start"),
  );

  const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices | Scope.Scope>) =>
    runLive(fastForward(Effect.scoped(Effect.suspend(() => ((toasts.length = 0), effect)))));

  const settingOn = (on: boolean) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs.writeFileString(
          `${rig.userDir}/config.json`,
          asJson({ review: { follow_through: on } }),
        ),
      ),
      Effect.orDie,
    );

  return {
    env,
    dir,
    toasts,
    gitlab,
    session,
    mergeWatched,
    started,
    status,
    watchOf,
    agentStarts,
    runEffect,
    settingOn,
  };
};

/** `read` once `done` holds, looked at each second of the fast clock for up to an hour of it. */
export const until = <A, E, R>(read: () => Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.suspend(read).pipe(
    Effect.repeat({
      until: done,
      schedule: Schedule.spaced("1 second"),
      times: 3_600,
    }),
    Effect.filterOrElse(done, () => Effect.die(new Error("it never came"))),
  );

export const decodeWoke = (value: Schema.Json | null) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Woke))(value).pipe(Effect.orDie);
