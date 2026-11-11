import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Clock, Config, Duration, Effect, Schedule, Schema } from "effect";
import type { RunView } from "./engine";
import type { PluginEnv } from "./env";
import { configValue, readConfig } from "./config";
import { appendMetric, readMetrics, recoveriesIn, type Metric } from "./metrics";
import { recheckPark } from "./park-recheck";
import { PARK_CAUSES, healInFlight } from "./park-cause";
import type { Herdr } from "./herdr";
import type { NotificationKind } from "./notify";
import { HealOutput, healOn, healerFor } from "./heal";
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
import { readStepLines } from "./steps";

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

/** Raises, or clears, the one News item saying recovery keeps failing on this Machine. */
export const recoveryFailing = (
  env: PluginEnv,
  herdr: Herdr,
  failing: { readonly run: string; readonly text: string } | null,
) =>
  Effect.gen(function* () {
    const own = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
    const herds = yield* liveHerds(herdr, env).pipe(Effect.orElseSucceed(() => []));
    const key = `recovery-failing:${machineName()}`;
    for (const herd of new Set([own, ...Arr.map(herds, (one) => one.herd)])) {
      if (herd === null) continue;
      const file = yield* newsPath(env.stateDir, herd);
      if (failing !== null)
        yield* appendNews(file, {
          key,
          run: failing.run,
          text: failing.text,
          significance: "consequential",
        });
      else yield* supersede(file, (item) => item.key !== key);
    }
  });

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
        yield* recoveryFailing(
          opts.env,
          opts.herdr,
          failed
            ? {
                run,
                text: `Recovery is failing on ${machineName()}: ${failures} recheck rounds failed in a row. Runs are waiting for people.`,
              }
            : null,
        );
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
                opts.panels.get(mrId(view.mr ?? "") ?? "")?.panel ?? null,
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
                entries: Arr.filter(
                  yield* readStepLines(`${opts.env.stateDir}/runs/${view.runId}`),
                  (line) => line.kind === "entry",
                ).length,
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

/** Whether a park, as its Run reads now, is still the one a Heal was asked about. */
const stillParked = (view: RunView, claim: Metric) =>
  view.status.status !== "complete" &&
  view.park != null &&
  (view.park.id === claim.park || view.park.cause === claim.cause);

const unsettled = (view: RunView) =>
  (view.status.status === "pending" || view.status.status === "suspended") &&
  view.parked === null &&
  !view.controls.includes("stop");

const waitsOnYou = (view: RunView) =>
  view.controls.length > 0 || Arr.some(view.waiting, (one) => one.answer === null);

const said = (output: HealOutput | null, heal: string) =>
  output === null
    ? `Its Heal ${heal} wrote nothing Collie could read.`
    : Arr.join(
        [
          `Its Heal ${heal} found: ${output.diagnosis}`,
          `It tried: ${output.actions.length === 0 ? "nothing" : Arr.join(output.actions, "; ")}.`,
          ...(output.needs_person === undefined
            ? []
            : [`A person is needed: ${output.needs_person}`]),
        ],
        "\n",
      );

