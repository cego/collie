import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { Clock, Config, Duration, Effect, Schedule, Schema } from "effect";
import type { RunView } from "./engine";
import type { PluginEnv } from "./env";
import { configValue, readConfig } from "./config";
import { appendMetric, readMetrics, recoveriesIn, type Metric } from "./metrics";
import { recheckPark } from "./park-recheck";
import { PARK_CAUSES } from "./park-cause";
import type { Herdr } from "./herdr";
import manifest from "../herdr-plugin.toml";
import { currentPid, signalProcess } from "./lock";
import { machineMemory } from "./memory";
import { appendJournal, readJournal } from "./journal";
import { machineName } from "./peers";
import { machineHerd } from "./steering";
import { liveHerds } from "./herds";
import { append as appendNews, newsPath, supersede } from "./news";
import { epochMs, isoAt, nowIso } from "./time";
import { mrId } from "./board-model";
import { readForge, type MrPanels } from "./merges";
import { isSetAside, isUnanswered } from "./store";

const RoundJson = Schema.fromJsonString(
  Schema.Struct({ at: Schema.String, failed: Schema.Boolean }),
);

export const canRecover = (view: RunView) =>
  view.status.status === "suspended" &&
  view.parked !== null &&
  view.controls.length === 0 &&
  !Arr.some(
    view.waiting,
    (one) =>
      isUnanswered(one) ||
      isSetAside(view.waiting, one) ||
      (one.asker != null && one.answer === null),
  );

