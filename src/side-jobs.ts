// What the host does on its own, whether or not anyone is looking: the merge watch, each
// Herd's News, the cleanup sweep, and the board and chat terminals kept running.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, Effect, FileSystem, Schedule, Stream, type Duration } from "effect";
import type { TaskView, MrState, Reopened } from "./board-model";
import { readyRuns } from "./board";
import { CHAT_TERMINAL, startChat } from "./chat";
import { gitlabHostOf, loadDefaults } from "./config";
import { currentReports, readDrift } from "./drift";
import { selfCommand, type PluginEnv } from "./env";
import { coreSocket } from "./hc";
import type { Herdr } from "./herdr";
import { SESSIONS_EVERY, liveHerds, type LiveHerd } from "./herds";
import { landingNow } from "./landing";
import { settleMerges, type MrPanels } from "./merges";
import { settleWatches, type Watches } from "./mr-watch";
import { startRequested, type Requested } from "./review-requests";
import { shell } from "./mr";
import { append as appendNews, newsPath, read as readNews, retired, supersede } from "./news";
import { disputesIn, eventsIn, holding, idleAgain, readSaid, remember } from "./proactive";
import { latest, readDispositions } from "./disposition";
import { readSeen } from "./seen";
import { settled, type RunFacts } from "./runs";
import { herdDir, machineHerd } from "./steering";
import { listTasks } from "./task";
import { nowIso } from "./time";
import { sweep, sweeping, type Sweeper } from "./cleanup";
import { keepDiffs } from "./run-detail";
import { Artefacts } from "./artefacts";
import { ModuleRevisions } from "./module-revisions";
import { Branches, branchKey, readBranch, type Branch, type BranchRun } from "./branches";
import { ConnectionRows } from "./connection-rows";
import { connectionOnMachine } from "./connections";
import { revisionOf } from "./engine";

/** The Runs still going whose drift was escalated to the human, by constraint. */
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

/**
 * What happened to one Herd's Runs, written down for its conversation to pick up. No
 * model is called: an unchanged Herd finds no events and writes nothing.
 */
