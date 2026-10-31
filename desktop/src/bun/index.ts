// Desktop's main process: one window on the view, every Machine's board relayed to it as
// Effect RPC over Electrobun's message channel, and the Flock chat beside them.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { homedir, hostname, tmpdir } from "node:os";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Clock,
  Config,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Queue,
  Result,
  Schedule,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
  flow,
} from "effect";
import { CommandLine } from "effect/process";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as RpcServer from "effect/rpc/RpcServer";
import Electrobun, {
  BrowserView,
  BrowserWindow,
  type RPCSchema,
  Utils,
  Updater,
} from "electrobun/bun";
import {
  type Channel,
  type FrameSchema,
  serverProtocol,
  type ToMain,
  type ToView,
} from "../shared/channel";
import {
  ActionFailed,
  applyItem,
  chatBoards,
  CREDENTIALS,
  type Credentials,
  DesktopRpcs,
  type DesktopSettingsChange,
  EMPTY_FLOCK,
  type FlockItem,
  type KnownMachine,
  machineRows,
  type MachineLinked,
  type MachineSynced,
  type MachineOwnRead,
  type OnboardRun,
  type OnboardStep,
  Skippable,
  type TerminalCommand,
} from "../shared/flock";
import { RELEASE_PUBLIC_KEY } from "../../../src/signing";
import { pruneDesktop, sweepSshControls } from "../../../src/desktop";
import { PeerView } from "../../../src/peers-model";
import { appWindowFor } from "./browser";
import { applicationMenu } from "./menu";
import { clipboardPaths } from "../shared/attachments";
import { readAttachment, stageAttachment, stagePath } from "./attachments";
import { actionsLog } from "./sent";
import { type FlockConversation, openFlockChat, refusal, untilStarted } from "./chat";
import { claudeCode, claudeModels } from "./claude";
import { claudeDriver } from "./claude-driver";
import { loopbackTools } from "./chat-endpoint";
import { piDriver } from "./pi-driver";
import { CHILD_CWD, childEnv, localShell, takeLoginEnv, which } from "./login-env";
import { type ChatMachine, chatDoor } from "./flock-tools";
import { carryIntoFlock, heldSettings, type Offers } from "./settings";
import { offerOf, offersOf, opensOn, readPiConfig, retelling } from "./chat-choices";
import { harnessLists, listedIn } from "./harness-lists";
import type { ListedModel } from "./claude-models";
import { readPiModels } from "./pi-models";
import { followWindow, zoomWindow } from "./scale";
import type { Drawn } from "../shared/scale";
import {
  definitionsSync,
  flockSync,
  readFlockDefinitions,
  writeFlockDefinitions,
  writeFlockSettings,
} from "./flock-settings";
import {
  DEFAULT_CHAT_HARNESS,
  editSetting,
  NO_FLOCK_SETTINGS,
  type FlockSettings,
} from "../shared/flock-settings";
import { nowIso } from "../../../src/time";
import { changedLine } from "../../../src/schedule-model";
import { SettingValue, settingText } from "../../../src/settings";
import { isString } from "../../../src/schema";
import { keepOwn } from "../shared/machine-own";
import {
  actOn,
  DoorMap,
  type Doors,
  doorTo,
  focusOn,
  offersOn,
  runDetailOn,
  usageOn,
  cataloguesOn,
  machineOwnOn,
  schedulesOn,
  cleanupOn,
  sweepOn,
  changeScheduleOn,
  moveScheduleOn,
  runFileOn,
  definitionsIn,
  endChildren,
  flockStream,
  type HerdrMachine,
  herdrMachines,
  localRoute,
  linkRoute,
  pairedMachines,
  type ShellRoute,
  remoteRoute,
  removeFromHerdr,
  type RouteChange,
  syncNow,
} from "./machine";
import { givenCredentials } from "./given";
import { saveSlackConnection, disconnectSlackConnection } from "./slack";
import { slackApi } from "../../../src/slack";
import { connectionsOn, githubLogin, readBack, reuseGitlab } from "./connection-reuse";
import { flockInSyncSaid, inSync } from "../shared/in-sync";
import { attachCommand, inTerminal, launched, openTerminal } from "./terminal";
import {
  addToHerdr,
  doctorOn,
  NOT_STARTED,
  onboardThrough,
  onboardingSkips,
  RELEASES,
  tracked,
} from "./onboarding";
import {
  claudeLoginThrough,
  GITLAB,
  giveHelle,
  giveToken,
  giveGithub,
  giveSlack,
  gitlabToken,
  helleOwner,
  oneLine,
  credentialsFile,
  secretsFor,
  SLACK_APP,
  SLACK_WEB,
} from "./credentials";
import { isHostName, tokenPage } from "../../../src/gitlab-token";
import { HELLE_URL } from "../../../src/helle-url";
import { platformLayer } from "../../../src/platform";
import { electrobunUpdater } from "./electrobun-updater";
import {
  dropBoardsOf,
  dropOnboarding,
  dropOwn,
  saveOnboarding,
  savedBoards,
  savedOnboardings,
  saveOwn,
  savedOwn,
  saving,
} from "./saved";
import { applyAtLaunch, restartToUpdate, updatesOf } from "./updates";
// The version Desktop keeps every Machine on: the Collie it was built from.
import manifest from "../../../herdr-plugin.toml";

type Frames = RPCSchema<FrameSchema>;

/** A window on the view, and the channel its RPC rides. */
const windowOn = (url: string, title: string, frame: BrowserWindow["frame"]) => {
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
  // macOS bundles no CEF, so its windows render with the system's WebKit.
  const window = new BrowserWindow({ title, url, renderer: "cef", frame, rpc });
  // The view holds the Bun bridge, so nothing may navigate the window off it. Set on the
  // webview: as a window option, Linux CEF ignores it.
  window.webview.setNavigationRules(["^*", url, "about:srcdoc"]);
  const channel: Channel<ToView, ToMain> = {
    send: (frame) => window.webview.rpc?.send.frame(frame),
    listen: (listener) => {
      receive = listener;
    },
  };
  return { window, channel };
};

const VIEW = "views://mainview/index.html";

const Collie = (shell: ReadonlyArray<string>) =>
  Config.schema(Schema.fromJsonString(Schema.Array(Schema.String)), "COLLIE_DESKTOP_COLLIE").pipe(
    Config.orElse(() => Config.succeed([...shell, 'exec collie "$@"', "collie"])),
  );

const OPENER = process.platform === "darwin" ? "open" : "xdg-open";