export const recoverParks = <E, R>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly views: Effect.Effect<ReadonlyArray<RunView>, E, R>;
  readonly reconnects: Effect.Effect<number>;
  readonly panels: MrPanels;
  readonly resume: (
    view: RunView,
    request: string,
    park: string,
  ) => Effect.Effect<{ readonly applied: boolean }, E, R>;
}) =>
  Effect.gen(function* () {
    const every = yield* Config.Duration("COLLIE_RECOVERY_EVERY").pipe(
      Config.withDefault(Duration.minutes(1)),
    );
    const crashAt = yield* Config.String("COLLIE_RECOVERY_CRASH_AT").pipe(Config.withDefault(""));
    const base = Duration.toMillis(every);
    const waits = new Map<string, { next: number; delay: number; event: string }>();
    const roundsFile = `${opts.env.stateDir}/recovery-rounds.jsonl`;
    const prior = yield* readJournal(roundsFile, RoundJson).pipe(Effect.orElseSucceed(() => []));
    let failures = 0;
    for (const line of Arr.reverse(prior)) {
      if (!line.failed) break;
      failures += 1;
    }
    const noteRound = (failed: boolean, run: string) =>
      Effect.gen(function* () {
        yield* appendJournal(roundsFile, RoundJson, { at: yield* nowIso, failed });
        failures = failed ? failures + 1 : 0;
        if (failed && failures < 3) return;
        const own = yield* machineHerd(opts.env).pipe(Effect.orElseSucceed(() => null));
        const herds = yield* liveHerds(opts.herdr, opts.env).pipe(Effect.orElseSucceed(() => []));
        const key = `recovery-failing:${machineName()}`;
        for (const herd of new Set([own, ...Arr.map(herds, (one) => one.herd)])) {
          if (herd === null) continue;
          const file = yield* newsPath(opts.env.stateDir, herd);
          if (failed)
            yield* appendNews(file, {
              key,
              run,
              text: `Recovery is failing on ${machineName()}: ${failures} recheck rounds failed in a row. Runs are waiting for people.`,
              significance: "consequential",
            });
          else yield* supersede(file, (item) => item.key !== key);
        }
      });
    yield* Effect.sleep(every);
    yield* Effect.gen(function* () {
      let failed = false;
      let checked = false;
      const candidates: Array<{ view: RunView; claimed: Metric; fresh: boolean }> = [];
      const reconnects = yield* opts.reconnects;
      const forge = yield* readForge(opts.env.stateDir);
      const views = yield* opts.views;
      const present = new Set<string>();
      yield* Effect.forEach(
        views,
        (view) =>
          Effect.gen(function* () {
            const dir = `${opts.env.stateDir}/evidence/${view.runId}`;
            const lines = yield* readMetrics(dir);
            const actions = recoveriesIn(lines);
            let claimed = Option.getOrUndefined(
              Arr.findFirst(
                actions,
                (line) => line.action === "resumed" && line.outcome === "claimed",
              ),
            );
            const at = yield* nowIso;
            if (claimed === undefined) {
              if (
                !canRecover(view) ||
                view.park == null ||
                view.park.kind !== "rechecks" ||
                PARK_CAUSES[view.park.cause].kind !== "rechecks"
              )
                return;
              const key = `${view.runId}:${view.park.id ?? view.created}`;
              present.add(key);
              const now = yield* Clock.currentTimeMillis;
              const event = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
                reconnects,
                forge.get(mrId(view.mr ?? "") ?? "") ?? null,
                opts.panels.get(mrId(view.mr ?? "") ?? "")?.at ?? null,
              ]).pipe(Effect.orDie);
              const wait = waits.get(key) ?? {
                next: epochMs(view.park.since ?? view.created) + base,
                delay: base,
                event,
              };
              if (wait.event !== event) {
                wait.next = now + base;
                wait.delay = base;
                wait.event = event;
              }
              waits.set(key, wait);
              if (now < wait.next) return;
              checked = true;
              const { cleared, note, error } = yield* recheckPark(
                view,
                opts.env.stateDir,
                opts.herdr,
              );
              failed ||= error;
              const line: Metric = {
                at,
                kind: "recovery",
                subject: view.runId,
                note,
                value: wait.delay,
                cause: view.park.cause,
                build: manifest.version,
                action: "rechecked",
                outcome: error ? "error" : cleared ? "cleared" : "uncleared",
                park: view.park.id,
              };
              wait.delay = Math.min(wait.delay * 2, base * 60);
              wait.next = now + wait.delay;
              yield* appendMetric(dir, line);
              if (!cleared) return;
              const attempt =
                Arr.filter(
                  actions,
                  (line) => line.action === "resumed" && line.cause === view.park!.cause,
                ).length + 1;
              const park =
                view.park.id ??
                Option.getOrUndefined(Arr.findLast(lines, (line) => line.kind === "halt"))?.at ??
                view.created;
              claimed = {
                ...line,
                action: "resumed",
                outcome: "claimed",
                recoveryId: `recover:${view.runId}:${park}:${attempt}`,
                park,
                since: view.park.since ?? at,
              };
              candidates.push({ view, claimed, fresh: true });
            } else {
              candidates.push({ view, claimed, fresh: false });
            }
          }),
        { concurrency: 2, discard: true },
      );
      for (const key of waits.keys()) if (!present.has(key)) waits.delete(key);
      if (failed) {
        yield* noteRound(true, candidates[0]?.view.runId ?? "");
        return;
      }
      yield* Effect.forEach(
        candidates,
        ({ view, claimed, fresh }) =>
          Effect.gen(function* () {
            if (
              configValue(yield* readConfig(opts.env.userDir), "recovery.resume") === false ||
              (yield* machineMemory(opts.env)).short
            )
              return;
            const dir = `${opts.env.stateDir}/evidence/${view.runId}`;
            if (fresh) {
              yield* appendMetric(dir, { ...claimed, at: yield* nowIso });
              if (crashAt === "claimed") yield* signalProcess(yield* currentPid, "SIGKILL");
            }
            const result = yield* opts.resume(view, claimed.recoveryId!, claimed.park!);
            const ended = yield* Clock.currentTimeMillis;
            yield* appendMetric(dir, {
              ...claimed,
              at: isoAt(ended),
              value: Math.max(0, ended - epochMs(claimed.since ?? claimed.at)),
              outcome: result.applied ? "resumed" : "skipped",
            });
          }),
        { concurrency: 2, discard: true },
      );
      if (checked || candidates.length > 0)
        yield* noteRound(false, candidates[0]?.view.runId ?? "");
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("recovery round failed", cause).pipe(
          Effect.andThen(noteRound(true, "")),
          Effect.ignore,
        ),
      ),
      Effect.repeat(Schedule.spaced(every)),
    );
  });
