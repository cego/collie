import { Herdr } from "../../src/herdr";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  PubSub,
  Result,
  Schedule,
  Schema,
  flow,
} from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type { Scope } from "effect";
import type { PlatformServices } from "../../src/platform";
import type { Rig } from "./recorder";
import { fastForward, runEffect as runLive } from "./effect";
import { FakeBin } from "./bin";
import { forgeOnPath, serveForges } from "./forge";
import type { ForgeModel } from "./forge";
import { agentsLayer } from "../../src/agents";
import { Registry, foundationLayer, registryLayer } from "../../src/engine";
import type { Generation, HostServices } from "../../src/engine";
import { Store } from "../../src/store";
import { STOP } from "../../src/controls";
import { Host } from "../../src/sdk";
import { buildBoard } from "../../src/board";
import { FrontDoorRpcs, mrId } from "../../src/board-model";
import type { Toasted } from "../../src/board-model";
import { factsOfView } from "../../src/runs";
import { askingOf, mergeWatch } from "../../src/side-jobs";
import { requestedOver } from "../../src/review-requests";
import { recoverParks } from "../../src/park-recovery";
import { Woke } from "../../src/mr-watch-model";
import type { MrPanels } from "../../src/merges";
import type { slackApi } from "../../src/slack";
import { frontDoorHandlers, sharedBoardLayer } from "../../src/host";
import { CheckProcesses, hostCheckProcesses } from "../../src/check-processes";
import { runRecordsLayer } from "../../src/run-records";
import { schedulesLayer } from "../../src/schedules";
import { usageLayer } from "../../src/usage";
import { catalogueLayer } from "../../src/catalogue";
import { artefactsLayer } from "../../src/artefacts";
import { collectingLayer } from "../../src/collecting";
import { foregroundLayer } from "../../src/foreground";
type DoorRpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const asJson = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

export const ROOT = new URL("../../", import.meta.url).pathname;

