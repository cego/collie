// Each record the view holds, as its host's subscription and what it last told: resumed from
// the revision it holds when its door returns, and said to be as of an earlier time until then.

import { Clock, Effect, Fiber, Schema, Stream, SubscriptionRef } from "effect";
import { Flow, type RunDetail, type RunRevision } from "../../../src/board-model";
import type { ActionFailed, KeptRecord } from "../shared/flock";
import { markFirst } from "../../../src/record-marks";
import { recordEvents, type DoorMap, type RecordDoor, type RecordEvent } from "./machine";

interface Told {
  /** Undefined until the host's first frame. */
  readonly detail: RunDetail | null | undefined;
  /** When the host last confirmed it, while it has not since its door went; else null. */
  readonly asOf: number | null;
  readonly confirmed: number;
  readonly revision: RunRevision | undefined;
  readonly failure: ActionFailed | null;
  /** The encoded size of its latest frame. */
  readonly bytes: number;
}

interface Kept {
  readonly installation: string;
  readonly runId: string;
  readonly told: SubscriptionRef.SubscriptionRef<Told>;
  fiber: Fiber.Fiber<void> | null;
  readers: number;
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
        ...told,
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
    const kept = new Map<string, Kept>();

    const follow = (one: Kept) =>
      recordEvents(
        doors,
        one.installation,
        one.runId,
        Effect.map(SubscriptionRef.get(one.told), ({ revision }) => revision),
      ).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const bytes = event._tag === "Frame" ? yield* weighed(event.detail) : undefined;
            yield* SubscriptionRef.update(one.told, (told) => ({
              ...apply(told, event, now),
              bytes: bytes ?? told.bytes,
            }));
          }),
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

    const keep = (key: string, installation: string, runId: string) =>
      Effect.gen(function* () {
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
            bytes: 0,
          }),
          fiber: null,
          readers: 0,
        };
        if (was === undefined) kept.set(key, one);
        if (one.fiber === null) {
          yield* SubscriptionRef.update(one.told, (told) => ({ ...told, failure: null }));
          one.fiber = yield* follow(one);
        }
        return one;
      });

    return {
      /** A record for as long as the view holds it, which the view keeps after closing it. */
      open: (installation: string, runId: string): Stream.Stream<KeptRecord, ActionFailed> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const key = keyOf(installation, runId);
            const one = yield* keep(key, installation, runId);
            one.readers++;
            return SubscriptionRef.changes(one.told).pipe(
              Stream.changesWith(
                (a, b) => a.detail === b.detail && a.asOf === b.asOf && a.failure === b.failure,
              ),
              Stream.flatMap(({ detail, asOf, failure, bytes }) => {
                const shown: Stream.Stream<KeptRecord> =
                  detail === undefined ? Stream.empty : Stream.make({ detail, asOf, bytes });
                return failure === null ? shown : Stream.concat(shown, Stream.fail(failure));
              }),
              Stream.mapAccum((): Flow | undefined => undefined, newFlowsOnly),
              markFirst("desktop:serve", runId),
              Stream.ensuring(
                Effect.suspend(() => {
                  if (--one.readers > 0 || kept.get(key) !== one) return Effect.void;
                  kept.delete(key);
                  return one.fiber === null ? Effect.void : Fiber.interrupt(one.fiber);
                }),
              ),
            );
          }),
        ),
    };
  });

export type RecordKeeper = Effect.Success<ReturnType<typeof recordKeeper>>;
