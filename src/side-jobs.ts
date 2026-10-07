// What the host does on its own, whether or not a pane is open: the merge watch, each
// Herd's News, the cleanup sweep and keeping each Herd's Home tokened.

import { Clock, Effect, Schedule, type Duration } from "effect";
import type { TaskView, MrState, Reopened } from "./board-model";
import { readyRuns } from "./board";
import { loadDefaults } from "./config";
import { currentReports, readDrift } from "./drift";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";
import { liveHerds } from "./herds";
import { homeDeps, restateHome, type HomeDeps } from "./home";
import { settleMerges, type MrPanels } from "./merges";
import { shell } from "./mr";
import { append as appendNews, newsPath, read as readNews, retired, supersede } from "./news";
import { eventsIn, holding, idleAgain, readSaid, remember } from "./proactive";
import { latest, readDispositions } from "./disposition";
import { settled, type RunFacts } from "./runs";
import { herdDir, herdOf } from "./steering";
import { listTasks } from "./task";
import { nowIso } from "./time";
import { sweep, sweeping, type Sweeper } from "./cleanup";
import { keepDiffs } from "./run-detail";

/** The Runs still going whose drift was escalated to the human, by constraint. */
const escalatedDrift = Effect.fn("SideJobs.escalatedDrift")(function* (
  runs: ReadonlyArray<RunFacts>,
) {
  const drifting = new Map<string, string>();
  for (const run of runs) {
    if (settled(run)) continue;
    const lines = yield* readDrift(run.dir).pipe(Effect.catch(() => Effect.succeed([])));
    const stuck = currentReports(lines).find((report) => report.resolution === "escalated");
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
  const held = holding(runs, drifting, yield* disposed(runs), ready, done);
  for (const event of eventsIn(runs, drifting, ready, done)) {
    if (!held.has(event.key) || (said.has(event.key) && !gone.has(event.key))) continue;
    // Remembered only once it is in the journal, so a failed write is retried next round.
    const queued = yield* appendNews(file, {
      key: event.key,
      run: event.run,
      text: event.text,
      significance: event.significance,
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (queued !== null) yield* remember(dir, event.key, yield* nowIso());
  }
  yield* supersede(file, (item) => held.has(item.key));
});

/** The finished Runs whose work has a disposition. */
const disposed = Effect.fn("SideJobs.disposed")(function* (runs: ReadonlyArray<RunFacts>) {
  const out = new Set<string>();
  for (const run of runs) {
    if (!settled(run)) continue;
    const lines = yield* readDispositions(run.dir).pipe(Effect.orElseSucceed(() => []));
    if (latest(lines) !== null) out.add(run.id);
  }
  return out;
});

/** Each Herd's News from its own Runs; a Run whose Task records no Herd is the host's own Herd's. */
const news = Effect.fn("SideJobs.news")(function* (
  env: PluginEnv,
  herdr: Herdr,
  runs: ReadonlyArray<RunFacts>,
  views: ReadonlyArray<TaskView>,
  done: ReadonlyMap<string, Reopened>,
) {
  if (!(yield* loadDefaults(env.userDir)).proactive) return;
  // Unread Tasks would put every Run in the host's own Herd and retire the rest's News.
  const herdOfTask = new Map(
    (yield* listTasks(env.stateDir)).map((task) => [task.id, task.herd ?? null]),
  );
  const own = yield* herdOf(env.socketPath).pipe(Effect.orElseSucceed(() => null));
  for (const { herd } of yield* liveHerds(herdr, env)) {
    if (herd === null) continue;
    const mine = runs.filter(
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
/**
 * How often the merge watch looks. Its board asks herdr nothing, only the Runs' own files,
 * and GitLab is asked about a merge request every 5 minutes whatever this is.
 */
const MERGES_EVERY = "10 seconds";
/** How long after one cleanup sweep ends the next begins (ADR-0045). */
const SWEEP_EVERY = "10 minutes";

/** How often a proven Home's tokens are restated: well within their 24-hour TTL. */
const RESTATE_EVERY = "4 hours";

/** The host's own cleanup sweep, ten minutes after it starts and after each one ends. */
export const sweepEvery = <E, R>(
  stateDir: string,
  sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>,
) =>
  Effect.sleep(SWEEP_EVERY).pipe(
    Effect.andThen(
      every(
        SWEEP_EVERY,
        sweeping.withPermit(Effect.flatMap(sweepers, (all) => sweep(all, stateDir, "host"))),
      ),
    ),
  );

/** Each live Herd's proven Home kept tokened; one Herd's failure skips only that Herd. */
export const keepHomesTokened = <R>(
  stateDir: string,
  herds: Effect.Effect<ReadonlyArray<{ readonly key: string; readonly deps: HomeDeps }>, never, R>,
) =>
  every(
    RESTATE_EVERY,
    Effect.gen(function* () {
      for (const { key, deps } of yield* herds)
        yield* restateHome(stateDir, key, deps).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`home: could not restate ${key}`, cause)),
        );
    }),
  );

/** Every side job, run until the host stops. */
export const sideJobs = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly runs: Effect.Effect<ReadonlyArray<RunFacts>, E, R>;
  readonly board: Effect.Effect<ReadonlyArray<TaskView>, E, R>;
  /** The board with herdr's live agents, which says what a Reopened Run's agent is doing. */
  readonly liveBoard: Effect.Effect<ReadonlyArray<TaskView>, E, R>;
  readonly panels: MrPanels;
  readonly sweepers: Effect.Effect<ReadonlyArray<Sweeper>, E, R>;
}) => {
  const { env, herdr } = opts;
  const checked = new Map<string, number>();
  const kept = new Set<string>();
  const states = new Map<string, MrState>();
  /** Steers to Reopened Runs seen being worked on. */
  const workedOn = new Set<string>();
  /** Reopened Runs whose agent has since finished; the said journal keeps each to one item. */
  const finishedTold = new Map<string, Reopened>();
  return Effect.all(
    [
      every(
        MERGES_EVERY,
        Effect.gen(function* () {
          yield* settleMerges({
            stateDir: env.stateDir,
            cwd: env.cwd,
            run: shell,
            views: yield* opts.board,
            now: yield* Clock.currentTimeMillis,
            checked,
            states,
            panels: opts.panels,
          });
        }),
      ),
      every(
        LOOK_EVERY,
        Effect.gen(function* () {
          const runs = yield* opts.runs;
          const views = yield* opts.liveBoard;
          for (const [run, done] of idleAgain(views, workedOn)) finishedTold.set(run, done);
          yield* news(env, herdr, runs, views, finishedTold);
          yield* keepDiffs(runs, kept);
        }),
      ),
      sweepEvery(env.stateDir, opts.sweepers),
      keepHomesTokened(
        env.stateDir,
        liveHerds(herdr, env).pipe(
          Effect.map((sessions) =>
            sessions.flatMap((session) =>
              session.herd === null
                ? []
                : [{ key: session.herd, deps: homeDeps(session.herdr, () => Effect.void) }],
            ),
          ),
        ),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
};
