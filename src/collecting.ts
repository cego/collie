import * as Arr from "effect/Array";
import { Clock, Context, Effect, Layer } from "effect";

export interface CollectingApi {
  readonly during: <A, E, R>(
    run: string,
    agent: string,
    collection: Effect.Effect<A, E, R>,
    launch?: string,
  ) => Effect.Effect<A, E, R>;
  readonly has: (run: string, agent: string, launch?: string) => Effect.Effect<boolean>;
  readonly duringVerify: <A, E, R>(
    run: string,
    agent: string,
    verify: Effect.Effect<A, E, R>,
    named?: (verified: A) => string | null,
  ) => Effect.Effect<A, E, R>;
  readonly verifying: (run: string, agent: string) => Effect.Effect<VerifyHold>;
  readonly markUntold: (run: string, agent: string, verified: string) => Effect.Effect<void>;
}

// WARNING: an mtime is truncated to the millisecond where the clock rounds, so a write as a verify began can look a millisecond older.
const MILLISECOND_SKEW = 1;

export interface VerifyHold {
  readonly under: boolean;
  readonly since: number | null;
  readonly ended: ReadonlyArray<{
    readonly id: string;
    readonly at: number;
    readonly began: number;
  }>;
  readonly untold: ReadonlyArray<string>;
}

export const owedFor = (writtenAt: number, now: VerifyHold) => {
  const owed: ReadonlyArray<string> = Arr.map(
    Arr.filter(
      now.ended,
      (one) => one.began <= writtenAt + MILLISECOND_SKEW && one.at >= writtenAt,
    ),
    (one) => one.id,
  );
  return owed;
};

export const underWhileWritten = (writtenAt: number, now: VerifyHold) =>
  now.under && (now.since === null || writtenAt + MILLISECOND_SKEW >= now.since);

export const heldOwed = (held: ReadonlyArray<number>, now: VerifyHold) => {
  const owed: ReadonlyArray<string> = Arr.map(
    Arr.filter(now.ended, (one) => Arr.contains(held, one.began)),
    (one) => one.id,
  );
  return owed;
};

export const owedEver = (known: ReadonlyArray<string>, writtenAt: number, now: VerifyHold) => {
  const owed: ReadonlyArray<string> = [...new Set([...known, ...owedFor(writtenAt, now)])];
  return owed;
};

export const released = (
  owed: ReadonlyArray<string>,
  settled: boolean,
  told: (id: string) => boolean,
) => settled && Arr.every(owed, told);

interface Held {
  started: Map<number, number>;
  ended: Map<string, { readonly at: number; readonly began: number }>;
  untold: Set<string>;
}

interface Uses {
  all: number;
  byLaunch: Map<string, number>;
}

const key = (run: string, agent: string) => `${run}\n${agent}`;

export class Collecting extends Context.Service<Collecting, CollectingApi>()("collie/Collecting") {}

export const collectingLayer = Layer.effect(Collecting)(
  Effect.sync(() => {
    const collections = new Map<string, Uses>();
    const verifies = new Map<string, Held>();
    let nextVerify = 0;
    const usesOf = (run: string, agent: string) => {
      const known = collections.get(key(run, agent));
      if (known !== undefined) {
        return known;
      }
      const fresh: Uses = { all: 0, byLaunch: new Map() };
      collections.set(key(run, agent), fresh);
      return fresh;
    };
    const heldOf = (run: string, agent: string) => {
      const known = verifies.get(key(run, agent));
      if (known !== undefined) {
        return known;
      }
      const fresh: Held = { started: new Map(), ended: new Map(), untold: new Set() };
      verifies.set(key(run, agent), fresh);
      return fresh;
    };
    const retire = (run: string, agent: string) =>
      Effect.sync(() => {
        const held = verifies.get(key(run, agent));
        if (
          held !== undefined &&
          held.started.size === 0 &&
          (collections.get(key(run, agent))?.all ?? 0) === 0
        ) {
          verifies.delete(key(run, agent));
        }
      });
    const take = (run: string, agent: string, launch: string | undefined, by: number) =>
      Effect.sync(() => {
        const uses = usesOf(run, agent);
        const next = uses.all + by;
        const launchNext = launch === undefined ? 0 : (uses.byLaunch.get(launch) ?? 0) + by;
        if (launch !== undefined && launchNext <= 0) {
          uses.byLaunch.delete(launch);
        } else if (launch !== undefined) {
          uses.byLaunch.set(launch, launchNext);
        }
        if (next <= 0) {
          collections.delete(key(run, agent));
        } else {
          uses.all = next;
        }
      });
    return Collecting.of({
      during: (run, agent, collection, launch) =>
        Effect.acquireUseRelease(
          take(run, agent, launch, 1),
          () => collection,
          () => take(run, agent, launch, -1).pipe(Effect.andThen(retire(run, agent))),
        ),
      has: (run, agent, launch) =>
        Effect.sync(() => {
          const uses = collections.get(key(run, agent));
          return launch === undefined ? uses !== undefined : (uses?.byLaunch.has(launch) ?? false);
        }),
      duringVerify: (run, agent, verify, named) =>
        Effect.acquireUseRelease(
          Effect.map(Clock.currentTimeMillis, (at) => {
            const held = heldOf(run, agent);
            nextVerify += 1;
            held.started.set(nextVerify, at);
            return { held, handle: nextVerify, at };
          }),
          ({ held, at }) =>
            named === undefined
              ? verify
              : Effect.tap(verify, (verified) =>
                  Effect.gen(function* () {
                    const id = named(verified);
                    if (id !== null) {
                      held.ended.set(id, { began: at, at: yield* Clock.currentTimeMillis });
                    }
                  }),
                ),
          ({ held, handle }) =>
            Effect.sync(() => {
              held.started.delete(handle);
            }).pipe(Effect.andThen(retire(run, agent))),
        ),
      markUntold: (run, agent, verified) =>
        Effect.sync(() => {
          heldOf(run, agent).untold.add(verified);
        }),
      verifying: (run, agent) =>
        Effect.sync(() => {
          const held = verifies.get(key(run, agent));
          const ended = Arr.map([...(held?.ended ?? [])], ([id, one]) => ({ id, ...one }));
          const began = [...(held?.started ?? new Map<number, number>()).values()];
          const returned: VerifyHold = {
            under: began.length > 0,
            since: began.length === 0 ? null : Math.min(...began),
            ended,
            untold: [...(held?.untold ?? [])],
          };
          return returned;
        }),
    });
  }),
);
