import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
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
}

export interface VerifyHold {
  readonly under: boolean;
  readonly ended: string | null;
  readonly endedAt: number | null;
}

export type Owed = { readonly since: number; readonly id: string };

export const released = (owed: Owed | null, settled: boolean, told: boolean) =>
  owed === null || (settled && told);

export const owedFor = (began: number, now: VerifyHold) =>
  now.ended === null || now.endedAt === null || now.endedAt < began
    ? null
    : { since: began, id: now.ended };

interface VerifyCount {
  under: number;
  ended: string | null;
  endedAt: number | null;
}

export class Collecting extends Context.Service<Collecting, CollectingApi>()("collie/Collecting") {}

export const collectingLayer = Layer.effect(Collecting)(
  Effect.sync(() => {
    // WARNING: counted, so one collection ending never takes another of the same agent off.
    const collections = new Map<string, number>();
    const verifies = new Map<string, VerifyCount>();
    const add = (now: Map<string, number>, keys: ReadonlyArray<string>, by: number) =>
      Effect.sync(() => {
        for (const key of keys) {
          const count = (now.get(key) ?? 0) + by;
          if (count > 0) {
            now.set(key, count);
          } else {
            now.delete(key);
          }
        }
      });
    const keysOf = (run: string, agent: string, launch?: string) =>
      launch === undefined
        ? [`${run}\n${agent}`]
        : [`${run}\n${agent}`, `${run}\n${agent}\n${launch}`];
    const of = (run: string, agent: string) => `${run}\n${agent}`;
    const holding = (run: string, agent: string) => {
      const known = verifies.get(of(run, agent));
      if (known !== undefined) {
        return known;
      }
      const fresh: VerifyCount = { under: 0, ended: null, endedAt: null };
      verifies.set(of(run, agent), fresh);
      return fresh;
    };
    const retire = (run: string, agent: string) =>
      Effect.sync(() => {
        const held = verifies.get(of(run, agent));
        const collecting = Arr.some(
          [...collections.keys()],
          (key) => key === of(run, agent) || pipe(key, Str.startsWith(`${of(run, agent)}\n`)),
        );
        if (held !== undefined && held.under === 0 && !collecting) {
          verifies.delete(of(run, agent));
        }
      });
    return Collecting.of({
      during: (run, agent, collection, launch) =>
        Effect.acquireUseRelease(
          add(collections, keysOf(run, agent, launch), 1),
          () => collection,
          () =>
            add(collections, keysOf(run, agent, launch), -1).pipe(
              Effect.andThen(retire(run, agent)),
            ),
        ),
      has: (run, agent, launch) =>
        Effect.sync(() => collections.has(keysOf(run, agent, launch).at(-1)!)),
      duringVerify: (run, agent, verify, named) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            holding(run, agent).under += 1;
          }),
          () =>
            named === undefined
              ? verify
              : Effect.tap(verify, (verified) =>
                  Effect.gen(function* () {
                    const id = named(verified);
                    if (id !== null) {
                      const at = yield* Clock.currentTimeMillis;
                      const held = holding(run, agent);
                      held.ended = id;
                      held.endedAt = at;
                    }
                  }),
                ),
          () =>
            Effect.sync(() => {
              const held = holding(run, agent);
              held.under = Math.max(0, held.under - 1);
            }).pipe(Effect.andThen(retire(run, agent))),
        ),
      verifying: (run, agent) =>
        Effect.sync(() => {
          const held = verifies.get(of(run, agent));
          const returned: VerifyHold = {
            under: (held?.under ?? 0) > 0,
            ended: held?.ended ?? null,
            endedAt: held?.endedAt ?? null,
          };
          return returned;
        }),
    });
  }),
);
