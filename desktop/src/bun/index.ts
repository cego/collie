// Desktop's main process: one window on the view, and every Machine's board relayed to it
// as Effect RPC over Electrobun's message channel.

import { hostname } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Config,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import Electrobun, { BrowserView, BrowserWindow, type RPCSchema, Utils } from "electrobun/bun";
import {
  type Channel,
  type FrameSchema,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../shared/channel";
import {
  ActionFailed,
  type Credentials,
  DesktopRpcs,
  type FlockItem,
  type KnownMachine,
  type OnboardRun,
  type UpdateNews,
} from "../shared/flock";
import { RELEASE_PUBLIC_KEY } from "../../../src/signing";
import {
  act,
  type Door,
  doorTo,
  offersOn,
  workflowsOn,
  endChildren,
  flockStream,
  type HerdrMachine,
  herdrMachines,
  localRoute,
  type ShellRoute,
  remoteRoute,
  removeFromHerdr,
  type RouteChange,
} from "./machine";
import { addToHerdr, doctorOn, NOT_STARTED, onboardThrough, RELEASES, tracked } from "./onboarding";
import {
  claudeLoginThrough,
  GITLAB,
  giveHelle,
  giveToken,
  gitlabToken,
  oneLine,
  secretService,
  secretsFor,
} from "./credentials";
import { tokenPage } from "../../../src/gitlab-token";
import { electrobunUpdater } from "./electrobun-updater";
import {
  dropBoardsOf,
  dropOnboarding,
  saveOnboarding,
  savedBoards,
  savedOnboardings,
  saving,
} from "./saved";
import { applyAtLaunch, restartToUpdate, watchForUpdates } from "./updates";
// The version Desktop keeps every Machine on: the Collie it was built from.
import manifest from "../../../herdr-plugin.toml";

type Frames = RPCSchema<FrameSchema>;

let receive: (frame: ToMain) => void = () => {};
const rpc = BrowserView.defineRPC<{ bun: Frames; webview: Frames }>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {},
    messages: {
      // SAFETY: only the view sends on this channel, and the view sends nothing but `ToMain`.
      frame: (frame) => receive(frame as ToMain),
    },
  },
});

// Opened once an update readied before the last quit has had its chance to install, so
// installing one never shows a window that closes again.
let window: BrowserWindow<typeof rpc> | undefined;
const openWindow = () =>
  Effect.sync(() => {
    window = new BrowserWindow({
      title: "Collie",
      url: "views://mainview/index.html",
      renderer: "cef",
      frame: { width: 1200, height: 800, x: 120, y: 80 },
      rpc,
    });
  });

const toView: Channel<ToView, ToMain> = {
  send: (frame) => window?.webview.rpc?.send.frame(frame),
  listen: (listener) => {
    receive = listener;
  },
};

/** How `collie` is run here: in a login shell, as SSH would on another Machine. */
const Collie = Config.schema(
  Schema.fromJsonString(Schema.Array(Schema.String)),
  "COLLIE_DESKTOP_COLLIE",
).pipe(
  Config.orElse(() =>
    Config.String("SHELL").pipe(
      Config.withDefault("/bin/sh"),
      Config.map((shell) => [shell, "-lc", 'exec collie "$@"', "collie"]),
    ),
  ),
);

