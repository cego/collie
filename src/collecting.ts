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
  ) => Effect.Effect<A, E, R>;
  readonly verifying: (run: string, agent: string) => Effect.Effect<boolean>;
}

export class Collecting extends Context.Service<Collecting, CollectingApi>()("collie/Collecting") {}

export const collectingLayer = Layer.effect(Collecting)(
  Effect.sync(() => {
    // WARNING: counted, so one collection ending never takes another of the same agent off.
    const collections = new Map<string, number>();
    const verifies = new Map<string, number>();
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
    return Collecting.of({
      during: (run, agent, collection, launch) =>
        during(collections, keysOf(run, agent, launch))(collection),
      has: (run, agent, launch) =>
        Effect.sync(() => collections.has(keysOf(run, agent, launch).at(-1)!)),
      duringVerify: (run, agent, verify) => during(verifies, [of(run, agent)])(verify),
      verifying: (run, agent) => Effect.sync(() => verifies.has(of(run, agent))),
    });
  }),
);
