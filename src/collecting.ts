// The agents Collie is collecting an Output from now, by Run and herdr agent name.

import { Context, Effect, Layer } from "effect";

export interface CollectingApi {
  /** Runs `collection` with this agent on the list for exactly as long as it runs. */
  readonly during: <A, E, R>(
    run: string,
    agent: string,
    collection: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly has: (run: string, agent: string) => Effect.Effect<boolean>;
}

export class Collecting extends Context.Service<Collecting, CollectingApi>()("collie/Collecting") {}

export const collectingLayer = Layer.effect(Collecting)(
  Effect.sync(() => {
    // Counted, so one collection ending never takes another of the same agent off.
    const now = new Map<string, number>();
    const keyOf = (run: string, agent: string) => `${run}\n${agent}`;
    const add = (key: string, by: number) =>
      Effect.sync(() => {
        const count = (now.get(key) ?? 0) + by;
        if (count > 0) now.set(key, count);
        else now.delete(key);
      });
    return Collecting.of({
      during: (run, agent, collection) =>
        Effect.acquireUseRelease(
          add(keyOf(run, agent), 1),
          () => collection,
          () => add(keyOf(run, agent), -1),
        ),
      has: (run, agent) => Effect.sync(() => now.has(keyOf(run, agent))),
    });
  }),
);