const sayWhatHappened = Effect.fn("SideJobs.sayWhatHappened")(function* (
  stateDir: string,
  key: string,
  runs: ReadonlyArray<RunFacts>,
  views: ReadonlyArray<TaskView>,
  /** Reopened Runs whose agent has finished what it was told, by Run. */
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
    // Remembered only once it is in the journal, so a failed write is retried next round.
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

/** The finished Runs whose work has a disposition, or that someone has seen. */
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

/** Each Herd's News from its own Runs; a Run whose Task records no Herd is the host's own Herd's. */
const news = Effect.fn("SideJobs.news")(function* (
  env: PluginEnv,
  sessions: ReadonlyArray<LiveHerd>,
  runs: ReadonlyArray<RunFacts>,
  views: ReadonlyArray<TaskView>,
  done: ReadonlyMap<string, Reopened>,
) {
  if (!(yield* loadDefaults(env.userDir)).proactive) return;
  // Unread Tasks would put every Run in the host's own Herd and retire the rest's News.
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

/** One job, again and again for as long as the host runs; a round that fails is skipped. */
const every = <E, R>(spaced: Duration.Input, round: Effect.Effect<unknown, E, R>) =>
  round.pipe(
    Effect.catchCause((cause) => Effect.logWarning("a side job's round failed", cause)),
    Effect.repeat(Schedule.spaced(spaced)),
    Effect.asVoid,
  );

/** How often News looks again, and the diffs of Runs that just ended are kept. */
const LOOK_EVERY = "5 seconds";
/** How often the merge watch looks; a forge is asked about a merge request every 5 minutes whatever this is. */
const MERGES_EVERY = "10 seconds";
/** How long after one cleanup sweep ends the next begins (ADR-0045). */
const SWEEP_EVERY = "10 minutes";
/**
 * How often what the host keeps is read again for a change made outside Collie, which
 * nothing else tells it of (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs).
 */
export const BACKSTOP_EVERY = "5 minutes";
const BACKSTOP_MS = 5 * 60_000;
/**
 * The Connection syncer: each Connection a listing asked for and none read yet, at once; every
 * one kept, on the backstop poll. A listing's offers read only these rows.
 */
export const connectionSync = (env: PluginEnv) =>
  every(
    GIT_SYNC_EVERY,
    Effect.gen(function* () {
      const rows = yield* ConnectionRows;
      const now = yield* Clock.currentTimeMillis;
      for (const at of yield* rows.wanted)
        if (at.read === 0 || now - at.read >= BACKSTOP_MS)
          yield* rows.put(at, yield* connectionOnMachine({ ...env, cwd: at.cwd }, at.id), now);
    }),
  );

/** How often the git syncer looks for cards that moved, whose branches it reads again. */
const GIT_SYNC_EVERY = "2 seconds";
/** A git round slower than this is logged, so a stuck checkout is visible. */
const GIT_SLOW_MS = 5_000;

/**
 * The git syncer: the branch of each Run on a card that moved, which a turn, a Step's end, a
 * publish or a push does, read again, and each a build found no row of; every live card's on
 * the backstop poll. A card's
 * derivation reads only what this kept (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs).
 */
export const gitSync = <E, R>(
  board: Effect.Effect<
    { readonly runs: ReadonlyArray<RunFacts>; readonly views: ReadonlyArray<TaskView> },
    E,
    R
  >,
  recover: (runId: string) => Effect.Effect<void> = () => Effect.void,
) => {
  /** Each card's revision when its branches were last read. */
  const seen = new Map<string, string>();
  let backstopAt = Number.NEGATIVE_INFINITY;
  return every(
    GIT_SYNC_EVERY,
    Effect.gen(function* () {
      const { runs, views } = yield* board;
      const start = yield* Clock.currentTimeMillis;
      const backstop = start - backstopAt >= BACKSTOP_MS;
      if (backstop) backstopAt = start;
      const byId = new Map(Arr.map(runs, (run) => [run.id, run] as const));
      const branches = yield* Branches;
      const due = new Map<string, BranchRun>(
        Arr.map(yield* branches.wanted, (run) => [branchKey(run.cwd, run.branch), run]),
      );
      const moved = new Set<string>();
      for (const view of views) {
        const at = `${view.revision?.epoch ?? ""}:${view.revision?.seq ?? ""}`;
        if (!backstop && seen.get(view.id) === at) continue;
        seen.set(view.id, at);
        for (const id of view.runs) {
          const run = byId.get(id);
          if (run === undefined) continue;
          due.set(branchKey(run.cwd, run.branch), run);
          moved.add(run.id);
        }
      }
      if (due.size === 0) return;
      const read = new Map<string, Branch>();
      for (const [key, run] of due) read.set(key, yield* readBranch(run));
      yield* branches.put(read);
      for (const run of moved) yield* recover(run);
      const took = (yield* Clock.currentTimeMillis) - start;
      if (took >= GIT_SLOW_MS)
        yield* Effect.logWarning(`git sync read ${due.size} branches in ${took} ms`);
    }),
  );
};

/** The host's own cleanup sweep, ten minutes after it starts and after each one ends. */
export const sweepEvery = <E, R>(
  stateDir: string,
  sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>,
) =>
  Effect.sleep(SWEEP_EVERY).pipe(
    Effect.andThen(every(SWEEP_EVERY, sweeping.withPermit(sweep(sweepers, stateDir, "host")))),
  );

/** The core terminal this Machine's board runs in, and what `hc attach` reaches it by. */
export const BOARD_TERMINAL = "collie-board";

/**
 * How long after a round that left the board or chat unstarted the next may begin: a
 * second, doubling with each round that fails again, up to five minutes.
 */
export const keepAgainAfter = (failures: number) =>
  Math.min(1_000 * 2 ** Math.max(failures - 1, 0), 5 * 60_000);

/** How often a round that is waiting to be tried again looks whether its wait is over. */
const KEEP_RETRY_TICK = "1 second";

/**
 * The board and chat, each a core terminal of its own on this Machine whatever runs its
 * agents: started when core is first followed, and again whenever either has ended.
 *
 * A start core refuses is tried again after `keepAgainAfter`, never on the next tick:
 * core says a terminal it could not start was removed, so retrying on that tick starts
 * again at once, forever, and the host does nothing else
 * ([Agents on core](../docs/internals.md#agents-on-core)).
 */
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
        // Healthy, the timer asks nothing of core; after a failure, nothing does until the wait ends.
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

/** One look at the board and chat, starting whichever is not live: whether both now are. */
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

/**
 * The merge watch, every `MERGES_EVERY` until the host stops: each Task's merge request is
 * read when its answer is due, and the Runs watching one are judged on what was read.
 */
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
  readonly nudged?: Set<string>;
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
        nudged: opts.nudged,
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

/** Every side job, run until the host stops. */
export const sideJobs = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  /** The host's latest board, and the Runs it was built from. */
  readonly board: Effect.Effect<
    { readonly runs: ReadonlyArray<RunFacts>; readonly views: ReadonlyArray<TaskView> },
    E,
    R
  >;
  readonly panels: MrPanels;
  /** Records a merge request the watch found from a branch as that Run's own. */
  readonly record: (runId: string, url: string) => Effect.Effect<void>;
  /** The host's audited stop, for what a merge settled. */
  readonly stop: (runId: string, reason: string) => Effect.Effect<void>;
  readonly watches: Watches;
  readonly requested: Requested;
  readonly sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>;
  /** Merge requests a Run just pushed to, which the merge watch reads on its next round. */
  readonly nudged?: Set<string>;
  /** Reads from git what a follow-up of a Run would enter at. */
  readonly recover?: (runId: string) => Effect.Effect<void>;
}) => {
  const { env, herdr } = opts;
  const kept = new Set<string>();
  /** Steers to Reopened Runs seen being worked on. */
  const workedOn = new Set<string>();
  /** Reopened Runs whose agent has since finished; the said journal keeps each to one item. */
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
        gitSync(opts.board, opts.recover),
        connectionSync(env),
        every(
          BACKSTOP_EVERY,
          Effect.gen(function* () {
            const revisions = yield* ModuleRevisions;
            for (const dir of (yield* revisions.all).keys())
              yield* revisions.put(dir, yield* revisionOf(dir));
          }),
        ),
        keepTerminals(env, herdr),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  );
};
