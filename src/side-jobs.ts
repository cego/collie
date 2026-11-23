import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, Effect, FileSystem, Schedule, Stream } from "effect";
import type { Duration } from "effect";
import type { TaskView, MrState, Reopened } from "./board-model";
import { readyRuns } from "./board";
import { CHAT_TERMINAL, startChat } from "./chat";
import { gitlabHostOf, loadDefaults } from "./config";
import { currentReports, readDrift } from "./drift";
import { selfCommand } from "./env";
import type { PluginEnv } from "./env";
import { coreSocket } from "./hc";
import type { Herdr } from "./herdr";
import { SESSIONS_EVERY, liveHerds } from "./herds";
import type { LiveHerd } from "./herds";
import { landingNow } from "./landing";
import { settleMerges } from "./merges";
import type { MrPanels } from "./merges";
import { settleWatches } from "./mr-watch";
import type { Watches } from "./mr-watch";
import { startRequested } from "./review-requests";
import type { Requested } from "./review-requests";
import { shell } from "./mr";
import { append as appendNews, newsPath, read as readNews, retired, supersede } from "./news";
import { disputesIn, eventsIn, holding, idleAgain, readSaid, remember } from "./proactive";
import { latest, readDispositions } from "./disposition";
import { readSeen } from "./seen";
import { settled } from "./runs";
import type { RunFacts } from "./runs";
import { herdDir, machineHerd } from "./steering";
import { listTasks } from "./task";
import { nowIso } from "./time";
import { sweep, sweeping } from "./cleanup";
import type { Sweeper } from "./cleanup";
import { keepDiffs } from "./run-detail";
import { Artefacts } from "./artefacts";

const escalatedDrift = Effect.fn("SideJobs.escalatedDrift")(function* (
  runs: ReadonlyArray<RunFacts>,
) {
  const drifting = new Map<string, string>();
  for (const run of runs) {
    if (settled(run)) continue;
    const lines = yield* readDrift(run.dir).pipe(Effect.orElseSucceed(() => []));
    const stuck = Option.getOrUndefined(
      Arr.findFirst(currentReports(lines), (report) => report.resolution === "escalated"),
    );
    if (stuck) drifting.set(run.id, stuck.constraint);
  }
  return drifting;
});

const sayWhatHappened = Effect.fn("SideJobs.sayWhatHappened")(function* (
  stateDir: string,
  key: string,
  runs: ReadonlyArray<RunFacts>,
  views: ReadonlyArray<TaskView>,
  done: ReadonlyMap<string, Reopened>,
) {
  const dir = yield* herdDir(stateDir, key);
  const said = yield* readSaid(dir);
  const file = yield* newsPath(stateDir, key);
  const drifting = yield* escalatedDrift(runs);
  const ready = readyRuns(views);
  const gone = retired(yield* readNews(file));
  const disputes = yield* disputesIn(runs);
  const held = holding(runs, drifting, yield* disposed(runs), ready, done);
  for (const event of disputes) held.add(event.key);
  for (const event of [...eventsIn(runs, drifting, ready, done), ...disputes]) {
    if (!held.has(event.key) || (said.has(event.key) && !gone.has(event.key))) continue;
    // WARNING: remembered only once it is in the journal, so a failed write is retried next round.
    const queued = yield* appendNews(file, {
      key: event.key,
      run: event.run,
      text: event.text,
      significance: event.significance,
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (queued !== null) yield* remember(dir, event.key, yield* nowIso);
  }
  yield* supersede(
    file,
    (item) => Str.startsWith("recovery-failing:")(item.key) || held.has(item.key),
  );
});

const disposed = Effect.fn("SideJobs.disposed")(function* (runs: ReadonlyArray<RunFacts>) {
  const out = new Set<string>();
  for (const run of runs) {
    if (!settled(run)) continue;
    const lines = yield* readDispositions(run.dir).pipe(Effect.orElseSucceed(() => []));
    const seen = yield* readSeen(run.dir).pipe(Effect.orElseSucceed(() => []));
    if (latest(lines) !== null || seen.length > 0) out.add(run.id);
  }
  return out;
});

const news = Effect.fn("SideJobs.news")(function* (
  env: PluginEnv,
  sessions: ReadonlyArray<LiveHerd>,
  runs: ReadonlyArray<RunFacts>,
  views: ReadonlyArray<TaskView>,
  done: ReadonlyMap<string, Reopened>,
) {
  if (!(yield* loadDefaults(env.userDir)).proactive) return;
  // WARNING: unread Tasks would put every Run in the host's own Herd and retire the rest's News.
  const herdOfTask = new Map(Arr.map(yield* listTasks, (task) => [task.id, task.herd ?? null]));
  const own = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  for (const { herd } of sessions) {
    if (herd === null) continue;
    const mine = Arr.filter(
      runs,
      (run) => ((run.task === null ? null : herdOfTask.get(run.task)) ?? own) === herd,
    );
    yield* sayWhatHappened(env.stateDir, herd, mine, views, done);
  }
});

const every = <E, R>(spaced: Duration.Input, round: Effect.Effect<unknown, E, R>) =>
  round.pipe(
    Effect.catchCause((cause) => Effect.logWarning("a side job's round failed", cause)),
    Effect.repeat(Schedule.spaced(spaced)),
    Effect.asVoid,
  );

const LOOK_EVERY = "5 seconds";
// WARNING: a forge is asked about a merge request every 5 minutes whatever this is.
const MERGES_EVERY = "10 seconds";
const SWEEP_EVERY = "10 minutes";

export const sweepEvery = <E, R>(
  stateDir: string,
  sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>,
) =>
  Effect.sleep(SWEEP_EVERY).pipe(
    Effect.andThen(every(SWEEP_EVERY, sweeping.withPermit(sweep(sweepers, stateDir, "host")))),
  );

export const BOARD_TERMINAL = "collie-board";

export const keepAgainAfter = (failures: number) =>
  Math.min(1000 * 2 ** Math.max(failures - 1, 0), 5 * 60_000);

const KEEP_RETRY_TICK = "1 second";

// WARNING: a refused start is retried after keepAgainAfter, not on the next tick: core reports it removed, so that loops forever.
export const keepTerminals = (env: PluginEnv, herdr: Herdr) =>
  Effect.gen(function* () {
    let failures = 0;
    let notBefore = 0;
    const ticks = Stream.merge(
      Stream.map(herdr.terminalsEnded(), () => "ended" as const),
      Stream.map(Stream.tick(KEEP_RETRY_TICK), () => "waited" as const),
    );
    yield* Stream.runForEach(ticks, (tick) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (tick === "waited" && failures === 0) return;
        if (now < notBefore) return;
        if (yield* keepRound(env, herdr)) {
          failures = 0;
          notBefore = 0;
          return;
        }
        failures += 1;
        notBefore = now + keepAgainAfter(failures);
      }),
    );
  });