/** Opens a web page in the human's own browser. */
const openUrl = (url: string) =>
  Effect.sync(() => {
    if (which(OPENER) === null) return void Utils.openExternal(url);
    Bun.spawn([OPENER, url], {
      env: childEnv(),
      cwd: CHILD_CWD,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  });

/** Slack's own app where it opens, else its web client. */
const openSlack = Effect.gen(function* () {
  if (which(OPENER) === null) return yield* openUrl(SLACK_WEB);
  // Never killed: still running is the app taking it.
  const child = Bun.spawn([OPENER, SLACK_APP], {
    env: childEnv(),
    cwd: CHILD_CWD,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = yield* Effect.promise(() => child.exited).pipe(Effect.timeoutOption("5 seconds"));
  if (Option.isSome(code) && code.value !== 0) yield* openUrl(SLACK_WEB);
});

/** How long herdr's question waits on the human before it takes herdr's own default. */
const QUESTION_LIMIT = "10 minutes";

/** Where Desktop keeps what is its own on this computer, the Flock chat's session among it. */
const StateDir = Config.String("XDG_STATE_HOME").pipe(
  Config.orElse(() => Config.String("HOME").pipe(Config.map((home) => `${home}/.local/state`))),
);

const main = Effect.gen(function* () {
  // Before anything is spawned, so every child starts with the shell's PATH and variables.
  const tookLoginEnv = yield* takeLoginEnv;
  const updater = yield* electrobunUpdater(Updater);
  yield* applyAtLaunch(updater).pipe(
    Effect.catch((reason) => Effect.logWarning(`Desktop update not installed: ${reason}`)),
  );
  // Opened once an update readied before the last quit has had its chance to install, so
  // installing one never shows a window that closes again.
  const board = windowOn(VIEW, "Collie", { width: 1200, height: 800, x: 120, y: 80 });
  const updates = yield* updatesOf(updater, manifest.version);
  const local = hostname();
  const shell = yield* localShell(tookLoginEnv);
  const collie = yield* Collie(shell);
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
  const own = (yield* Path.Path).join(yield* StateDir, "collie-desktop");
  // Started on this bundle, so every other staged update has been applied or passed over.
  yield* pruneDesktop({
    root: Utils.paths.userData,
    state: own,
    hash: yield* updater.hash,
    version: manifest.version,
  }).pipe(Effect.ignore({ log: "Warn" }));
  const logged = yield* actionsLog(own);
  const doors = new DoorMap<Doors>();
  /** A harness's list from this computer's Machine; its own reader's where it has none or an older one. */
  const fromMachine = (harness: string, own: Effect.Effect<ReadonlyArray<ListedModel>, string>) =>
    Effect.suspend(() => {
      const local = Option.getOrUndefined(
        Arr.findFirst([...doors.values()], (door) => door.machine.profile === "local"),
      );
      if (local === undefined) return own;
      return local.desktop.models().pipe(
        Effect.map((catalogues) => listedIn(catalogues, harness)),
        Effect.catchCause(() => Effect.succeed(null)),
        Effect.flatMap((read) =>
          read === null
            ? own
            : Result.match(read, {
                onSuccess: (models) => Effect.succeed(models),
                onFailure: (why) => Effect.fail(why),
              }),
        ),
      );
    });
  const lists = yield* harnessLists({
    claude: fromMachine(
      "claude",
      Effect.suspend(() => claudeModels(SubscriptionRef.getUnsafe(flockSettings), own)),
    ),
    pi: fromMachine(
      "pi",
      Effect.suspend(() => readPiModels(SubscriptionRef.getUnsafe(flockSettings), own)),
    ),
  });
  // Before Desktop's own settings are held, so a save does not write back what was carried.
  const loadedFlock = yield* carryIntoFlock(own, yield* nowIso).pipe(Effect.result);
  const flockReadable = Result.isSuccess(loadedFlock);
  const unreadableFlock = new ActionFailed({
    reason: "Not set: the Flock's settings could not be read",
  });
  const saved = Result.isSuccess(loadedFlock) ? loadedFlock.success : NO_FLOCK_SETTINGS;
  const desktop = yield* heldSettings(
    own,
    (): FlockSettings => SubscriptionRef.getUnsafe(flockSettings),
    (now): Effect.Effect<Offers, never, FileSystem.FileSystem | Path.Path> =>
      offersOf(now, SubscriptionRef.getUnsafe(flockSettings), readPiConfig(own), lists),
  );
  const settings = desktop.now;
  // The GitLab host an earlier Desktop kept as its own becomes the Flock's.
  const ownGitlabHost = settings().gitlabHost;
  const seeded =
    ownGitlabHost === undefined || saved.settings.gitlab_host !== undefined
      ? saved
      : editSetting(saved, "gitlab_host", ownGitlabHost, yield* nowIso);
  const flockSettings = yield* SubscriptionRef.make("refused" in seeded ? saved : seeded);
  const flockDefinitions = yield* SubscriptionRef.make(yield* readFlockDefinitions(own));
  const defaultGitlab = yield* Config.String("COLLIE_DESKTOP_GITLAB").pipe(
    Config.withDefault(GITLAB),
  );
  const gitlab = () => {
    const host = SubscriptionRef.getUnsafe(flockSettings).settings.gitlab_host?.value;
    return isString(host) && isHostName(host) ? `https://${host}` : defaultGitlab;
  };
  const gitlabHost = () => new URL(gitlab()).host;
  const gitlabPages = () => ({ host: gitlabHost(), tokenPage: tokenPage(gitlabHost()) });
  const helle = yield* Config.String("COLLIE_HELLE_URL").pipe(Config.withDefault(HELLE_URL));
  const config =
    (yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""))) ||
    `${homedir()}/.config`;
  const keyring = credentialsFile(`${config}/collie-desktop`);
  const blank: Credentials = { gitlab: null, helle: false, ...gitlabPages() };
  // Its expiry is GitLab's to say, so a token renewed elsewhere is not warned of.
  const held = Effect.gen(function* () {
    const token = yield* keyring.lookup("gitlab-token");
    const expires =
      token === null
        ? null
        : yield* gitlabToken(gitlab(), token).pipe(
            Effect.map((said) => said.expires),
            Effect.orElseSucceed(() => null),
          );
    return {
      ...blank,
      ...gitlabPages(),
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
    Effect.ignore({ log: "Warn" }),
    Effect.forkScoped,
  );
  // An older Desktop that was killed left its own masters behind.
  yield* sweepSshControls(tmpdir(), childEnv()).pipe(Effect.ignore);
  // herdr's list is the only list of Machines there is.
  const listed = yield* herdrMachines("herdr", manifest.min_herdr_version).pipe(Effect.result);
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
  // Every route by herdr profile, each herdr machine's with the scope it lives in.
  const routes = new Map<string, { route: ShellRoute; scope?: Scope.Closeable }>();
  routes.set("local", { route: localRoute(collie, local, shell) });
  const open = (machine: HerdrMachine) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const peer = Option.getOrUndefined(
        Arr.findFirst(yield* pairedMachines(collie), (one) => one.name === machine.label),
      );
      const ssh = yield* remoteRoute(
        "ssh",
        collie,
        machine,
        local,
        peer !== undefined,
        peer === undefined,
      ).pipe(Scope.provide(scope));
      const route = linkRoute(
        collie,
        { name: machine.label },
        ssh,
        local,
        childEnv(),
        peer !== undefined,
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
  /** Each route's paired link as Local last listed it, told again to a view that subscribes. */
  const links = new Map<string, MachineLinked>();
  const asListed = flow(Schema.encodeResult(Schema.fromJsonString(PeerView)), Result.getOrThrow);
  yield* pairedMachines(collie).pipe(
    Effect.flatMap((listed) =>
      Effect.forEach(
        routes.values(),
        ({ route: { machine } }) => {
          const link = Option.getOrUndefined(
            Arr.findFirst(listed, (one) => one.name === machine.name),
          );
          const was = links.get(machine.profile)?.link;
          if (link === undefined || (was !== undefined && asListed(was) === asListed(link)))
            return Effect.void;
          const item = { _tag: "Linked", machine, link } as const;
          links.set(machine.profile, item);
          return PubSub.publish(news, item);
        },
        { discard: true },
      ),
    ),
    Effect.repeat(Schedule.spaced("15 seconds")),
    Effect.forkScoped,
  );
  const flockValue = (key: string) => SubscriptionRef.getUnsafe(flockSettings).settings[key]?.value;
  /** Keeps an edit made here, then gives it to every connected Machine. */
  const editFlockSettings = (
    changes: ReadonlyArray<{ readonly key: string; readonly value: string }>,
  ) =>
    Effect.gen(function* () {
      if (!flockReadable) return yield* unreadableFlock;
      return yield* settingsSync.edit(changes, yield* nowIso);
    });
  const editFlock = (key: string, typed: string) => editFlockSettings([{ key, value: typed }]);
  const boards = `${Utils.paths.userData}/machines`;
  const ownDirectory = `${Utils.paths.userData}/machine-own`;
  const ownReadings = new Map(
    Arr.map(yield* savedOwn(ownDirectory), (read) => [read.machine.profile, read]),
  );
  const readOwn = (door: Doors) =>
    machineOwnOn(door.machine, door.desktop).pipe(
      Effect.flatMap((read) =>
        Effect.gen(function* () {
          const kept: MachineOwnRead = {
            ...read,
            reading: keepOwn(read.reading, ownReadings.get(read.machine.profile)?.reading),
          };
          ownReadings.set(read.machine.profile, kept);
          yield* saveOwn(ownDirectory, kept).pipe(Effect.provide(BunServices.layer));
          yield* PubSub.publish(news, kept);
        }),
      ),
    );
  const onboardings = `${Utils.paths.userData}/onboarding`;
  const runners = `${Utils.paths.userData}/runners`;
  const scope = yield* Effect.scope;
  /** How the board's window is drawn, which Settings says. */
  const drawn = yield* SubscriptionRef.make<Drawn | null>(null);
  const zoomAgain = new Set<Effect.Effect<void>>();
  /** Keeps `window` at its monitor's own scale until it closes, telling `told` how. */
  const zoomed = (
    window: BrowserWindow,
    title: string,
    told: (drawn: Drawn) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const { again, asked } = yield* followWindow(window);
      zoomAgain.add(again);
      const closed = Deferred.makeUnsafe<void>();
      window.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
      yield* asked.pipe(
        Stream.runForEach(() =>
          Effect.flatMap(zoomWindow(window, title, settings().zoom ?? 1), told),
        ),
        Effect.raceFirst(Deferred.await(closed)),
        Effect.ensuring(Effect.sync(() => zoomAgain.delete(again))),
        Effect.forkIn(scope),
      );
    });
  yield* zoomed(board.window, "Collie", (now) => SubscriptionRef.set(drawn, now));
  const uuid = (yield* SecureRandom.SecureRandom).uuidV4();
  /** Each route's latest settings and definitions sync, told again to a view that subscribes. */
  const synced = new Map<string, MachineSynced>();
  const settingsOf = (door: Doors) => ({
    name: door.machine.name,
    door: {
      ...door.desktop,
      settings: door.desktop.settings(),
      sharedDefinitions: door.desktop.sharedDefinitions(),
    },
    machine: door.machine,
  });
  // A Machine out of reach, or on a collie without the operation until it is upgraded, is
  // synced when it next connects.
  const toldSynced =
    (part: MachineSynced["part"]) =>
    ({ machine }: { readonly machine: KnownMachine }, failed: string | null) =>
      Effect.suspend(() => {
        const item = { _tag: "Synced", part, machine, failed } as const;
        synced.set(`${part}:${machine.profile}`, item);
        return PubSub.publish(news, item);
      }).pipe(Effect.asVoid);
  const settingsSync = yield* flockSync({
    flock: flockSettings,
    machines: () => Arr.map([...doors.values()], settingsOf),
    save: (flock) => writeFlockSettings(own, flock).pipe(Effect.provide(BunServices.layer)),
    request: uuid,
    told: toldSynced("settings"),
  });
  const syncOn = (machine: ReturnType<typeof settingsOf>) =>
    flockReadable ? settingsSync.syncOn(machine) : Effect.succeed(unreadableFlock.reason);
  const syncEvery = () => (flockReadable ? settingsSync.syncEvery() : Effect.void);
  const definitions = yield* definitionsSync({
    flock: flockDefinitions,
    machines: () => Arr.map([...doors.values()], settingsOf),
    save: (flock) => writeFlockDefinitions(own, flock).pipe(Effect.provide(BunServices.layer)),
    request: uuid,
    told: toldSynced("definitions"),
  });
  const firstFailure = (each: ReadonlyArray<{ readonly failed: string | null }>) =>
    each[0]?.failed ?? null;
  const given = yield* givenCredentials({
    dir: own,
    keyring,
    give: {
      gitlab: (route, text) => Effect.map(giveToken([route], gitlabHost(), text), firstFailure),
      helle: (route, text) => Effect.map(giveHelle([route], helle, text), firstFailure),
      slack: (route, text) => Effect.map(giveSlack([route], text), firstFailure),
    },
    tell: (item) => PubSub.publish(news, item).pipe(Effect.asVoid),
    skipped: (profile) =>
      savedOnboardings(onboardings).pipe(
        Effect.map(
          (all) =>
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(
                  Option.getOrUndefined(
                    Arr.findFirst(all, (saved) => saved.machine.profile === profile),
                  ),
                ),
                (present) =>
                  Arr.map(
                    Arr.filter(present.run.steps, ({ status }) => status === "skipped"),
                    ({ step }) => step,
                  ),
              ),
            ) ?? [],
        ),
        Effect.provide(BunServices.layer),
      ),
  });

  // The job onboarding each route, and its fiber, while one runs; and the question each job waits on.
  const onboarding = new Map<string, { job: string; fiber?: Fiber.Fiber<unknown, unknown> }>();
  const answers = new Map<string, Deferred.Deferred<boolean>>();
  const tell = (job: string, machine: KnownMachine) => (run: OnboardRun) =>
    PubSub.publish(news, { _tag: "Onboarding", job, machine, run }).pipe(Effect.asVoid);
  const doctored = (route: ShellRoute) =>
    doctorOn(route, gitlabHost()).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (run) =>
            PubSub.publish(news, { _tag: "Doctored", machine: route.machine, run }).pipe(
              Effect.asVoid,
            ),
        }),
      ),
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
  const onboardAs = (
    job: string,
    route: ShellRoute,
    start: OnboardRun = NOT_STARTED,
    skipping: ReadonlyArray<Skippable> = [],
    restoring?: Skippable,
  ) => {
    const { machine } = route;
    onboarding.set(machine.profile, { job });
    return Effect.gen(function* () {
      // Without its credentials file, a Machine is onboarded as far as it goes with none.
      const secrets = yield* secretsFor(keyring).pipe(Effect.orElseSucceed(() => ""));
      const handed = yield* given.held;
      const before = Option.getOrUndefined(
        Arr.findFirst(
          yield* savedOnboardings(onboardings),
          (saved) => saved.machine.profile === machine.profile,
        ),
      );
      const skip = onboardingSkips(before?.run.steps ?? [], skipping, restoring);
      const run = yield* onboardThrough(
        route,
        {
          version: manifest.version,
          releases,
          runners,
          key,
          secrets,
          open: openUrl,
          skip,
          gitlabHost: gitlabHost(),
        },
        tell(job, machine),
        start,
      );
      if (run.ready === true && secrets !== "") yield* given.handed(machine, handed, run.steps);
      // Kept as skipped where the run ended before it, so the next run skips it too.
      const unreached = Arr.map(
        Arr.filter(skip, (step) => !Arr.some(run.steps, (one) => one.step === step)),
        (step): OnboardStep => ({ step, title: step, status: "skipped" }),
      );
      return { ...run, steps: [...run.steps, ...unreached] };
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
        Effect.andThen(herdrMachines("herdr", manifest.min_herdr_version)),
        Effect.flatMap((machines) => {
          const found = Option.getOrUndefined(
            Arr.findFirst(
              machines,
              (machine) =>
                !before.has(machine.id) && machine.target === target && machine.label === label,
            ),
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

  const everyRoute = () => Arr.map([...routes.values()], ({ route }) => route);
  const gave = (
    what: string,
    each: ReadonlyArray<{ readonly name: string; readonly failed: string | null }>,
  ) => {
    const failed = Arr.filter(each, (one) => one.failed !== null);
    return Arr.join(
      [
        `${what} given to ${each.length - failed.length} of ${each.length} Machines`,
        ...Arr.map(failed, ({ name, failed: why }) => `${name}: ${why}`),
      ],
      "; ",
    );
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

  /** Desktop's own settings, one change at a time, as Settings and the Flock chat make them. */
  const saveSettings = (changed: DesktopSettingsChange) =>
    desktop
      .save(changed)
      .pipe(
        Effect.tap(() =>
          changed.zoom === undefined
            ? Effect.void
            : Effect.forEach(zoomAgain, (again) => again, { discard: true }),
        ),
      );

  /** Files named by path, each copied in or refused in words. */
  const stagedFrom = (paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (path) =>
      stagePath(own, path).pipe(
        Effect.catch((cause) => Effect.succeed({ refused: `${path}: ${cause.message}` })),
      ),
    ).pipe(Effect.provide(BunServices.layer));

  // The Flock as the board was last sent it: the chat reads its Machines and boards from it.
  let shown = EMPTY_FLOCK;
  /** When Desktop began waiting on each route, by herdr profile. */
  const routedAt = new Map<string, number>();
  const holds = Effect.map(given.held, (texts) => ({
    version: manifest.version,
    credentials: Arr.filter(CREDENTIALS, (one) => texts[one] !== undefined && texts[one] !== ""),
  }));
  /** Sync now: what connecting would do for the Machine on `profile`. */
  const syncMachine = (profile: string) =>
    Effect.gen(function* () {
      const route = routes.get(profile)?.route;
      const row = Option.getOrUndefined(
        Arr.findFirst(machineRows(shown), (one) => one.profile === profile),
      );
      if (route === undefined || row === undefined)
        return yield* new ActionFailed({ reason: "that Machine is not in herdr's list" });
      const { behind } = inSync(row, yield* holds);
      const door = Option.getOrUndefined(
        Arr.findFirst([...doors.values()], (one) => one.machine.profile === profile),
      );
      return yield* syncNow(
        route.machine,
        Arr.map(behind, ({ part }) => part),
        {
          reopen: PubSub.publish(changes, { _tag: "Reopen", profile }),
          sync:
            door === undefined
              ? Effect.succeed("it isn't connected; it is synced when it connects")
              : syncOn(settingsOf(door)),
          syncDefinitions:
            door === undefined
              ? Effect.succeed("it isn't connected; it is synced when it connects")
              : definitions.syncOn(settingsOf(door)),
          give: given.giveLacking(route),
        },
      );
    });
  // Opened by the view's first ask, in Desktop's own scope; its session starts with the first message.
  const chat = yield* openFlockChat({
    drivers: (context) =>
      loopbackTools(context).pipe(
        Effect.map((endpoint) => ({
          claude: claudeDriver(claudeCode, context),
          pi: piDriver(context, endpoint),
        })),
      ),
    dir: own,
    conversation: `flock@${local}`,
    proactive: () => flockValue("flock_chat.proactive") !== false,
    machineRule: () => {
      const rule = flockValue("machine_rule");
      return isString(rule) ? rule : undefined;
    },
    setMachineRule: (machineRule) =>
      editFlock("machine_rule", machineRule).pipe(
        Effect.asVoid,
        Effect.orDie,
        Effect.provide(BunServices.layer),
      ),
    choice: () =>
      opensOn(settings(), SubscriptionRef.getUnsafe(flockSettings), readPiConfig(own), lists),
    offered: (harness) =>
      offerOf(
        harness,
        settings(),
        SubscriptionRef.getUnsafe(flockSettings),
        readPiConfig(own),
        lists,
      ),
    retold: retelling(desktop.changes, SubscriptionRef.changes(flockSettings)),
    readModels: lists.need,
    modelsChanged: lists.changes.pipe(Stream.drop(1)),
    chatHarness: () => ({
      harness: settings().chatHarness ?? DEFAULT_CHAT_HARNESS,
      model: settings().chatModel,
      effort: settings().chatEffort,
    }),
    setChatHarness: ({ harness, model, effort }) => {
      const changed: Partial<Record<"chatHarness" | "chatModel" | "chatEffort", string>> = {};
      if (harness !== undefined) changed.chatHarness = harness;
      if (model !== undefined) changed.chatModel = Str.trim(model);
      if (effort !== undefined) changed.chatEffort = Str.trim(effort);
      return saveSettings(changed).pipe(
        Effect.as(null),
        Effect.catch(({ reason }) => Effect.succeed(reason)),
        Effect.provide(BunServices.layer),
      );
    },
    helle: keyring
      .lookup("helle-token")
      .pipe(Effect.map((token) => (token === null ? null : { url: helle, token }))),
    inSync: (sync) =>
      Effect.gen(function* () {
        const rows = machineRows(shown);
        if (sync === undefined) return flockInSyncSaid(rows, yield* holds);
        const row = Option.getOrUndefined(
          Arr.findFirst(rows, (one) => one.name === sync || one.profile === sync),
        );
        if (row === undefined)
          return `No Machine "${sync}"; the Machines are ${Arr.join(
            Arr.map(rows, ({ name }) => name),
            ", ",
          )}`;
        return yield* syncMachine(row.profile).pipe(
          Effect.map(({ said }) => said),
          Effect.catch(({ reason }) => Effect.succeed(reason)),
        );
      }),
    machines: () =>
      Arr.map(chatBoards(shown, routedAt), ({ name, profile, installation, board }) => {
        const held = installation === null ? undefined : doors.get(installation);
        const machine: ChatMachine = { name, board, local: profile === "local" };
        return held === undefined ? machine : { ...machine, door: chatDoor(held.chat) };
      }),
  }).pipe(Scope.provide(scope), untilStarted, Effect.map(Effect.result));
  const withChat = <A>(use: (opened: FlockConversation) => Effect.Effect<A>, unstarted: A) =>
    chat.pipe(
      Effect.flatMap(Result.match({ onSuccess: use, onFailure: () => Effect.succeed(unstarted) })),
    );
  /** The terminal open in the window, and what ends it. */
  let shownTerminal:
    | {
        readonly send: (command: TerminalCommand) => Effect.Effect<void>;
        readonly ended: Deferred.Deferred<void>;
      }
    | undefined;
  let popped:
    | { readonly window: BrowserWindow; readonly closed: Deferred.Deferred<void> }
    | undefined;

  const keepGitlabToken = (token: string) =>
    Effect.gen(function* () {
      const said = Str.trim(token);
      if (!oneLine(said)) return yield* Effect.fail("a token is one line");
      const { expires } = yield* gitlabToken(gitlab(), said);
      yield* keyring.store("gitlab-token", `Collie's GitLab token for ${gitlabHost()}`, said);
      yield* SubscriptionRef.update(credentials, (now) => ({ ...now, gitlab: { expires } }));
      return gave("GitLab token", yield* given.giveEvery(everyRoute(), "gitlab", said));
    }).pipe(Effect.mapError((reason) => new ActionFailed({ reason })));
  const handlers = DesktopRpcs.toLayer({
    // Every board change may have left News, so each one nudges the chat to look.
    flock: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Before the routes are read, so a route added meanwhile is not missed.
          const changed = yield* PubSub.subscribe(changes);
          const told = yield* PubSub.subscribe(news);
          const reachable = Arr.map([...routes.values()], ({ route }) => route);
          // A Machine herdr no longer lists is not Desktop's to show.
          const listed = ({ machine }: { readonly machine: KnownMachine }) =>
            routes.has(machine.profile);
          const checked = new Set<string>();
          const doctorOnceLive = (item: FlockItem) => {
            if ("_tag" in item || item.message._tag !== "Snapshot") return Effect.void;
            const route = routes.get(item.machine.profile)?.route;
            // Again on a new build, which an older one could not answer `--gitlab-host` for.
            const once = `${item.machine.profile}@${item.message.build}`;
            if (route === undefined || checked.has(once)) return Effect.void;
            checked.add(once);
            return doctored(route).pipe(Effect.forkIn(scope));
          };
          // Each Snapshot is a Machine (re)connected, so whatever changed while apart is synced
          // and given.
          const syncOnceLive = (item: FlockItem) => {
            if ("_tag" in item || item.message._tag !== "Snapshot") return Effect.void;
            const door = doors.get(item.machine.installation);
            const route = routes.get(item.machine.profile)?.route;
            return Effect.all(
              [
                door === undefined ? Effect.void : syncOn(settingsOf(door)),
                door === undefined ? Effect.void : readOwn(door),
                door === undefined ? Effect.void : definitions.syncOn(settingsOf(door)),
                route === undefined ? Effect.void : given.giveLacking(route),
                route?.pair === undefined
                  ? Effect.void
                  : route.pair.pipe(
                      Effect.flatMap((text) =>
                        text === null
                          ? Effect.void
                          : PubSub.publish(news, { _tag: "Notice", machine: route.machine, text }),
                      ),
                    ),
              ],
              { concurrency: "unbounded", discard: true },
            ).pipe(Effect.forkIn(scope));
          };
          shown = EMPTY_FLOCK;
          routedAt.clear();
          const before: ReadonlyArray<FlockItem> = [
            { _tag: "Routes", profiles: [...routes.keys()] },
            ...Arr.map(reachable, ({ machine }): FlockItem => ({ _tag: "Routed", machine })),
            ...Arr.filter(yield* savedBoards(boards), listed),
            ...Arr.filter([...ownReadings.values()], listed),
            ...Arr.filter(yield* savedOnboardings(onboardings), listed),
            ...(yield* given.states(Arr.map(reachable, ({ machine }) => machine))),
            ...Arr.filter([...synced.values()], listed),
            ...Arr.filter([...links.values()], listed),
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
                  ).pipe(Stream.tap(doctorOnceLive), Stream.tap(syncOnceLive)),
                  Stream.fromSubscription(told),
                ],
                { concurrency: "unbounded" },
              ),
            ),
          );
        }),
      ).pipe(
        saving(boards),
        Stream.tap((item) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            if ("_tag" in item && item._tag === "Routed" && !routedAt.has(item.machine.profile))
              routedAt.set(item.machine.profile, now);
            // A lost route waits for its board again from then.
            if ("_tag" in item && item._tag === "Lost") routedAt.set(item.machine.profile, item.at);
            shown = applyItem(shown, item);
          }),
        ),
        Stream.provide(BunServices.layer),
        Stream.tap(() => withChat((opened) => opened.nudge, undefined)),
      ),
    onboard: ({ profile, skip }) =>
      Effect.gen(function* () {
        const running = onboarding.get(profile);
        if (running !== undefined) return running.job;
        const route = routes.get(profile)?.route;
        if (route === undefined)
          return yield* new ActionFailed({ reason: "that Machine is not in herdr's list" });
        const job = yield* uuid;
        yield* onboardAs(job, route, NOT_STARTED, skip);
        return job;
      }),
    addMachine: ({ target, label, session }) =>
      Effect.gen(function* () {
        if (Arr.some([target, label, session], (one) => Str.trim(one) === ""))
          return yield* new ActionFailed({
            reason: "a Machine needs an SSH target, a label and a session",
          });
        const job = yield* uuid;
        yield* addAs(job, Str.trim(target), Str.trim(label), Str.trim(session)).pipe(
          Effect.provide(BunServices.layer),
          Effect.forkIn(scope),
        );
        return job;
      }),
    credentials: () => SubscriptionRef.changes(credentials),
    flockSettings: () =>
      !flockReadable
        ? Stream.fail(unreadableFlock)
        : Stream.unwrap(
            syncEvery().pipe(
              Effect.andThen(
                Effect.forEach(doors.values(), readOwn, {
                  concurrency: "unbounded",
                  discard: true,
                }),
              ),
              Effect.forkIn(scope),
              Effect.as(SubscriptionRef.changes(flockSettings)),
            ),
          ),
    setFlockSetting: ({ key, value }) =>
      editFlock(key, value).pipe(
        Effect.map((edited) => {
          const now = settingText(
            Option.getOrNull(
              Schema.decodeUnknownOption(SettingValue)(edited.settings[key]?.value ?? null),
            ),
          );
          return `${key} is ${now === "" ? "unset" : `now ${now}`}; connected Machines are given it now, the rest when they connect`;
        }),
      ),
    setFlockSettings: ({ changes }) =>
      editFlockSettings(changes).pipe(
        Effect.as("Agent choice saved; connected Machines are given it together"),
      ),
    saveGitlab: ({ token }) => keepGitlabToken(token),
    pasteGitlab: () => keepGitlabToken(Utils.clipboardReadText() ?? ""),
    saveGitlabHost: ({ host }) =>
      Effect.gen(function* () {
        const named = Str.trim(host);
        if (!isHostName(named))
          return yield* Effect.fail(`"${named}" is not a host name, such as gitlab.example.com`);
        if (named === gitlabHost()) return `GitLab is ${named} already`;
        if (!flockReadable) return yield* Effect.fail(unreadableFlock.reason);
        // A token is made for one GitLab, so the old host's goes before the host changes.
        // Without a keyring there is none to go.
        const token = yield* keyring.lookup("gitlab-token").pipe(Effect.orElseSucceed(() => null));
        if (token !== null) yield* keyring.clear("gitlab-token");
        yield* editFlock("gitlab_host", named).pipe(Effect.mapError((failed) => failed.reason));
        yield* SubscriptionRef.update(credentials, (now) => ({
          ...now,
          ...gitlabPages(),
          gitlab: null,
        }));
        for (const route of everyRoute()) yield* doctored(route).pipe(Effect.forkIn(scope));
        return `Machines are onboarded and doctored against ${named} from now on; make a token there`;
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    checkHelle: ({ token }) =>
      helleOwner(helle, Str.trim(token)).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
      ),
    openSlack: () => openSlack,
    copyText: ({ text }) => Effect.sync(() => Utils.clipboardWriteText(text)),
    saveHelle: ({ token }) =>
      Effect.gen(function* () {
        const said = Str.trim(token);
        if (!oneLine(said)) return yield* Effect.fail("a token is one line");
        yield* helleOwner(helle, said);
        yield* keyring.store("helle-token", "Collie's Helle token", said);
        yield* SubscriptionRef.update(credentials, (now) => ({ ...now, helle: true }));
        return gave("Helle's token", yield* given.giveEvery(everyRoute(), "helle", said));
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    saveSlack: ({ token }) =>
      saveSlackConnection(token, keyring, (text) =>
        given.giveEvery(everyRoute(), "slack", text),
      ).pipe(
        Effect.map(
          ({ identity, given }) =>
            `Posts as ${identity.user} in ${identity.team}. ${gave("Slack's token", given)}`,
        ),
        Effect.mapError((reason) => new ActionFailed({ reason })),
      ),
    disconnectSlack: () =>
      disconnectSlackConnection(keyring, (text) =>
        given.giveEvery(everyRoute(), "slack", text),
      ).pipe(
        Effect.map((all) => gave("Slack disconnect", all)),
        Effect.mapError((reason) => new ActionFailed({ reason })),
      ),
    slackChoices: () =>
      Effect.gen(function* () {
        const token = yield* keyring.lookup("slack-token");
        if (token) {
          const api = slackApi(token);
          return {
            identity: yield* api.auth(),
            channels: yield* api.channels(),
            people: yield* api.people(),
          };
        }
        for (const source of doors.values()) {
          const reading = Option.getOrUndefined(
            Arr.findFirst(yield* source.desktop.connections(), (one) => one.id === "slack"),
          );
          if (reading?.reading.state === "ok") return yield* source.desktop.slackChoices();
        }
        return yield* Effect.fail(
          "Connect Slack, under Connections below, to pick from the channels your Collie is in.",
        );
      }).pipe(
        Effect.mapError(
          (error) =>
            new ActionFailed({
              reason: isString(error)
                ? error
                : "reason" in error && isString(error.reason)
                  ? error.reason
                  : "The Machine's Slack choices could not be read",
            }),
        ),
      ),
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
        return typed === undefined || Str.trim(code) === ""
          ? Effect.void
          : Queue.offer(typed, Str.trim(code)).pipe(Effect.asVoid);
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
        yield* removeFromHerdr("herdr", profile, collie).pipe(
          Effect.mapError((reason) => new ActionFailed({ reason })),
        );
        const done = yield* Deferred.make<void>();
        yield* PubSub.publish(changes, { _tag: "Remove", profile, done });
        // Without a board open there is no stream to end.
        yield* Deferred.await(done).pipe(Effect.timeoutOption("5 seconds"));
        routes.delete(profile);
        ownReadings.delete(profile);
        const running = onboarding.get(profile)?.fiber;
        if (running !== undefined) yield* Fiber.interrupt(running);
        yield* Scope.close(known.scope, Exit.void);
        yield* Effect.all([
          dropOnboarding(onboardings, profile),
          dropOwn(ownDirectory, profile),
          dropBoardsOf(boards, profile),
          given.drop(profile),
        ]).pipe(Effect.provide(BunServices.layer));
        return `Removed ${known.route.machine.name}`;
      }),
    syncNow: ({ profile }) => syncMachine(profile),
    act: ({ installation, action, request: again, unsent }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* uuid);
        return yield* actOn(doors, installation, request, action, logged, unsent);
      }),
    goToPane: ({ installation, runId }) =>
      Effect.gen(function* () {
        const door = yield* doorTo(doors, installation);
        const at = yield* focusOn(door, yield* uuid, runId);
        const attach = attachCommand(door.machine.target, at.session);
        const terminal = inTerminal(attach, process.platform, which);
        const opened = terminal !== null && (yield* launched(terminal));
        return { at, command: Result.getOrThrow(CommandLine.join(attach)), opened };
      }),
    terminal: ({ installation, runId, agent, cols, rows }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const door = yield* doorTo(doors, installation);
          const route = routes.get(door.machine.profile)?.route;
          if (route === undefined)
            return yield* new ActionFailed({ reason: "that Machine is not connected" });
          const request = yield* uuid;
          const opened = yield* openTerminal(
            focusOn(door, request, runId, agent),
            route,
            cols,
            rows,
          );
          // One at a time: a newer terminal ends this one.
          if (shownTerminal !== undefined) Deferred.doneUnsafe(shownTerminal.ended, Effect.void);
          const mine = { send: opened.send, ended: Deferred.makeUnsafe<void>() };
          shownTerminal = mine;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => shownTerminal === mine && (shownTerminal = undefined)),
          );
          return opened.events.pipe(Stream.interruptWhen(Deferred.await(mine.ended)));
        }),
      ),
    terminalSend: ({ command }) =>
      shownTerminal === undefined
        ? Effect.fail(new ActionFailed({ reason: "no terminal is open" }))
        : shownTerminal.send(command),
    openLink: ({ url }) =>
      appWindowFor(url).pipe(
        Effect.flatMap(Effect.fromNullishOr),
        Effect.flatMap((command) =>
          Effect.try(() =>
            Bun.spawn(command, {
              env: childEnv(),
              cwd: CHILD_CWD,
              stdio: ["ignore", "ignore", "ignore"],
              detached: true,
            }).unref(),
          ),
        ),
        Effect.catch(() => openUrl(url)),
      ),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door, runId))),
    definitions: ({ installation }) => definitionsIn(doors, installation),
    updates: () => Stream.map(updates.news, (news) => ({ version: manifest.version, news })),
    checkForUpdates: () => updates.check,
    restart: () =>
      restartToUpdate(updater).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
        Effect.provide(BunServices.layer),
      ),
    runDetail: ({ installation, runId }) => runDetailOn(doors, installation, runId),
    usage: () =>
      Effect.forEach(doors.values(), (door) => usageOn(door.machine, door.desktop), {
        concurrency: "unbounded",
      }),
    schedules: () =>
      Effect.forEach(
        doors.entries(),
        ([installation, door]) => schedulesOn({ ...door.machine, installation }, door.desktop),
        { concurrency: "unbounded" },
      ),
    catalogues: () =>
      Effect.forEach(doors.values(), (door) => cataloguesOn(door.machine, door.desktop), {
        concurrency: "unbounded",
      }),
    connectionReadings: () =>
      Effect.forEach(doors.values(), (door) => connectionsOn(door.machine, door.desktop), {
        concurrency: "unbounded",
      }),
    reuseConnection: ({ id, from, to }) =>
      Effect.gen(function* () {
        const source = Option.getOrUndefined(
          Arr.findFirst([...doors.values()], (door) => door.machine.profile === from),
        );
        if (source === undefined)
          return yield* Effect.fail("The Machine with the login is not connected");
        const ready = Option.getOrUndefined(
          Arr.findFirst(yield* source.desktop.connections(), (read) => read.id === id),
        )?.reading;
        if (ready?.state !== "ok")
          return yield* Effect.fail(
            `The source no longer has a working ${id} login; refresh Connections`,
          );
        const targets = Arr.filter(
          everyRoute(),
          (route) => to.includes(route.machine.profile) && route.machine.profile !== from,
        );
        if (targets.length !== new Set(Arr.filter(to, (profile) => profile !== from)).size)
          return yield* Effect.fail("A target Machine was removed; refresh Connections");
        const read = source.desktop.connectionLogin({ id });
        if (id === "github") {
          const login = yield* read;
          return gave("GitHub login", yield* giveGithub(targets, login.token));
        }
        const each = yield* reuseGitlab(
          read,
          (login) =>
            Effect.gen(function* () {
              if (!isHostName(login.host))
                return yield* Effect.fail("The source returned an invalid GitLab host");
              if (login.host !== gitlabHost()) {
                if (!flockReadable) return yield* Effect.fail(unreadableFlock.reason);
                yield* keyring.clear("gitlab-token");
                yield* editFlock("gitlab_host", login.host).pipe(
                  Effect.mapError((failed) => failed.reason),
                );
              }
            }),
          keyring,
          (token) => given.giveEvery(targets, "gitlab", token),
        );
        const reached = yield* readBack(each, (name) =>
          Effect.fromNullishOr(
            Arr.findFirst([...doors.values()], (door) => door.machine.name === name).pipe(
              Option.getOrUndefined,
            ),
          ).pipe(
            Effect.flatMap((door) => door.desktop.connections()),
            Effect.flatMap((connections) =>
              Effect.fromNullishOr(
                Option.getOrUndefined(Arr.findFirst(connections, (one) => one.id === "gitlab"))
                  ?.reading,
              ),
            ),
          ),
        );
        yield* SubscriptionRef.update(credentials, (now) => ({
          ...now,
          ...gitlabPages(),
          gitlab: { expires: null },
        }));
        return `Using glab's login from ${source.machine.name}; ${gave("GitLab login", reached)}`;
      }).pipe(
        Effect.mapError(
          (error) =>
            new ActionFailed({
              reason: isString(error)
                ? error
                : "The login's Machine could not be read; refresh Connections and try again",
            }),
        ),
      ),
    githubLogin: ({ profile }) =>
      Effect.gen(function* () {
        const route = routes.get(profile)?.route;
        if (route === undefined) return yield* Effect.fail("That Machine is not in the Flock");
        return yield* githubLogin(route, (command) => {
          const terminal = inTerminal(command, process.platform, which);
          return terminal === null ? Effect.succeed(false) : launched(terminal);
        });
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    linearSetup: ({ profile }) =>
      Effect.gen(function* () {
        const route = routes.get(profile)?.route;
        if (route === undefined)
          return yield* new ActionFailed({ reason: "That Machine is not in the Flock" });
        const busy = onboarding.get(profile);
        if (busy !== undefined) return busy.job;
        const job = yield* uuid;
        yield* onboardAs(job, route, NOT_STARTED, [], "linear");
        return job;
      }),
    cleanup: ({ profile }) => cleanupOn(doors, profile),
    sweep: ({ installation, machine, request }) =>
      sweepOn(doors, { installation, machine }, request, logged),
    changeSchedule: ({ installation, change, name, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* uuid);
        const door = yield* doorTo(doors, installation);
        const changed = yield* changeScheduleOn(door, { change, name }, request);
        return changedLine(changed);
      }),
    moveSchedule: ({ from, to, name, checkout, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* uuid);
        const unreachable = (installation: string) =>
          doorTo(doors, installation).pipe(
            Effect.mapError(
              () =>
                new ActionFailed({
                  request,
                  reason: `machine_unreachable: ${installation} is not connected. Nothing was moved.`,
                }),
            ),
          );
        return yield* moveScheduleOn(
          {
            from: yield* unreachable(from),
            to: yield* unreachable(to),
            name,
            checkout,
          },
          request,
        );
      }),
    runFile: ({ installation, runId, ref, offset }) =>
      doorTo(doors, installation).pipe(
        Effect.flatMap((door) => runFileOn(door, runId, ref, offset)),
      ),
    stage: (part) =>
      stageAttachment(own, part).pipe(
        Effect.mapError(
          (cause) =>
            new ActionFailed({
              reason: cause._tag === "AttachmentRefused" ? cause.reason : cause.message,
            }),
        ),
        Effect.provide(BunServices.layer),
      ),
    stagePaths: ({ paths }) => stagedFrom(paths),
    pickFiles: () =>
      Effect.promise(() =>
        Utils.openFileDialog({ canChooseDirectory: false, allowsMultipleSelection: true }),
      ).pipe(Effect.flatMap((paths) => stagedFrom(Arr.filter(paths, (path) => path !== "")))),
    clipboardFiles: () =>
      Effect.sync(() =>
        Utils.clipboardAvailableFormats().includes("files")
          ? (Utils.clipboardReadText() ?? "")
          : "",
      ).pipe(Effect.flatMap((text) => stagedFrom(clipboardPaths(text)))),
    attachmentFile: ({ id, offset }) =>
      readAttachment(own, id, offset).pipe(
        Effect.mapError(
          (cause) =>
            new ActionFailed({
              reason: cause._tag === "AttachmentRefused" ? cause.reason : cause.message,
            }),
        ),
        Effect.provide(BunServices.layer),
      ),
    say: ({ text, about, now, attachments }) =>
      Stream.unwrap(
        Effect.map(chat, (opened) =>
          Result.match(opened, {
            onSuccess: (conversation) =>
              conversation.send(text, about, now === true, attachments ?? []),
            onFailure: (cause) =>
              Stream.make(refusal(`The Flock chat could not start: ${String(cause)}`)),
          }),
        ),
      ),
    answer: ({ toolCallId, answers }) =>
      withChat((opened) => opened.answer(toolCallId, answers), undefined),
    transcript: () => withChat((opened) => opened.transcript, []),
    conversations: () => withChat((opened) => opened.conversations, { current: "", earlier: [] }),
    reopen: ({ conversation }) =>
      withChat((opened) => opened.reopen(conversation), null).pipe(
        Effect.flatMap((refused) =>
          refused === null ? Effect.void : Effect.fail(new ActionFailed({ reason: refused })),
        ),
      ),
    // Annotated because it serves its own window through `servedOn`, which needs these handlers.
    popOut: (): Effect.Effect<
      void,
      never,
      SecureRandom.SecureRandom | Digest.Digest | FileSystem.FileSystem | Path.Path
    > =>
      Effect.gen(function* () {
        if (popped === undefined) {
          const opened = windowOn(`${VIEW}#chat`, "Flock chat", {
            width: 480,
            height: 800,
            x: 1340,
            y: 80,
          });
          const closed = Deferred.makeUnsafe<void>();
          opened.window.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
          popped = { window: opened.window, closed };
          yield* zoomed(opened.window, "Flock chat");
          yield* Layer.launch(servedOn(opened.channel)).pipe(
            Effect.raceFirst(Deferred.await(closed)),
            Effect.ensuring(Effect.sync(() => (popped = undefined))),
            Effect.forkIn(scope),
          );
        } else popped.window.activate();
        yield* Deferred.await(popped.closed);
      }),
    popIn: () => Effect.sync(() => popped?.window.close()),
    conversationChanges: () =>
      Stream.unwrap(withChat((opened) => Effect.succeed(opened.changed), Stream.empty)),
    desktopTurns: () =>
      Stream.unwrap(withChat((opened) => Effect.succeed(opened.desktopTurns), Stream.empty)),
    settings: () => desktop.changes,
    chatChoices: () =>
      Stream.unwrap(withChat((opened) => Effect.succeed(opened.choices), Stream.empty)),
    drawn: () => SubscriptionRef.changes(drawn).pipe(Stream.filter((now) => now !== null)),
    setSettings: saveSettings,
    recordMark: (mark) =>
      settings().recordTiming === true
        ? Effect.flatMap(FileSystem.FileSystem, (fs) =>
            fs.writeFileString(`${own}/record-timing.log`, `${JSON.stringify(mark)}\n`, {
              flag: "a",
            }),
          ).pipe(Effect.ignore)
        : Effect.void,
  });
  const servedOn = (channel: Channel<ToView, ToMain>) =>
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(channel))),
    );
  return yield* Layer.launch(servedOn(board.channel));
}).pipe(Effect.scoped, Effect.provide(platformLayer));

// A Mac sends Cmd+C, Cmd+V, Cmd+Q and the rest through its menu bar, which is empty until set.
if (process.platform === "darwin")
  Electrobun.ApplicationMenu.setApplicationMenu(applicationMenu(process.platform));

// Quitting may end the process before any scope closes, and an SSH master would outlive it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