export const watching = (rig: Rig, slack?: typeof slackApi) => {
  const env = () => rig.pluginEnv({ COLLIE_ROOT: ROOT });
  const dir = () => env().stateDir;
  const toasts: Array<string> = [];

  const gitlab = (model: ForgeModel, name: "gitlab" | "github" = "gitlab") =>
    Effect.gen(function* () {
      const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (made) =>
        made.restore(),
      );
      const faked = yield* forgeOnPath(bin, name, model);
      let before: (_url: string, _init?: RequestInit) => Promise<void> = (_url, _init?) =>
        Promise.resolve();
      let after = (_url: string, _init: RequestInit | undefined, response: Response) =>
        Promise.resolve(response);
      const face = (url: string, init?: RequestInit) =>
        before(url, init)
          .then(() => faked.face(url, init))
          .then((response) => after(url, init, response));
      return {
        ...faked,
        api: yield* serveForges({ forge: faked.forge, face }),
        before: (hook: typeof before) => {
          before = hook;
        },
        after: (hook: typeof after) => {
          after = hook;
        },
      };
    });
  type Forge = Effect.Success<ReturnType<typeof gitlab>>;

  const layers = (forge: Forge) =>
    registryLayer(dir(), {
      userDir: rig.userDir,
      placing: { herdr: new Herdr(env()), env: env() },
    }).pipe(
      Layer.provideMerge(
        agentsLayer({
          dir: dir(),
          env: env(),
          herdr: new Herdr(env()),
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
          slack,
          userDir: rig.userDir,
          placing: { herdr: new Herdr(env()), env: env() },
          toast: (title) => Effect.sync(() => toasts.push(title)),
        }),
      ),
      Layer.provideMerge(
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forge.api })),
      ),
    );

  const session = <A, E>(
    forge: Forge,
    work: Effect.Effect<
      A,
      E,
      Layer.Success<ReturnType<typeof layers>> | PlatformServices | Scope.Scope
    >,
  ) => work.pipe(Effect.provide(layers(forge)), Effect.scoped);

  const mergeWatched = Effect.gen(function* () {
    const registry = yield* Registry;
    const store = yield* Store;
    const hosted = yield* Effect.context<HostServices>();
    const stillWatching = (run: string, name: string) =>
      Effect.gen(function* () {
        if (!(yield* store.waitingOn(run, name))) {
          return false;
        }
        const view = yield* registry.view(run);
        return !(view?.controls ?? []).includes(STOP);
      }).pipe(Effect.provideContext(hosted));
    const platform = yield* Effect.context<PlatformServices>();
    const panels: MrPanels = new Map();
    const board = Effect.gen(function* () {
      const runs = Arr.map(yield* registry.views(null), (view) => factsOfView(dir(), view));
      const views = yield* buildBoard({
        env: env(),
        runs,
        alive: [],
        offers: () => Effect.succeed([]),
        watching: Effect.map(store.outstanding, (rows) => new Set(Arr.map(rows, (row) => row.run))),
      });
      return { runs, views };
    }).pipe(Effect.provideContext(platform), Effect.orDie);
    yield* Effect.forkScoped(
      mergeWatch({
        env: env(),
        board,
        asking: Effect.map(board, ({ runs }) => askingOf(runs)),
        panels,
        record: () => Effect.void,
        stop: (runId) =>
          registry.control({ runId, control: STOP, set: true }).pipe(
            Effect.provideContext(hosted),
            Effect.orElseSucceed(() => undefined),
            Effect.asVoid,
          ),
        watches: {
          still: stillWatching,
          observe: store.observe,
          unavailable: (run, name, why) =>
            Effect.flatMap(Host, (host) =>
              host.parked(run, why, "forge-unavailable", stillWatching(run, name)),
            ).pipe(Effect.provideContext(hosted)),
          wake: (run, name, woke) =>
            registry.wake(run, name, woke).pipe(Effect.provideContext(hosted)),
          outstanding: store.outstanding,
        },
        requested: requestedOver(
          (suffix) => Effect.map(store.requestedEnding(suffix), (row) => row !== null),
          registry,
          env(),
          hosted,
        ),
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
    const generation: Generation = yield* registry.load(entry);
    return yield* registry.start({
      generation,
      request,
      project: rig.projectDir,
      input,
      text: {},
      task: null,
    });
  });

  // WARNING: the door is the host's own handlers, over this session's registry and state dir.
  const door = Effect.gen(function* () {
    let answered: (response: RpcMessage.FromServer<DoorRpcs>) => Effect.Effect<void> = () =>
      Effect.void;
    const handlers = yield* Layer.build(
      frontDoorHandlers(
        dir(),
        "test-install",
        {},
        new Map(),
        new Map(),
        "stamp",
        yield* PubSub.unbounded<Toasted>(),
        Effect.succeed(0),
        Effect.void,
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            usageLayer,
            catalogueLayer(rig.projectDir),
            collectingLayer,
            foregroundLayer,
          ).pipe(
            Layer.provideMerge(
              schedulesLayer({
                dir: dir(),
                env: { ...env(), stateDir: dir() },
                installation: "test-install",
                seconds: false,
              }),
            ),
            Layer.provideMerge(artefactsLayer),
            Layer.provideMerge(
              Layer.effect(
                CheckProcesses,
                hostCheckProcesses({ dir: dir(), installation: "test-install", sweep: false }),
              ),
            ),
            Layer.provideMerge(runRecordsLayer),
            Layer.provideMerge(sharedBoardLayer(dir())),
            Layer.provideMerge(ConfigProvider.layerAdd(ConfigProvider.fromUnknown(env().raw))),
          ),
        ),
      ),
    );
    const served = yield* RpcServer.makeNoSerialization(FrontDoorRpcs, {
      onFromServer: (response) => answered(response),
    }).pipe(Effect.provideContext(handlers));
    const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
      supportsAck: true,
      onFromClient: ({ message }) => served.write(0, message),
    });
    answered = client.write;
    return client.client;
  });

  const recovering = Effect.gen(function* () {
    const registry = yield* Registry;
    const services = yield* Effect.context<HostServices | PlatformServices>();
    yield* Effect.forkScoped(
      recoverParks({
        env: env(),
        herdr: new Herdr(env()),
        views: registry.views(null),
        reconnects: Effect.succeed(0),
        panels: new Map(),
        hasRoom: () => Effect.succeed(true),
        resume: (view, _request, park) => registry.resume(view.runId, park),
      }).pipe(Effect.provideContext(services)),
    );
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
    Arr.filter((cmd) => cmd === "terminal.run"),
  );

  // WARNING: Every intervening timer still fires, so the fast clock steps over the five-minute poll.
  const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices | Scope.Scope>) =>
    runLive(
      fastForward(
        Effect.scoped(
          Effect.suspend(() => ((toasts.length = 0), Effect.andThen(rig.startCore(), effect))),
        ),
        250,
      ),
    );

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
    github: (model: ForgeModel) => gitlab(model, "github"),
    session,
    mergeWatched,
    door,
    recovering,
    started,
    status,
    watchOf,
    agentStarts,
    runEffect,
    settingOn,
  };
};

export const until = <A, E, R>(
  read: () => Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  seconds = 3600,
) =>
  Effect.suspend(read).pipe(
    Effect.repeat({
      until: done,
      schedule: Schedule.spaced("1 second"),
      times: seconds,
    }),
    Effect.filterOrElse(done, () => Effect.die(new Error("it never came"))),
  );

export const decodeWoke = (value: Schema.Json | null) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Woke))(value).pipe(Effect.orDie);
