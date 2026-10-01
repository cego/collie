// What the host does on its own, whether or not a pane is open: the merge watch, each
// Herd's News and worktree pruning.

import { Clock, Effect, Schedule, type Duration } from "effect";
import type { TaskView, MrState } from "./board-model";
import { loadDefaults } from "./config";
import { currentReports, readDrift } from "./drift";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";
import { liveHerds } from "./herds";
import { settleMerges, type MrPanels } from "./merges";
import { shell } from "./mr";
import { append as appendNews, newsPath } from "./news";
import { eventsIn, readSaid, remember } from "./proactive";
import { everyRegistered } from "./registry";
import { settled, type RunFacts } from "./runs";
import { herdDir, herdOf } from "./steering";
import { listTasks } from "./task";
import { nowIso } from "./time";
import { pruneWorktrees } from "./worktree";
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
) {
  const dir = yield* herdDir(stateDir, key);
  const said = yield* readSaid(dir);
  const file = yield* newsPath(stateDir, key);
  for (const event of eventsIn(runs, yield* escalatedDrift(runs))) {
    if (said.has(event.key)) continue;
    // Remembered only once it is in the journal, so a failed write is retried next round.
    const queued = yield* appendNews(file, {
      key: event.key,
      run: event.run,
      text: event.text,
    }).pipe(Effect.catchCause(() => Effect.succeed(null)));
    if (queued !== null) yield* remember(dir, event.key, yield* nowIso());
  }
});

/** Each Herd's News from its own Runs; a Run whose Task records no Herd is the host's own Herd's. */
const news = Effect.fn("SideJobs.news")(function* (
  env: PluginEnv,
  herdr: Herdr,
  runs: ReadonlyArray<RunFacts>,
) {
  if (!(yield* loadDefaults(env.userDir)).proactive) return;
  const herdOfTask = new Map(
    (yield* listTasks(env.stateDir).pipe(Effect.orElseSucceed(() => []))).map((task) => [
      task.id,
      task.herd ?? null,
    ]),
  );
  const own = yield* herdOf(env.socketPath).pipe(Effect.orElseSucceed(() => null));
  for (const { herd } of yield* liveHerds(herdr, env)) {
    if (herd === null) continue;
    const mine = runs.filter(
      (run) => ((run.task === null ? null : herdOfTask.get(run.task)) ?? own) === herd,
    );
    yield* sayWhatHappened(env.stateDir, herd, mine);
  }
});

/** One job, again and again for as long as the host runs; a round that fails is skipped. */
const every = <E, R>(spaced: Duration.Input, round: Effect.Effect<unknown, E, R>) =>
  round.pipe(
    Effect.catchCause((cause) => Effect.logWarning("a side job's round failed", cause)),
    Effect.repeat(Schedule.spaced(spaced)),
    Effect.asVoid,
  );

/** How often News and the merge watch look again; a merge request is asked every 5 minutes. */
// ponytail: each look builds the board and lists the sessions again; share the board stream's build if that costs.
const LOOK_EVERY = "5 seconds";
/** How often checkouts are swept: a sweep walks each one with git and glab. */
const PRUNE_EVERY = "3 minutes";

/** Every side job, run until the host stops. */
export const sideJobs = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly runs: Effect.Effect<ReadonlyArray<RunFacts>, E, R>;
  readonly board: Effect.Effect<ReadonlyArray<TaskView>, E, R>;
  readonly panels: MrPanels;
}) => {
  const { env, herdr } = opts;
  const checked = new Map<string, number>();
  const kept = new Set<string>();
  const states = new Map<string, MrState>();
  return Effect.all(
    [
      every(
        LOOK_EVERY,
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
        Effect.flatMap(opts.runs, (runs) =>
          Effect.andThen(news(env, herdr, runs), keepDiffs(runs, kept)),
        ),
      ),
      // ponytail: swept through the host's own session, so a pane in another is unseen; git's refusal still guards.
      every(
        PRUNE_EVERY,
        Effect.gen(function* () {
          yield* pruneWorktrees({
            herdr,
            stateDir: env.stateDir,
            runs: yield* opts.runs,
            registered: yield* everyRegistered(env.stateDir),
            cwd: env.cwd,
          });
        }),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );
};
