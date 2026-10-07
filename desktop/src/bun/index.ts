// Desktop's main process: one window on the view, every Machine's board relayed to it as
// Effect RPC over Electrobun's message channel, and the Flock chat beside them.

import { homedir, hostname, tmpdir } from "node:os";
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
  Path,
  PubSub,
  Queue,
  Result,
  Schema,
  Scope,
  Semaphore,
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
  applyItem,
  CREDENTIALS,
  type Credentials,
  DesktopRpcs,
  type DesktopSettingsChange,
  EMPTY_FLOCK,
  type FlockItem,
  type KnownMachine,
  machineRows,
  type MachineSynced,
  nameAsShown,
  type OnboardRun,
  type OnboardStep,
  Skippable,
  type TerminalCommand,
} from "../shared/flock";
import { RELEASE_PUBLIC_KEY } from "../../../src/signing";
import { pruneDesktop, sshControlsPrefix, sweepSshControls } from "../../../src/desktop";
import { appWindowFor } from "./browser";
import { clipboardPaths } from "../shared/attachments";
import { readAttachment, stageAttachment, stagePath } from "./attachments";
import { type FlockConversation, openFlockChat, refusal } from "./chat";
import { claudeCode } from "./claude";
import { chatDoor } from "./flock-tools";
import { readSettings, writeSettings } from "./settings";
import { flockSync, readFlockSettings, writeFlockSettings } from "./flock-settings";
import { editSetting } from "../shared/flock-settings";
import { nowIso } from "../../../src/time";
import { SettingValue, settingText } from "../../../src/settings";
import { isString } from "../../../src/schema";
import {
  act,
  type Doors,
  doorTo,
  focusOn,
  offersOn,
  runDetailOn,
  runFileOn,
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
  syncNow,
} from "./machine";
import { givenCredentials } from "./given";
import { inSync } from "../shared/in-sync";
import { attachCommand, inTerminal, launched, openTerminal, shellLine } from "./terminal";
import { addToHerdr, doctorOn, NOT_STARTED, onboardThrough, RELEASES, tracked } from "./onboarding";
import {
  claudeLoginThrough,
  GITLAB,
  giveHelle,
  giveToken,
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
import { electrobunUpdater } from "./electrobun-updater";
import {
  dropBoardsOf,
  dropOnboarding,
  saveOnboarding,
  savedBoards,
  savedOnboardings,
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

/** Slack's own app where it opens, else its web client. */
const openSlack = Effect.gen(function* () {
  if (Bun.which("xdg-open") === null) return yield* openUrl(SLACK_WEB);
  // Never killed: still running is the app taking it.
  const child = Bun.spawn(["xdg-open", SLACK_APP], { stdio: ["ignore", "ignore", "ignore"] });
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
  const updater = yield* electrobunUpdater;
  yield* applyAtLaunch(updater).pipe(
    Effect.catch((reason) => Effect.logWarning(`Desktop update not installed: ${reason}`)),
  );
  // Opened once an update readied before the last quit has had its chance to install, so
  // installing one never shows a window that closes again.
  const board = windowOn(VIEW, "Collie", { width: 1200, height: 800, x: 120, y: 80 });
  const updates = yield* updatesOf(updater, manifest.version);
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
  const own = (yield* Path.Path).join(yield* StateDir, "collie-desktop");
  // Started on this bundle, so every other staged update has been applied or passed over.
  yield* pruneDesktop({
    root: Utils.paths.userData,
    state: own,
    hash: yield* updater.hash,
    version: manifest.version,
  }).pipe(Effect.ignore);
  let settings = yield* readSettings(own);
  const saved = yield* readFlockSettings(own);
  // The GitLab host an earlier Desktop kept as its own becomes the Flock's.
  const seeded =
    settings.gitlabHost === undefined || saved.settings.gitlab_host !== undefined
      ? saved
      : editSetting(saved, "gitlab_host", settings.gitlabHost, yield* nowIso());
  const flockSettings = yield* SubscriptionRef.make("refused" in seeded ? saved : seeded);
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
    Effect.ignore,
    Effect.forkScoped,
  );
  const fs = yield* FileSystem.FileSystem;
  // Short, because a control socket's path is capped at about 100 bytes.
  // A Desktop that was killed left its own, and the masters in them, behind.
  yield* sweepSshControls(tmpdir()).pipe(Effect.ignore);
  const controls = yield* fs.makeTempDirectoryScoped({ prefix: sshControlsPrefix(process.pid) });
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
  const doors = new Map<string, Doors>();
  /** Keeps an edit made here, then gives it to every connected Machine. */
  const editFlock = (key: string, typed: string) =>
    Effect.gen(function* () {
      const edited = editSetting(
        yield* SubscriptionRef.get(flockSettings),
        key,
        typed,
        yield* nowIso(),
      );
      if ("refused" in edited) return yield* new ActionFailed({ reason: edited.refused });
      yield* writeFlockSettings(own, edited).pipe(
        Effect.mapError((error) => new ActionFailed({ reason: error.message })),
      );
      yield* SubscriptionRef.set(flockSettings, edited);
      yield* syncEvery().pipe(Effect.forkIn(scope));
      return edited;
    });
  const boards = `${Utils.paths.userData}/machines`;
  const onboardings = `${Utils.paths.userData}/onboarding`;
  const runners = `${Utils.paths.userData}/runners`;
  const scope = yield* Effect.scope;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie);
  /** Each route's latest settings sync, told again to a view that subscribes. */
  const synced = new Map<string, MachineSynced>();
  const settingsOf = (door: Doors) => ({
    name: door.machine.name,
    door: door.desktop,
    machine: door.machine,
  });
  // A Machine out of reach, or on a collie without the operation until it is upgraded, is
  // synced when it next connects.
  const { syncOn, syncEvery } = yield* flockSync({
    flock: flockSettings,
    machines: () => [...doors.values()].map(settingsOf),
    save: (flock) => writeFlockSettings(own, flock).pipe(Effect.provide(BunServices.layer)),
    request: uuid,
    told: ({ machine }, failed) =>
      Effect.suspend(() => {
        const item = { _tag: "Synced", machine, failed } as const;
        synced.set(machine.profile, item);
        return PubSub.publish(news, item);
      }).pipe(Effect.asVoid),
  });
  const firstFailure = (each: ReadonlyArray<{ readonly failed: string | null }>) =>
    each[0]?.failed ?? null;
  const given = yield* givenCredentials({
    dir: own,
    keyring,
    give: {
      gitlab: (route, text) => Effect.map(giveToken([route], gitlabHost(), text), firstFailure),
      helle: (route, text) => Effect.map(giveHelle([route], helle, text), firstFailure),
    },
    tell: (item) => PubSub.publish(news, item).pipe(Effect.asVoid),
    skipped: (profile) =>
      savedOnboardings(onboardings).pipe(
        Effect.map(
          (all) =>
            all
              .find((saved) => saved.machine.profile === profile)
              ?.run.steps.filter(({ status }) => status === "skipped")
              .map(({ step }) => step) ?? [],
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
  ) => {
    const { machine } = route;
    onboarding.set(machine.profile, { job });
    return Effect.gen(function* () {
      // Without its credentials file, a Machine is onboarded as far as it goes with none.
      const secrets = yield* secretsFor(keyring).pipe(Effect.orElseSucceed(() => ""));
      const handed = yield* given.held;
      const before = (yield* savedOnboardings(onboardings)).find(
        (saved) => saved.machine.profile === machine.profile,
      );
      const skip = Skippable.literals.filter(
        (step) =>
          skipping.includes(step) ||
          before?.run.steps.some((one) => one.step === step && one.status === "skipped"),
      );
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
      const unreached = skip
        .filter((step) => !run.steps.some((one) => one.step === step))
        .map((step): OnboardStep => ({ step, title: step, status: "skipped" }));
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
  const gave = (
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

  /** Desktop's own settings, one change at a time, as Settings and the Flock chat make them. */
  const settingsWrite = Semaphore.makeUnsafe(1);
  const saveSettings = (changed: DesktopSettingsChange) =>
    Effect.suspend(() => {
      const merged = { ...settings, ...changed };
      return writeSettings(own, merged).pipe(
        Effect.andThen(
          Effect.sync(() => {
            settings = merged;
          }),
        ),
      );
    }).pipe(settingsWrite.withPermits(1), Effect.orDie);

  /** Files named by path, each copied in or refused in words. */
  const stagedFrom = (paths: ReadonlyArray<string>) =>
    Effect.forEach(paths, (path) =>
      stagePath(own, path).pipe(
        Effect.catch((cause) => Effect.succeed({ refused: `${path}: ${cause.message}` })),
      ),
    ).pipe(Effect.provide(BunServices.layer));

  // The Flock as the board was last sent it, so the chat names its Machines as the cards do.
  let shown = EMPTY_FLOCK;
  // Opened by the view's first ask, in Desktop's own scope; its session starts with the first message.
  const chat = yield* openFlockChat({
    claude: claudeCode,
    dir: own,
    conversation: `flock@${local}`,
    proactive: () => settings.proactive,
    machineRule: () => settings.machineRule,
    setMachineRule: (machineRule) =>
      saveSettings({ machineRule }).pipe(Effect.provide(BunServices.layer)),
    machines: () => {
      const named = nameAsShown(shown);
      return [...doors].map(([installation, held]) => ({
        name: named({ ...held.machine, installation }),
        door: chatDoor(held.chat),
        local: held.machine.profile === "local",
      }));
    },
  }).pipe(Scope.provide(scope), Effect.result, Effect.cached);
  // ponytail: a chat that could not start stays so until Desktop restarts.
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

  const handlers = DesktopRpcs.toLayer({
    // Every board change may have left News, so each one nudges the chat to look.
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
                route === undefined ? Effect.void : given.giveLacking(route),
              ],
              { concurrency: "unbounded", discard: true },
            ).pipe(Effect.forkIn(scope));
          };
          shown = EMPTY_FLOCK;
          const before: ReadonlyArray<FlockItem> = [
            ...reachable.map(({ machine }): FlockItem => ({ _tag: "Routed", machine })),
            ...(yield* savedBoards(boards)).filter(listed),
            ...(yield* savedOnboardings(onboardings)).filter(listed),
            ...(yield* given.states(reachable.map(({ machine }) => machine))),
            ...[...synced.values()].filter(listed),
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
        Stream.tap((item) => Effect.sync(() => void (shown = applyItem(shown, item)))),
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
    flockSettings: () =>
      Stream.unwrap(
        syncEvery().pipe(Effect.forkIn(scope), Effect.as(SubscriptionRef.changes(flockSettings))),
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
    saveGitlab: ({ token }) =>
      Effect.gen(function* () {
        const said = token.trim();
        if (!oneLine(said)) return yield* Effect.fail("a token is one line");
        const { expires } = yield* gitlabToken(gitlab(), said);
        yield* keyring.store("gitlab-token", `Collie's GitLab token for ${gitlabHost()}`, said);
        yield* SubscriptionRef.update(credentials, (now) => ({ ...now, gitlab: { expires } }));
        return gave("GitLab token", yield* given.giveEvery(everyRoute(), "gitlab", said));
      }).pipe(Effect.mapError((reason) => new ActionFailed({ reason }))),
    saveGitlabHost: ({ host }) =>
      Effect.gen(function* () {
        const named = host.trim();
        if (!isHostName(named))
          return yield* Effect.fail(`"${named}" is not a host name, such as gitlab.example.com`);
        if (named === gitlabHost()) return `GitLab is ${named} already`;
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
      helleOwner(helle, token.trim()).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
      ),
    openSlack: () => openSlack,
    copyText: ({ text }) => Effect.sync(() => Utils.clipboardWriteText(text)),
    saveHelle: ({ token }) =>
      Effect.gen(function* () {
        const said = token.trim();
        if (!oneLine(said)) return yield* Effect.fail("a token is one line");
        yield* helleOwner(helle, said);
        yield* keyring.store("helle-token", "Collie's Helle token", said);
        yield* SubscriptionRef.update(credentials, (now) => ({ ...now, helle: true }));
        return gave("Helle's token", yield* given.giveEvery(everyRoute(), "helle", said));
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
          given.drop(profile),
        ]).pipe(Effect.provide(BunServices.layer));
        return `Removed ${known.route.machine.name}`;
      }),
    syncNow: ({ profile }) =>
      Effect.gen(function* () {
        const route = routes.get(profile)?.route;
        const row = machineRows(shown).find((one) => one.profile === profile);
        if (route === undefined || row === undefined)
          return yield* new ActionFailed({ reason: "that Machine is not in herdr's list" });
        const texts = yield* given.held;
        const held = CREDENTIALS.filter((one) => texts[one] !== undefined);
        const { behind } = inSync(row, { version: manifest.version, credentials: held });
        const door = [...doors.values()].find((one) => one.machine.profile === profile);
        const parts = behind.map(({ part }) => part);
        return yield* syncNow(route.machine, parts, {
          reopen: PubSub.publish(changes, { _tag: "Reopen", profile }),
          sync:
            door === undefined
              ? Effect.succeed("it isn't connected; it is synced when it connects")
              : syncOn(settingsOf(door)),
          give: given.giveLacking(route),
        });
      }),
    act: ({ installation, action, request: again }) =>
      Effect.gen(function* () {
        const request = again ?? (yield* uuid);
        const door = yield* doorTo(doors, installation).pipe(
          Effect.mapError((failed) => new ActionFailed({ reason: failed.reason, request })),
        );
        return yield* act(door.desktop, request, action);
      }),
    goToPane: ({ installation, runId }) =>
      Effect.gen(function* () {
        const door = yield* doorTo(doors, installation);
        const at = yield* focusOn(door.desktop, yield* uuid, runId);
        const attach = attachCommand(door.machine.target, at.session);
        const terminal = inTerminal(attach, process.platform, Bun.which);
        const opened = terminal !== null && (yield* launched(terminal));
        return { at, command: shellLine(attach), opened };
      }),
    terminal: ({ installation, runId, cols, rows }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const door = yield* doorTo(doors, installation);
          const route = routes.get(door.machine.profile)?.route;
          if (route === undefined)
            return yield* new ActionFailed({ reason: "that Machine is not connected" });
          const request = yield* uuid;
          const opened = yield* openTerminal(
            focusOn(door.desktop, request, runId),
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
            Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref(),
          ),
        ),
        Effect.catch(() => openUrl(url)),
      ),
    offers: ({ installation, runId }) =>
      doorTo(doors, installation).pipe(Effect.flatMap((door) => offersOn(door.desktop, runId))),
    workflows: ({ installation, project }) =>
      doorTo(doors, installation).pipe(
        Effect.flatMap((door) => workflowsOn(door.desktop, project)),
      ),
    updates: () => Stream.map(updates.news, (news) => ({ version: manifest.version, news })),
    checkForUpdates: () => updates.check,
    restart: () =>
      restartToUpdate(updater).pipe(
        Effect.mapError((reason) => new ActionFailed({ reason })),
        Effect.provide(BunServices.layer),
      ),
    runDetail: ({ installation, runId }) =>
      Stream.unwrap(
        Effect.map(doorTo(doors, installation), (door) => runDetailOn(door.desktop, runId)),
      ),
    runFile: ({ installation, runId, ref, offset }) =>
      doorTo(doors, installation).pipe(
        Effect.flatMap((door) => runFileOn(door.desktop, runId, ref, offset)),
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
      ).pipe(Effect.flatMap((paths) => stagedFrom(paths.filter((path) => path !== "")))),
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
    reopen: ({ session }) => withChat((opened) => opened.reopen(session), undefined),
    // Annotated because it serves its own window through `servedOn`, which needs these handlers.
    popOut: (): Effect.Effect<void, never, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
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
          yield* Layer.launch(servedOn(opened.channel)).pipe(
            Effect.raceFirst(Deferred.await(closed)),
            Effect.ensuring(Effect.sync(() => (popped = undefined))),
            Effect.forkIn(scope),
          );
        } else popped.window.activate();
        yield* Deferred.await(popped.closed);
      }),
    popIn: () => Effect.sync(() => popped?.window.close()),
    desktopTurns: () =>
      Stream.unwrap(withChat((opened) => Effect.succeed(opened.desktopTurns), Stream.empty)),
    settings: () => Effect.sync(() => settings),
    setSettings: saveSettings,
  });
  const servedOn = (channel: Channel<ToView, ToMain>) =>
    RpcServer.layer(DesktopRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(channel))),
    );
  return yield* Layer.launch(servedOn(board.channel));
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

// Quitting may end the process before any scope closes, and an SSH master would outlive it.
Electrobun.events.on("before-quit", endChildren);
process.on("exit", endChildren);

BunRuntime.runMain(main);
