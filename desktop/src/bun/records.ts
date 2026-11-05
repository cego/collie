// The records Desktop keeps subscribed (`shared/kept-records.ts` says which), each its host's
// subscription and what it last told, so a record opened again paints without a host round
// trip and says how current it is.

import { Clock, Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect";
import { Flow, type RunDetail, type RunRevision } from "../../../src/board-model";
import type { ActionFailed, KeptRecord } from "../shared/flock";
import {
  closed,
  EMPTY_KEPT,
  keptKeys,
  opened,
  POINT_MS,
  pointed,
  settled,
  sized,
} from "../shared/kept-records";
import { recordEvents, type DoorMap, type RecordDoor, type RecordEvent } from "./machine";

interface Told {
  /** Undefined until the host's first frame. */
  readonly detail: RunDetail | null | undefined;
  /** When the host last confirmed it, while it has not since its door went; else null. */
  readonly asOf: number | null;
  readonly confirmed: number;
  readonly revision: RunRevision | undefined;
  readonly failure: ActionFailed | null;
}

interface Kept {
  readonly installation: string;
  readonly runId: string;
  readonly told: SubscriptionRef.SubscriptionRef<Told>;
  fiber: Fiber.Fiber<void> | null;
}

const keyOf = (installation: string, runId: string) => `${installation}\u0000${runId}`;

const sameFlow = Schema.toEquivalence(Flow);
// ponytail: a frame is encoded again to be weighed; the bytes the door read, once it hands them on.
const weighed = (detail: RunDetail | null) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(detail).pipe(
    Effect.map((text) => text.length),
    Effect.orDie,
  );
/**
 * Each frame without a Flow the view already has, which it keeps: each later part of a record
 * carries the whole Flow again, and decoding a large one again costs the view a frame.
 */
const newFlowsOnly = (
  shown: Flow | undefined,
  record: KeptRecord,
): readonly [Flow | undefined, ReadonlyArray<KeptRecord>] => {
  const { detail } = record;
  if (detail === null) return [undefined, [record]];
  if (detail.flow === undefined) return [shown, [record]];
  if (shown === undefined || !sameFlow(detail.flow, shown)) return [detail.flow, [record]];
  const { flow: _, ...rest } = detail;
  return [shown, [{ ...record, detail: rest }]];
};

const apply = (told: Told, event: RecordEvent, now: number): Told => {
  switch (event._tag) {
    case "Frame":
      return {
        detail: event.detail,
        asOf: null,
        confirmed: now,
        failure: null,
        // A record whose parts are still coming is not yet at a revision to resume from.
        revision:
          event.detail === null
            ? undefined
            : (event.detail.pending ?? []).length === 0
              ? event.detail.revision
              : told.revision,
      };
    case "Unchanged":
      return { ...told, asOf: null, confirmed: now };
    case "Lost":
      return told.detail === undefined ? told : { ...told, asOf: told.asOf ?? told.confirmed };
  }
};

export const recordKeeper = (doors: DoorMap<RecordDoor>) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let set = EMPTY_KEPT;
    const kept = new Map<string, Kept>();

    const follow = (one: Kept, key: string) =>
      recordEvents(
        doors,
        one.installation,
        one.runId,
        Effect.map(SubscriptionRef.get(one.told), ({ revision }) => revision),
      ).pipe(
        Stream.runForEach((event) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            SubscriptionRef.update(one.told, (told) => apply(told, event, now)).pipe(
              Effect.andThen(
                event._tag === "Frame"
                  ? weighed(event.detail).pipe(
                      Effect.flatMap((bytes) => {
                        set = sized(set, key, bytes);
                        return reconcile;
                      }),
                    )
                  : Effect.void,
              ),
            ),
          ),
        ),
        Effect.catch((failure: ActionFailed) =>
          SubscriptionRef.update(one.told, (told) => ({
            ...told,
            failure,
            asOf: told.detail === undefined ? null : (told.asOf ?? told.confirmed),
          })),
        ),
        Effect.ensuring(Effect.sync(() => (one.fiber = null))),
        Effect.forkIn(scope),
      );

    const reconcile: Effect.Effect<void> = Effect.suspend(() => {
      const keys = keptKeys(set);
      return Effect.forEach(
        [...kept],
        ([key, one]) => {
          if (keys.has(key)) return Effect.void;
          kept.delete(key);
          return one.fiber === null ? Effect.void : Fiber.interrupt(one.fiber);
        },
        { discard: true },
      );
    });

    const keep = (installation: string, runId: string) =>
      Effect.gen(function* () {
        const key = keyOf(installation, runId);
        const was = kept.get(key);
        const one = was ?? {
          installation,
          runId,
          told: yield* SubscriptionRef.make<Told>({
            detail: undefined,
            asOf: null,
            confirmed: 0,
            revision: undefined,
            failure: null,
          }),
          fiber: null,
        };
        if (was === undefined) kept.set(key, one);
        if (one.fiber === null) {
          yield* SubscriptionRef.update(one.told, (told) => ({ ...told, failure: null }));
          one.fiber = yield* follow(one, key);
        }
        return one;
      });

    return {
      /** A record while the view shows it, kept once the view lets it go. */
      open: (installation: string, runId: string): Stream.Stream<KeptRecord, ActionFailed> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const key = keyOf(installation, runId);
            set = opened(set, key);
            const one = yield* keep(installation, runId);
            yield* reconcile;
            return SubscriptionRef.changes(one.told).pipe(
              Stream.changesWith(
                (a, b) => a.detail === b.detail && a.asOf === b.asOf && a.failure === b.failure,
              ),
              Stream.flatMap(({ detail, asOf, failure }) => {
                const shown: Stream.Stream<KeptRecord> =
                  detail === undefined ? Stream.empty : Stream.make({ detail, asOf });
                return failure === null ? shown : Stream.concat(shown, Stream.fail(failure));
              }),
              Stream.mapAccum((): Flow | undefined => undefined, newFlowsOnly),
              Stream.ensuring(
                Effect.suspend(() => {
                  if (set.open !== key) return Effect.void;
                  set = closed(set);
                  return reconcile;
                }),
              ),
            );
          }),
        ),
      /** The card the human points at, kept once pointed at for `POINT_MS`. */
      point: (card: { readonly installation: string; readonly runId: string } | null) =>
        Effect.gen(function* () {
          const key = card === null ? null : keyOf(card.installation, card.runId);
          set = pointed(set, key, yield* Clock.currentTimeMillis);
          if (card === null) return;
          yield* Effect.sleep(POINT_MS).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((now) => {
              set = settled(set, now);
              return keptKeys(set).has(key!)
                ? Effect.asVoid(keep(card.installation, card.runId))
                : Effect.void;
            }),
            Effect.andThen(reconcile),
            Effect.forkIn(scope),
          );
        }),
    };
  });

export type RecordKeeper = Effect.Success<ReturnType<typeof recordKeeper>>;