export const healParks = <E, R, E2, R2>(opts: {
  readonly env: PluginEnv;
  readonly herdr: Herdr;
  readonly views: Effect.Effect<ReadonlyArray<RunView>, E, R>;
  /** Starts the healer for a park under its claim; the Heal's Run id. */
  readonly start: (
    view: RunView,
    healer: string,
    request: string,
    park: string,
  ) => Effect.Effect<string, E2, R2>;
  readonly notify: (
    runId: string,
    kind: NotificationKind,
    body: string,
    key: string,
  ) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const every = yield* Config.Duration("COLLIE_RECOVERY_EVERY").pipe(
      Config.withDefault(Duration.minutes(1)),
    );
    const crashAt = yield* Config.String("COLLIE_RECOVERY_CRASH_AT").pipe(Config.withDefault(""));
    const evidence = (run: string) => `${opts.env.stateDir}/evidence/${run}`;
    const close = (view: RunView, claim: Metric, line: Partial<Metric>) =>
      Effect.gen(function* () {
        yield* appendMetric(evidence(view.runId), {
          ...claim,
          at: yield* nowIso,
          build: manifest.version,
          ...line,
        });
      });
    /** Three judged Heals in a row that failed say so once, until one does not. */
    const noteFailures = (judged: ReadonlyArray<Metric>) =>
      Effect.gen(function* () {
        const ended = Arr.filter(
          judged,
          (line) => line.action === "healed" && !healInFlight(line) && line.outcome !== "skipped",
        ).sort((a, b) => Str.localeCompare(b.at)(a.at));
        const last = ended.slice(-3);
        if (last.length === 0) return;
        const failing = last.length === 3 && Arr.every(last, (line) => line.outcome === "failed");
        if (failing || last.at(-1)?.outcome !== "failed")
          yield* recoveryFailing(
            opts.env,
            opts.herdr,
            failing
              ? {
                  run: last.at(-1)!.subject,
                  text: `Recovery is failing on ${machineName()}: 3 Heals failed in a row. Runs are waiting for people.`,
                }
              : null,
          );
      });
    yield* Effect.gen(function* () {
      const views = yield* opts.views;
      const byId = new Map(Arr.map(views, (view) => [view.runId, view] as const));
      const claims: Array<{ view: RunView; claim: Metric }> = [];
      const all: Array<Metric> = [];
      let judged = false;
      // Only a Heal its claim names: one started before a crash recorded it is taken up again.
      let flying = false;
      for (const view of views) {
        const lines = recoveriesIn(yield* readMetrics(evidence(view.runId)));
        all.push(...lines);
        for (const claim of Arr.filter(lines, healInFlight)) {
          if (claim.outcome === "claimed") {
            claims.push({ view, claim });
            continue;
          }
          const heal = byId.get(claim.heal ?? "");
          if (heal !== undefined && unsettled(heal)) {
            flying = true;
            continue;
          }
          judged = true;
          const ended = yield* Clock.currentTimeMillis;
          const took = { value: Math.max(0, ended - epochMs(heal?.created ?? claim.at)) };
          if (heal === undefined || heal.status.status !== "complete") {
            const why =
              heal?.parked ??
              (heal?.status.status === "failed" ? heal.status.reason : "it was stopped");
            yield* close(view, claim, { ...took, outcome: "failed", note: why });
            yield* opts.notify(
              view.runId,
              "needs-you",
              `${view.parked ?? "It parked"}\nIts Heal ${claim.heal} could not finish: ${why}`,
              `heal:${claim.park}`,
            );
            continue;
          }
          const output = Option.getOrNull(
            Schema.decodeUnknownOption(HealOutput)(heal.status.value),
          );
          const finding = output === null ? {} : { finding: output.finding };
          const words = said(output, heal.runId);
          if (!stillParked(view, claim)) {
            yield* close(view, claim, {
              ...took,
              ...finding,
              outcome: "recovered",
              note: output?.diagnosis ?? "",
            });
            yield* opts.notify(view.runId, "run-healed", words, `heal:${claim.park}`);
            continue;
          }
          yield* close(view, claim, {
            ...took,
            ...finding,
            outcome: output?.result === "resumed" ? "false-recovery" : "escalated",
            note: words,
          });
          yield* opts.notify(
            view.runId,
            "needs-you",
            `${view.parked ?? ""}\n${words}`,
            `heal:${claim.park}`,
          );
        }
      }
      if (judged) yield* noteFailures(recoveriesIn(all));
      if (flying || claims.length === 0 || (yield* machineMemory(opts.env)).short) return;
      for (const { view, claim } of claims.sort((a, b) =>
        Str.localeCompare(b.claim.at)(a.claim.at),
      )) {
        const current = byId.get(view.runId) ?? view;
        if (!stillParked(current, claim)) {
          yield* close(current, claim, {
            outcome: "skipped",
            note: "the Run left its park before its Heal started",
          });
          continue;
        }
        if (waitsOnYou(current)) continue;
        const healer = (yield* healOn(opts.env.userDir))
          ? yield* healerFor(opts.env, current.project)
          : null;
        if (healer === null) {
          yield* close(current, claim, {
            outcome: "skipped",
            note: "recovery.heal is off, or no workflow declares itself the healer",
          });
          yield* opts.notify(
            current.runId,
            "needs-you",
            current.parked ?? "",
            `parked:${claim.cause}`,
          );
          continue;
        }
        const heal = yield* opts.start(current, healer.id, claim.recoveryId!, claim.park!);
        if (crashAt === "heal-claimed") yield* signalProcess(yield* currentPid, "SIGKILL");
        yield* close(current, claim, {
          outcome: "started",
          heal,
          at: isoAt(yield* Clock.currentTimeMillis),
        });
        return;
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("heal round failed", cause)),
      Effect.repeat(Schedule.spaced(every)),
    );
  });
