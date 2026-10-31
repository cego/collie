// A Run's record, read from its host's Run model
// (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model D3–D5): what its Task's Runs
// cost to read, its Flow first, and a frame only when what it carries moved.

import * as Arr from "effect/Array";
import { Clock, Effect, Fiber, FileSystem, Path, Result, Schema, Stream, flow } from "effect";
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
import { mrOf, taskFlowOf } from "./board";
import type { PluginEnv } from "./env";
import { timedFlow, timeless } from "./flow-timing";
import type { AgentInfo } from "./herdr";
import { diffOf } from "./run-detail";
import type { RunModelApi } from "./run-model";
import type { RunFacts } from "./runs";
import { readTask, type TaskRecord } from "./task";
import { buildRunDetail, tailOf, textsOf, type PlanCache } from "./views";

export interface RecordSources {
  readonly env: PluginEnv;
  readonly model: RunModelApi;
  /** The Runs a Run's record reads, `also` among them. */
  readonly related: (
    runId: string,
    also: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<RunFacts>>;
  readonly alive: Effect.Effect<ReadonlyArray<AgentInfo>>;
  readonly offers: (runId: string) => Effect.Effect<ReadonlyArray<OfferView>>;
  /** What the merge watch read of the Run's merge request; asked again when `fresh`. */
  readonly mr: (run: RunFacts, fresh: boolean) => Effect.Effect<MrPanel | null>;
  readonly plans: PlanCache;
}

export interface RecordKey {
  readonly runId: string;
  readonly tail: boolean;
  readonly pages: number;
  readonly refreshMr: boolean;
  readonly parts?: boolean;
  readonly held?: RunRevision;
}

const fingerprint = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

type Needs = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

/** A part of the record, and the fields it fills when it comes. */
interface Part {
  readonly name: RecordPart;
  readonly value: Effect.Effect<Partial<RunDetail>>;
}

const sameRevision = (one: RunRevision, other: RunRevision) =>
  one.epoch === other.epoch && one.seq === other.seq;

/** The record without its parts, at the revision of the Runs it read, its Flow timeless. */
export const recordBase = (sources: RecordSources, runId: string, pages: number) =>
  Effect.gen(function* () {
    const { env, model } = sources;
    // Its own offers are read while the Runs it reads are chosen.
    const own = yield* Effect.forkChild(sources.offers(runId));
    const offers = (id: string) => (id === runId ? Fiber.join(own) : sources.offers(id));
    const runs = yield* sources.related(runId, model.planned(runId));
    const run = Arr.findFirst(runs, (one) => one.id === runId);
    if (run._tag === "None") return null;
    yield* model.note(runs);
    const tasks = yield* Effect.forEach(
      [...new Set(Arr.flatMap(runs, (one) => (one.task === null ? [] : [one.task])))],
      (task) => readTask(env.stateDir, task),
    );
    const found = yield* taskFlowOf(
      {
        env,
        runs,
        tasks: Arr.filter(tasks, (task): task is TaskRecord => task !== null),
        alive: yield* sources.alive,
        offers,
        head: model.head,
      },
      runId,
    ).pipe(Effect.orElseSucceed(() => null));
    const detail = yield* buildRunDetail({
      env,
      runId,
      runs,
      mr: null,
      pages,
      plans: sources.plans,
      flow: found === null ? null : timeless(found),
      parts: false,
    });
    if (detail === null) return null;
    return {
      run: run.value,
      runs,
      ids: Arr.map(runs, (one) => one.id),
      detail,
    };
  }).pipe(Effect.provideService(FileSystem.FileSystem, sources.model.reading));

/** The Run's Task's Flow as `run show` and chat's `collie_run` say it: the record's, read now. */
export const recordFlow = (sources: RecordSources, runId: string) =>
  Effect.gen(function* () {
    const base = yield* recordBase(sources, runId, 1);
    const found = base?.detail.flow;
    return found === undefined ? null : timedFlow(found, yield* Clock.currentTimeMillis);
  });

/**
 * The record's frames: with `parts`, its Flow first and each part as it comes, then the whole
 * record again each time `changes` finds it moved. `held` at the current revision is answered
 * `Unchanged`. Without `parts`, every frame is the whole record, its minutes said as of then.
 */
export const recordFrames = (
  sources: RecordSources,
  key: RecordKey,
  changes: Stream.Stream<unknown>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { model } = sources;
      const parted = key.parts === true;
      let fresh = key.refreshMr;
      let kept: { readonly at: string; readonly diff: RunDiff | null } | undefined;
      let sent: string | undefined;
      const stampKey = `${key.runId}\0${key.tail}\0${key.pages}`;

      const diffAt = (run: RunFacts) =>
        Effect.gen(function* () {
          const at = `${yield* model.checkout(run)}\0${run.state}\0${run.branch}\0${run.cwd}`;
          if (kept?.at !== at)
            kept = {
              at,
              diff: yield* diffOf(run).pipe(
                Effect.provideService(FileSystem.FileSystem, model.reading),
              ),
            };
          return kept.diff;
        });
      const context = yield* Effect.context<Path.Path | ChildProcessSpawner.ChildProcessSpawner>();
      // A part that fails ends the stream, as a whole record that failed always has.
      const part = <E>(
        name: RecordPart,
        value: Effect.Effect<Partial<RunDetail>, E, Needs>,
      ): Part => ({
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
            Effect.map(sources.mr(run, asked), (mr) => ({ mr })),
          ),
          ...(key.tail ? [part("tail", tailOf(run))] : []),
        ];
      };
      const whole = Effect.gen(function* () {
        const base = yield* recordBase(sources, key.runId, key.pages);
        if (base === null) return null;
        const filled = yield* Effect.forEach(partsOf(base), (one) => one.value, {
          concurrency: "unbounded",
        });
        const detail: RunDetail = Object.assign({}, base.detail, ...filled);
        if (!parted) {
          const now = yield* Clock.currentTimeMillis;
          return detail.flow === undefined
            ? detail
            : { ...detail, flow: timedFlow(detail.flow, now) };
        }
        return {
          ...detail,
          revision: model.stampRecord(stampKey, base.ids, fingerprint(detail)),
        };
      });
      const unsent = (detail: RunDetail | null) => {
        const text = fingerprint(detail === null ? null : { ...detail, revision: undefined });
        if (text === sent) return false;
        sent = text;
        return true;
      };

      const first = Stream.unwrap(
        Effect.gen(function* () {
          if (!parted || key.held !== undefined) {
            const now = yield* whole;
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
          const base = yield* recordBase(sources, key.runId, key.pages);
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
              Stream.fromEffect(Effect.map(value, (found) => ({ name, value: found }))),
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
            Stream.map((detail): RunDetail => {
              if (detail.pending?.length !== 0) return detail;
              const { pending: _, revision: __, ...done } = detail;
              const revision = model.stampRecord(stampKey, base.ids, fingerprint(done));
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
      const again = changes.pipe(
        Stream.mapEffect(() => whole),
        Stream.filter(unsent),
      );
      return Stream.concat(first, again);
    }),
  );