/** Opens a web page in the human's own browser. */
const openUrl = (url: string) =>
  Effect.sync(() => {
    if (Bun.which("xdg-open") === null) return void Utils.openExternal(url);
    Bun.spawn(["xdg-open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  });

/** How long herdr's question waits on the human before it takes herdr's own default. */
const QUESTION_LIMIT = "10 minutes";

const main = Effect.gen(function* () {
  const updater = yield* electrobunUpdater;
  yield* applyAtLaunch(updater).pipe(
    Effect.catch((reason) => Effect.logWarning(`Desktop update not installed: ${reason}`)),
  );
  yield* openWindow();
  const updates = yield* SubscriptionRef.make<UpdateNews | null>(null);
  yield* watchForUpdates(updater).pipe(
    Stream.runForEach((news) => SubscriptionRef.set(updates, news)),
    Effect.forkScoped,
  );
  const local = hostname();
  const collie = yield* Collie;
  const releases = yield* Config.String("COLLIE_DESKTOP_RELEASES").pipe(
    Config.withDefault(RELEASES),
  );
  // A Desktop from a checkout, as its tests run, may trust another key; a release never.
  const key =
    (yield* updater.channel) === "stable"
      ? RELEASE_PUBLIC_KEY
      : yield* Config.String("COLLIE_DESKTOP_RELEASE_KEY").pipe(
          Config.withDefault(RELEASE_PUBLIC_KEY),
        );
  const gitlab = yield* Config.String("COLLIE_DESKTOP_GITLAB").pipe(Config.withDefault(GITLAB));
  const gitlabHost = new URL(gitlab).host;
  const keyring = secretService();
  const blank: Credentials = { gitlab: null, helle: false, tokenPage: tokenPage(gitlabHost) };
  // Its expiry is GitLab's to say, so a token renewed elsewhere is not warned of.
  const held = Effect.gen(function* () {
    const token = yield* keyring.lookup("gitlab-token");
    const expires =
      token === null
        ? null
        : yield* gitlabToken(gitlab, token).pipe(
            Effect.map((said) => said.expires),
            Effect.orElseSucceed(() => null),
          );
    return {
      ...blank,
      gitlab: token === null ? null : { expires },
      helle: (yield* keyring.lookup("helle-token")) !== null,
    } satisfies Credentials;
  });
  const credentials = yield* SubscriptionRef.make(blank);
  // Read beside the start rather than before it: frames the view sends before Desktop
  // serves its RPCs are lost. A save made meanwhile is newer than it.
  yield* held.pipe(
    Effect.flatMap((read) =>
      SubscriptionRef.update(credentials, (now) => (now === blank ? read : now)),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  const fs = yield* FileSystem.FileSystem;
  // Short, because a control socket's path is capped at about 100 bytes.
  const controls = yield* fs.makeTempDirectoryScoped({ prefix: "collie-ssh-" });
  // herdr's list is the only list of Machines there is.
  const listed = yield* herdrMachines("herdr").pipe(Effect.result);
  const now = yield* Clock.currentTimeMillis;
  const [enabled, unlisted] = Result.match(listed, {
    onSuccess: (machines) => [machines, []] as const,
    onFailure: (reason): readonly [[], FlockItem[]] => [
      [],
      [
        {
          _tag: "Lost",
          machine: { profile: "herdr", name: "herdr's machines" },
          state: "unreachable",
          reason,
          at: now,
        },
      ],
    ],
  });
  // Every route by herdr profile, each herdr machine's with the scope its master lives in.
  const routes = new Map<string, { route: ShellRoute; scope?: Scope.Closeable }>();
  routes.set("local", { route: localRoute(collie, local) });
  let opened = 0;
  const open = (machine: HerdrMachine) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const route = yield* remoteRoute("ssh", `${controls}/${opened++}`, machine, local).pipe(
        Scope.provide(scope),
      );
      routes.set(route.machine.profile, { route, scope });
      return route;
    });
  yield* Effect.forEach(enabled, open, { discard: true });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      routes.values(),
      ({ scope }) => (scope ? Scope.close(scope, Exit.void) : Effect.void),
      {
        discard: true,
      },
    ),
  );
  const changes = yield* PubSub.unbounded<RouteChange>();
  const news = yield* PubSub.unbounded<FlockItem>();
  const doors = new Map<string, Door>();
  const boards = `${Utils.paths.userData}/machines`;
  const onboardings = `${Utils.paths.userData}/onboarding`;
  const runners = `${Utils.paths.userData}/runners`;
  const scope = yield* Effect.scope;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);

  // The job onboarding each route, and its fiber, while one runs; and the question each job waits on.
  const onboarding = new Map<string, { job: string; fiber?: Fiber.Fiber<unknown, unknown> }>();
  const answers = new Map<string, Deferred.Deferred<boolean>>();
  const tell = (job: string, machine: KnownMachine) => (run: OnboardRun) =>
    PubSub.publish(news, { _tag: "Onboarding", job, machine, run }).pipe(Effect.asVoid);
  const doctored = (route: ShellRoute) =>
    doctorOn(route).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (run) => PubSub.publish(news, { _tag: "Doctored", machine: route.machine, run }),
        }),
      ),
      Effect.asVoid,
    );
  const ended = (job: string, profile: string) =>
    Effect.sync(() => {
      if (onboarding.get(profile)?.job === job) onboarding.delete(profile);
    });
  /** Records the fiber, unless `job` has already ended. */
  const recorded = (job: string, profile: string) => (fiber: Fiber.Fiber<unknown, unknown>) =>
    Effect.sync(() => {
      if (onboarding.get(profile)?.job === job) onboarding.set(profile, { job, fiber });
    });
  /** Onboards through `route` under `job`, then keeps how it ended and has it tried at once. */
  const onboardAs = (job: string, route: ShellRoute, start: OnboardRun = NOT_STARTED) => {
    const { machine } = route;
    onboarding.set(machine.profile, { job });
    return Effect.gen(function* () {
      // Without the keyring, a Machine is onboarded as far as it goes with none.
      const secrets = yield* secretsFor(keyring).pipe(Effect.orElseSucceed(() => ""));
      return yield* onboardThrough(
        route,
        { version: manifest.version, releases, runners, key, secrets, open: openUrl },
        tell(job, machine),
        start,
      );
    }).pipe(
      Effect.tap((run) => saveOnboarding(onboardings, { _tag: "Onboarding", job, machine, run })),
      Effect.tap(() => PubSub.publish(changes, { _tag: "Wake", profile: machine.profile })),
      // Forked, as a Machine out of reach would hold the onboarding open until it is back.
      Effect.tap(() => doctored(route).pipe(Effect.forkIn(scope))),
      Effect.ensuring(ended(job, machine.profile)),
      Effect.provide(BunServices.layer),
      Effect.forkIn(scope),
      Effect.tap(recorded(job, machine.profile)),
    );
  };
  /** Saves the machine in herdr, asking herdr's questions of the human, then onboards it. */
  const addAs = (job: string, target: string, label: string, session: string) =>
    Effect.gen(function* () {
      const run = tracked(tell(job, { profile: `adding:${job}`, name: label, target }));
      const saved = { step: "herdr", title: `Saved in herdr as ${label}` } as const;
      yield* run.step(saved);
      const ask = (text: string, yes: boolean) =>
        Effect.gen(function* () {
          const answer = yield* Deferred.make<boolean>();
          answers.set(job, answer);
          yield* run.change((now) => ({ ...now, asked: { text, yes } }));
          // Nobody left to answer, as when the view went away, is herdr's own default.
          const said = yield* Deferred.await(answer).pipe(
            Effect.timeoutOption(QUESTION_LIMIT),
            Effect.map(Option.getOrElse(() => yes)),
          );
          answers.delete(job);
          yield* run.change((now) => ({ ...now, asked: null }));
          return said;
        });
      const before = new Set(routes.keys());
      const added = yield* addToHerdr("herdr", target, label, session, ask).pipe(
        Effect.andThen(herdrMachines("herdr")),
        Effect.flatMap((machines) => {
          const found = machines.find(
            (machine) =>
              !before.has(machine.id) && machine.target === target && machine.label === label,
          );
          return found === undefined
            ? Effect.fail(`herdr lists no new machine for ${target}`)
            : Effect.succeed(found);
        }),
        Effect.result,
      );
      if (Result.isFailure(added)) {
        yield* run.step({ ...saved, status: "failed", detail: added.failure });
        return yield* run.end(false, null);
      }
      const route = yield* open(added.success);
      yield* PubSub.publish(news, { _tag: "Routed", machine: route.machine });
      yield* PubSub.publish(changes, { _tag: "Add", route });
      yield* run.step({ ...saved, status: "done", detail: `herdr machine ${added.success.id}` });
      yield* Fiber.join(yield* onboardAs(job, route, run.current()));
    });

  const everyRoute = () => [...routes.values()].map(({ route }) => route);
  const given = (
    what: string,
    each: ReadonlyArray<{ readonly name: string; readonly failed: string | null }>,
  ) => {
    const failed = each.filter((one) => one.failed !== null);
    return [
      `${what} given to ${each.length - failed.length} of ${each.length} Machines`,
      ...failed.map(({ name, failed: why }) => `${name}: ${why}`),
    ].join("; ");
  };
  const codes = new Map<string, Queue.Queue<string>>();
  /** Logs Claude Code in through `route`, then onboards it again under the same job. */
  const loginAs = (job: string, route: ShellRoute) =>
    Effect.gen(function* () {
      const typed = yield* Queue.unbounded<string>();
      codes.set(job, typed);
      const { run } = yield* claudeLoginThrough(
        route,
        openUrl,
        typed,
        tell(job, route.machine),
        NOT_STARTED,
      ).pipe(Effect.ensuring(Effect.sync(() => codes.delete(job))));
      yield* Fiber.join(yield* onboardAs(job, route, run));
    });

  const handlers = DesktopRpcs.toLayer({
    flock: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Before the routes are read, so a route added meanwhile is not missed.
          const changed = yield* PubSub.subscribe(changes);
          const told = yield* PubSub.subscribe(news);
          const reachable = [...routes.values()].map(({ route }) => route);
          // A Machine herdr no longer lists is not Desktop's to show.
          const listed = ({ machine }: { readonly machine: KnownMachine }) =>
            routes.has(machine.profile);
          const checked = new Set<string>();
          const doctorOnceLive = (item: FlockItem) => {
            if ("_tag" in item || item.message._tag !== "Snapshot") return Effect.void;
            const route = routes.get(item.machine.profile)?.route;
            if (route === undefined || checked.has(item.machine.profile)) return Effect.void;
            checked.add(item.machine.profile);
            return doctored(route).pipe(Effect.forkIn(scope));
          };
          const before: ReadonlyArray<FlockItem> = [
            ...reachable.map(({ machine }): FlockItem => ({ _tag: "Routed", machine })),
            ...(yield* savedBoards(boards)).filter(listed),
            ...(yield* savedOnboardings(onboardings)).filter(listed),
          ];
          return Stream.fromIterable(before).pipe(
            Stream.concat(
              Stream.mergeAll(
                [
                  Stream.fromIterable(unlisted),
                  flockStream(
                    reachable,
                    doors,
                    manifest.version,
                    Stream.fromSubscription(changed),
                  ).pipe(Stream.tap(doctorOnceLive)),
                  Stream.fromSubscription(told),
                ],
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      ).pipe(saving(boards), Stream.provide(BunServices.layer)),
    onboard: ({ profile }) =>
      Effect.gen(function* () {
        const running = onboarding.get(profile);
        if (running !== undefined) return running.job;
        const route = routes.get(profile)?.route;
        if (route === undefined)
          return yield* new ActionFailed({ reason: "that Machine is not in herdr's list" });
        const job = yield* uuid;
        yield* onboardAs(job, route);
        return job;
      }),
    addMachine: ({ target, label, session }) =>
      Effect.gen(function* () {
        if ([target, label, session].some((one) => one.trim() === ""))
          return yield* new ActionFailed({
            reason: "a Machine needs an SSH target, a label and a session",
          });
        const job = yield* uuid;
        yield* addAs(job, target.trim(), label.trim(), session.trim()).pipe(
          Effect.provide(BunServices.layer),
          Effect.forkIn(scope),
        );
        return job;
      }),
    credentials: () => SubscriptionRef.changes(credentials),
    saveGitlab: ({ token }) =>
      Effect.gen(function* () {
        const said = token.trim();
        if (!oneLine(said)) return yield* Effect.fail("a token is one line");
        const { expires } = yield* gitlabToken(gitlab, said);
        yield* keyring.store("gitlab-token", `Collie's GitLab token for ${gitlabHost}`, said);
        yield* SubscriptionRef.update(credentials, (now) => ({ ...now, gitlab: { expires } }));
        return given("GitLab token", yield* giveToken(everyRoute(), gitlabHost, said));
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    saveHelle: ({ url, token }) =>
      Effect.gen(function* () {
        const [at, said] = [url.trim(), token.trim()];
        if (!oneLine(at) || !oneLine(said))
          return yield* Effect.fail("Helle needs its URL and a token, each on one line");
        yield* keyring.store("helle-url", "Helle's URL for Collie", at);
        yield* keyring.store("helle-token", "Collie's Helle token", said);
        yield* SubscriptionRef.update(credentials, (now) => ({ ...now, helle: true }));
        return given("Helle's credentials", yield* giveHelle(everyRoute(), at, said));
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    claudeLogin: ({ profile }) =>
      Effect.gen(function* () {
        const route = routes.get(profile)?.route;
        if (route === undefined)
          return yield* new ActionFailed({ reason: "that Machine is not in herdr's list" });
        const busy = onboarding.get(profile);
        if (busy !== undefined) return busy.job;
        const job = yield* uuid;
        onboarding.set(profile, { job });
        yield* loginAs(job, route).pipe(
          Effect.ensuring(ended(job, profile)),
          Effect.provide(BunServices.layer),
          Effect.forkIn(scope),
          Effect.tap(recorded(job, profile)),
        );
        return job;
      }),
    pasteCode: ({ job, code }) =>
      Effect.suspend(() => {
        const typed = codes.get(job);
        return typed === undefined || code.trim() === ""
          ? Effect.void
          : Queue.offer(typed, code.trim()).pipe(Effect.asVoid);
      }),
    answerHerdr: ({ job, yes }) =>
      Effect.suspend(() => {
        const answer = answers.get(job);
        return answer === undefined ? Effect.void : Deferred.succeed(answer, yes);
      }),
    removeMachine: ({ profile }) =>
      Effect.gen(function* () {
        const known = routes.get(profile);
        if (known?.scope === undefined)
          return yield* new ActionFailed({
            reason: "only a machine in herdr's list can be removed",
          });
        yield* removeFromHerdr("herdr", profile).pipe(
          Effect.mapError((reason) => new ActionFailed({ reason })),
        );
        const done = yield* Deferred.make<void>();
        yield* PubSub.publish(changes, { _tag: "Remove", profile, done });
        // Without a board open there is no stream to end.
        yield* Deferred.await(done).pipe(Effect.timeoutOption("5 seconds"));
        routes.delete(profile);
        const running = onboarding.get(profile)?.fiber;
        if (running !== undefined) yield* Fiber.interrupt(running);
        yield* Scope.close(known.scope, Exit.void);
        yield* Effect.all([
          dropOnboarding(onboardings, profile),
          dropBoardsOf(boards, profile),
        ]).pipe(Effect.provide(BunServices.layer));
        return `Removed ${known.route.machine.name}`;
      }),
    act: ({ installation, action, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* uuid);
        const door = yield* doorTo(doors, installation).pipe(
          Effect.mapError((failed) => new ActionFailed({ reason: failed.reason, request })),
        );
        return yield* act(door, request, action);
      }),
    openLink: ({ url }) => openUrl(url),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door, runId))),
    workflows: ({ installation, project }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => workflowsOn(door, project))),
    updates: () =>
      SubscriptionRef.changes(updates).pipe(
        Stream.filter((news): news is UpdateNews => news !== null),
      ),
    restart: () =>
      restartToUpdate(updater).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
        Effect.provide(BunServices.layer),
      ),
  });
  return yield* Layer.launch(
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(toView))),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// Quitting may end the process before any scope closes, and an SSH master would outlive it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
