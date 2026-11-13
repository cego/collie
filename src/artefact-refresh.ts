import { Clock, Deferred, Effect, Option, Order, Semaphore } from "effect";
import * as Arr from "effect/Array";

export interface RefreshJob<R> {
  readonly key: string;
  readonly observed: number;
  readonly check: Effect.Effect<boolean, never, R>;
}

/** Coalesced, bounded refreshes due every 30 seconds, backing off a failing source. */
export const refreshJobs = () => {
  const permits = Semaphore.makeUnsafe(2);
  const pending = new Map<string, Deferred.Deferred<boolean>>();
  const checked = new Map<string, { at: number; due: number; failures: number }>();
  let cursor = "";
  const status = (job: Pick<RefreshJob<never>, "key" | "observed">, now: number) => ({
    pending: pending.has(job.key),
    stale: now - (checked.get(job.key)?.at ?? job.observed) >= 30_000,
  });
  const due = <R>(job: RefreshJob<R>, now: number) =>
    now >= (checked.get(job.key)?.due ?? job.observed + 30_000);
  const refresh = <R>(job: RefreshJob<R>): Effect.Effect<boolean, never, R> =>
    Effect.gen(function* () {
      const running = pending.get(job.key);
      if (running !== undefined) return yield* Deferred.await(running);
      const done = yield* Deferred.make<boolean>();
      pending.set(job.key, done);
      return yield* permits
        .withPermit(
          Effect.gen(function* () {
            const success = yield* job.check.pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.map((value) => value._tag === "Some" && value.value),
            );
            const at = yield* Clock.currentTimeMillis;
            const failures = success ? 0 : (checked.get(job.key)?.failures ?? 0) + 1;
            checked.set(job.key, {
              at: success ? at : (checked.get(job.key)?.at ?? job.observed),
              due: at + Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4)),
              failures,
            });
            yield* Deferred.succeed(done, success);
            return success;
          }),
        )
        .pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              pending.delete(job.key);
              yield* Deferred.succeed(done, false);
            }),
          ),
        );
    });
  const schedule = <R>(jobs: ReadonlyArray<RefreshJob<R>>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const ready = Arr.sortWith(
        Arr.filter(jobs, (job) => due(job, now)),
        (job: RefreshJob<R>) => job.key,
        Order.String,
      );
      // On from the last one checked, so a failing source cannot hold the front.
      const rotated = Arr.take(
        [
          ...Arr.filter(ready, (job) => job.key > cursor),
          ...Arr.filter(ready, (job) => job.key <= cursor),
        ],
        8,
      );
      cursor = Option.match(Arr.last(rotated), { onNone: () => cursor, onSome: (job) => job.key });
      yield* Effect.forEach(rotated, refresh, { concurrency: 2, discard: true });
    });
  const pass = <R>(jobs: ReadonlyArray<RefreshJob<R>>) =>
    Effect.gen(function* () {
      const keys = new Set(Arr.map(jobs, (job) => job.key));
      for (const key of checked.keys())
        if (!keys.has(key) && !pending.has(key)) checked.delete(key);
      yield* schedule(jobs);
    });
  return { refresh, pass, schedule, status, due };
};
