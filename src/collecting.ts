import { Context, Effect, Layer } from "effect";

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
}

interface VerifyCount {
  under: number;
  ended: string | null;
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
    const during =
      (now: Map<string, number>, keys: ReadonlyArray<string>) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          add(now, keys, 1),
          () => effect,
          () => add(now, keys, -1),
        );
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
      const fresh = { under: 0, ended: null };
      const added: VerifyCount = fresh;
      verifies.set(of(run, agent), added);
      return added;
    };
    return Collecting.of({
      during: (run, agent, collection, launch) =>
        during(collections, keysOf(run, agent, launch))(collection),
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
                  Effect.sync(() => {
                    const id = named(verified);
                    if (id !== null) {
                      holding(run, agent).ended = id;
                    }
                  }),
                ),
          () =>
            Effect.sync(() => {
              const held = holding(run, agent);
              held.under = Math.max(0, held.under - 1);
            }),
        ),
      verifying: (run, agent) =>
        Effect.sync(() => {
          const held = verifies.get(of(run, agent));
          const returned: VerifyHold = {
            under: (held?.under ?? 0) > 0,
            ended: held?.ended ?? null,
          };
          return returned;
        }),
    });
  }),
);
