import type { RunRecords } from "./run-records";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import type { Path } from "effect";
import { Clock, Effect, FileSystem, Queue, Result, Schema, Stream, Struct, flow } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type {
  MrPanel,
  OfferView,
  RecordPart,
  RecordUnchanged,
  RunDetail,
  RunDiff,
  RunRevision,
} from "./board-model";
import { SyncedBranches, taskCardOf } from "./board";
import { Branches, branchKey } from "./branches";
import type { PluginEnv } from "./env";
import { timedFlow, timeless } from "./flow-timing";
import type { AgentInfo } from "./herdr";
import type { Launches } from "./launches";
import { diffOf } from "./run-detail";
import { Foreground } from "./foreground";
import type { RunModelApi } from "./run-model";
import type { RunFacts } from "./runs";
import { readTask } from "./task";
import type { TaskRecord } from "./task";
import { buildRunDetail, tailOf, textsOf } from "./views";
import type { PlanCache } from "./views";

export interface RecordSources {
  readonly env: PluginEnv;
  readonly model: RunModelApi;
  readonly related: (
    runId: string,
    also: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<RunFacts>>;
  readonly alive: Effect.Effect<ReadonlyArray<AgentInfo>>;
  readonly offers: (runId: string) => Effect.Effect<ReadonlyArray<OfferView>>;
  readonly mr: (run: RunFacts, fresh: boolean) => Effect.Effect<MrPanel | null>;
  readonly plans: PlanCache;
}

export interface RecordKey {
  readonly runId: string;
  readonly tail: boolean;
  readonly pages: number;
  readonly refreshMr: boolean;
  readonly refreshMrId?: string;
  readonly parts?: boolean;
  readonly held?: RunRevision;
}

const fingerprint = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

type Needs =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Launches
  | RunRecords
  | Branches;

const sameRevision = (one: RunRevision, other: RunRevision) =>
  one.epoch === other.epoch && one.seq === other.seq;

const recordCard = (sources: RecordSources, runId: string) =>
  Effect.gen(function* () {
    const { env, model } = sources;
    const runs = yield* sources.related(runId, model.planned(runId));
    const run = Arr.findFirst(runs, (one) => one.id === runId);
    if (run._tag === "None") {
      return null;
    }
    yield* model.note(runs);
    const tasks = yield* Effect.forEach(
      [...new Set(Arr.flatMap(runs, (one) => (one.task === null ? [] : [one.task])))],
      (task) => readTask(task),
    );
    const card = yield* taskCardOf(
      {
        env,
        runs,
        tasks: Arr.filter(tasks, (task): task is TaskRecord => task !== null),
        alive: yield* sources.alive,
        offers: sources.offers,
      },
      runId,
    ).pipe(
      Effect.provideServiceEffect(
        SyncedBranches,
        Branches.use((rows) => rows.all),
      ),
      Effect.orElseSucceed(() => null),
    );
    const found = card?.flow ?? null;
    const ids = Arr.map(runs, (one) => one.id);
    for (const lane of found?.lanes ?? []) {
      for (const node of lane.nodes) {
        if (FINISHED_STEPS.has(node.state)) {
          model.finishedAt(lane.run, node.id, model.highest(ids));
        } else {
          model.unfinished(lane.run, node.id);
        }
      }
    }
    return { run: run.value, runs, ids, card, flow: found === null ? null : timeless(found) };
  }).pipe(Effect.provideService(FileSystem.FileSystem, sources.model.reading));

export const recordBase = (sources: RecordSources, runId: string, pages: number) =>
  Effect.gen(function* () {
    const base = yield* recordCard(sources, runId);
    if (base === null) {
      return null;
    }
    const { run, runs, ids, card, flow } = base;
    const detail = yield* buildRunDetail({
      env: sources.env,
      runId,
      runs,
      mr: null,
      pages,
      plans: sources.plans,
      flow,
      parts: false,
    });
    if (detail === null) {
      return null;
    }
    const mrs = card?.view.mrs ?? [];
    return {
      run,
      runs,
      ids,
      detail,
      shown:
        mrs.length > 1 && !Arr.some(mrs, (one) => one.run === runId)
          ? Arr.flatMap(mrs, (one) =>
              Arr.map(
                Arr.filter(runs, (owner) => owner.id === one.run),
                (owner) => ({ id: one.id, mr: one.mr, owner }),
              ),
            )
          : null,
    };
  }).pipe(Effect.provideService(FileSystem.FileSystem, sources.model.reading));

/** A Step in these states has finished: an act shown on it before is refused. */
export const FINISHED_STEPS = new Set(["done", "failed", "stopped", "not-run"]);

export const recordFlow = (sources: RecordSources, runId: string) =>
  Effect.gen(function* () {
    const base = yield* recordCard(sources, runId);
    return base?.flow == null ? null : timedFlow(base.flow, yield* Clock.currentTimeMillis);
  });

export const recordFrames = (
  sources: RecordSources,
  key: RecordKey,
  changes: Stream.Stream<unknown>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { model } = sources;
      const parted = key.parts === true;
      let fresh: boolean | string = key.refreshMr && (key.refreshMrId ?? true);
      let kept: { readonly at: string; readonly diff: RunDiff | null } | undefined;
      let sent: string | undefined;
      const stampKey = `${key.runId}\0${key.tail}\0${key.pages}`;

      const diffAt = (run: RunFacts) =>
        Effect.gen(function* () {
          // What the git syncer last read of the checkout: it reads again on a turn or a Step's end.
          const branch = (yield* Branches.use((rows) => rows.all)).get(
            branchKey(run.cwd, run.branch),
          );
          const at = `${branch?.head ?? ""}\0${run.state}\0${run.branch}\0${run.cwd}`;
          // WARNING: a going Run's diff includes uncommitted edits no git directory records, so it is read each time.
          if (kept?.at !== at || kept.diff?.live !== false) {
            kept = {
              at,
              diff: yield* diffOf(run).pipe(
                Effect.provideService(FileSystem.FileSystem, model.reading),
              ),
            };
          }
          return kept.diff;
        });
      const context = yield* Effect.context<
        Path.Path | ChildProcessSpawner.ChildProcessSpawner | Launches | RunRecords | Branches
      >();
      // WARNING: a failing part ends the stream, as a failed whole record always has.
      const part = <E>(name: RecordPart, value: Effect.Effect<Partial<RunDetail>, E, Needs>) => ({
        name,
        value: value.pipe(
          Effect.provideService(FileSystem.FileSystem, model.reading),
          Effect.provideContext(context),
          Effect.orDie,
        ),
      });
      const partsOf = (base: NonNullable<Effect.Success<ReturnType<typeof recordBase>>>) => {
        const { run, runs } = base;
        const asked = fresh;
        fresh = false;
        const texts = textsOf({
          env: sources.env,
          run,
          runs,
          pages: key.pages,
          plans: sources.plans,
        });
        return [
          part("texts", texts),
          part(
            "diff",
            Effect.map(diffAt(run), (diff) => ({ diff })),
          ),
          part(
            "mr",
            base.shown === null
              ? Effect.map(sources.mr(run, asked !== false), (mr) => ({ mr }))
              : Effect.map(
                  Effect.forEach(
                    base.shown,
                    (one, at) =>
                      Effect.map(
                        sources.mr(one.owner, asked === one.id || (asked === true && at === 0)),
                        (panel) => ({ id: one.id, mr: one.mr, panel }),
                      ),
                    { concurrency: "unbounded" },
                  ),
                  (mrs) => ({ mr: mrs[0]?.panel ?? null, mrs }),
                ),
          ),
          ...(key.tail ? [part("tail", tailOf(run))] : []),
        ];
      };
      const whole = Effect.gen(function* () {
        const base = yield* recordBase(sources, key.runId, key.pages);
        if (base === null) {
          return null;
        }
        const filled = yield* Effect.forEach(partsOf(base), (one) => one.value, {
          concurrency: "unbounded",
        });
        const detail: RunDetail = Object.assign({}, base.detail, ...filled);
        if (!parted) {
          const compatible =
            key.parts === undefined && key.held === undefined
              ? Struct.omit(detail, ["park", "recovery", "narratives"])
              : detail;
          const now = yield* Clock.currentTimeMillis;
          return compatible.flow === undefined
            ? compatible
            : { ...compatible, flow: timedFlow(compatible.flow, now) };
        }
        return {
          ...detail,
          revision: model.stampRecord(stampKey, key.runId, base.ids, fingerprint(detail)),
        };
      });
      const unsent = (detail: RunDetail | null) => {
        const text = fingerprint(detail === null ? null : { ...detail, revision: undefined });
        if (text === sent) {
          return false;
        }
        sent = text;
        return true;
      };

      // WARNING: heard before the first read, so a write during it is sent after it.
      const heard = yield* Queue.sliding<void>(1);
      yield* changes.pipe(
        Stream.runForEach(() => Queue.offer(heard, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );

      const { serve } = yield* Foreground;
      const first = Stream.unwrap(
        Effect.gen(function* () {
          if (!parted || key.held !== undefined) {
            const now = yield* serve(whole);
            unsent(now);
            return Stream.make<ReadonlyArray<RunDetail | RecordUnchanged | null>>(
              now?.revision !== undefined &&
                key.held !== undefined &&
                sameRevision(now.revision, key.held)
                ? ({
                    _tag: "Unchanged",
                    revision: now.revision,
                  } satisfies RecordUnchanged)
                : now,
            );
          }
          const base = yield* serve(recordBase(sources, key.runId, key.pages));
          if (base === null) {
            unsent(null);
            return Stream.make<ReadonlyArray<RunDetail | RecordUnchanged | null>>(null);
          }
          const parts = partsOf(base);
          const head: RunDetail = {
            ...base.detail,
            revision: { epoch: model.epoch, seq: model.highest(base.ids) },
            pending: Arr.map(parts, (one) => one.name),
          };
          const arriving = Stream.mergeAll(
            Arr.map(parts, ({ name, value }) =>
              Stream.fromEffect(Effect.map(serve(value), (found) => ({ name, value: found }))),
            ),
            { concurrency: "unbounded" },
          ).pipe(
            Stream.scan(
              () => head,
              (was: RunDetail, { name, value }) => ({
                ...was,
                ...value,
                pending: Arr.filter(was.pending ?? [], (one) => one !== name),
              }),
            ),
            Stream.drop(1),
            Stream.map((detail) => {
              if (detail.pending?.length !== 0) {
                return detail;
              }
              const { pending: _, revision: __, ...done } = detail;
              const revision = model.stampRecord(stampKey, key.runId, base.ids, fingerprint(done));
              unsent(done);
              return { ...done, revision, pending: [] };
            }),
          );
          return Stream.concat(
            Stream.make<ReadonlyArray<RunDetail | RecordUnchanged | null>>(head),
            arriving,
          );
        }),
      );
      const again = Stream.fromQueue(heard).pipe(
        Stream.mapEffect(() => whole),
        Stream.filter(unsent),
      );
      return Stream.concat(first, again);
    }),
  );