const keepRound = (env: PluginEnv, herdr: Herdr) =>
  Effect.gen(function* () {
    const key = yield* machineHerd(env);
    const cwd = yield* herdDir(env.stateDir, key);
    yield* (yield* FileSystem.FileSystem).makeDirectory(cwd, { recursive: true });
    if (!(yield* herdr.terminalLive(BOARD_TERMINAL)))
      yield* herdr.agentLaunch({
        name: BOARD_TERMINAL,
        argv: [...selfCommand(), "board", "--draw"],
        cwd,
        env: {
          COLLIE_ROOT: env.pluginRoot,
          COLLIE_DIR: env.collieDir,
          COLLIE_USER_DIR: env.userDir,
          COLLIE_STATE_DIR: env.stateDir,
          HC_SOCKET: yield* coreSocket(env.raw),
          COLLIE_CWD: cwd,
        },
        labels: {},
      });
    if (!(yield* herdr.terminalLive(CHAT_TERMINAL)))
      return (
        (yield* startChat(herdr, env, key, (line) => Effect.logInfo(line))).kind === "launched"
      );
    return true;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not keep the board and chat terminals", cause).pipe(
        Effect.as(false),
      ),
    ),
  );

export const mergeWatch = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly board: Effect.Effect<
    { readonly runs: ReadonlyArray<RunFacts>; readonly views: ReadonlyArray<TaskView> },
    E,
    R
  >;
  readonly panels: MrPanels;
  readonly record: (runId: string, url: string) => Effect.Effect<void>;
  readonly stop: (runId: string, reason: string) => Effect.Effect<void>;
  readonly watches: Watches;
  readonly requested: Requested;
}) => {
  const checked = new Map<string, number>();
  const states = new Map<string, MrState>();
  const logins = new Map<string, string>();
  return every(
    MERGES_EVERY,
    Effect.gen(function* () {
      const { runs, views } = yield* opts.board;
      const gitlabHost = yield* gitlabHostOf(opts.env);
      yield* settleMerges({
        stateDir: opts.env.stateDir,
        cwd: opts.env.cwd,
        run: shell,
        views,
        runs,
        record: opts.record,
        stop: opts.stop,
        gitlabHost,
        now: yield* Clock.currentTimeMillis,
        checked,
        states,
        panels: opts.panels,
        making: landingNow,
      });
      yield* settleWatches({
        panels: opts.panels,
        now: yield* Clock.currentTimeMillis,
        watches: opts.watches,
      });
      yield* startRequested({
        env: opts.env,
        gitlabHost,
        logins,
        requested: opts.requested,
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("could not list review requests", cause)),
      );
    }),
  );
};

export const sideJobs = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly board: Effect.Effect<
    { readonly runs: ReadonlyArray<RunFacts>; readonly views: ReadonlyArray<TaskView> },
    E,
    R
  >;
  readonly panels: MrPanels;
  readonly record: (runId: string, url: string) => Effect.Effect<void>;
  readonly stop: (runId: string, reason: string) => Effect.Effect<void>;
  readonly watches: Watches;
  readonly requested: Requested;
  readonly sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>;
}) => {
  const { env, herdr } = opts;
  const kept = new Set<string>();
  const workedOn = new Set<string>();
  const finishedTold = new Map<string, Reopened>();
  return Effect.flatMap(Effect.cachedWithTTL(liveHerds(herdr, env), SESSIONS_EVERY), (herds) =>
    Effect.all(
      [
        every(
          "30 seconds",
          Effect.gen(function* () {
            const catalogue = yield* Artefacts;
            const { runs } = yield* opts.board;
            yield* catalogue.pass(runs);
          }),
        ),
        mergeWatch(opts),
        every(
          LOOK_EVERY,
          Effect.gen(function* () {
            const { runs, views } = yield* opts.board;
            for (const [run, done] of idleAgain(views, workedOn)) finishedTold.set(run, done);
            yield* news(env, yield* herds, runs, views, finishedTold);
            yield* keepDiffs(runs, kept);
          }),
        ),
        sweepEvery(env.stateDir, opts.sweepers),
        keepTerminals(env, herdr),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  );
};
