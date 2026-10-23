// Each harness's own list of models, read when it is first needed and kept until Desktop quits.

import { Effect, Option, Stream, SubscriptionRef } from "effect";
import type { ListedModel } from "../shared/chat-choices";

/** A harness's own list as Desktop holds it: being read, read, or why it could not be. */
export type HarnessList =
  | { readonly from: "reading" }
  | { readonly from: "harness"; readonly models: ReadonlyArray<ListedModel> }
  | { readonly from: "table"; readonly why: string };

const READING: HarnessList = { from: "reading" };

/** The lists by harness; a harness with no reader has none. */
export type Lists = Readonly<Record<string, HarnessList>>;

/** Reads a harness's list, or fails with why it could not. */
export type ListReader = Effect.Effect<ReadonlyArray<ListedModel>, string>;

/** How long a session's open waits for its harness's list before opening on Collie's table. */
const OPEN_WAITS = "20 seconds";

/** How long a read may take before it counts as failed. */
const READ_WITHIN = "1 minute";

export interface HarnessLists {
  readonly now: () => Lists;
  readonly changes: Stream.Stream<Lists>;
  /** Reads `harness`'s list, unless it is read or being read. */
  readonly need: (harness: string) => Effect.Effect<void>;
  /** The lists once `harness`'s is no longer being read, or once an open has waited long enough. */
  readonly settled: (harness: string) => Effect.Effect<Lists>;
}

/** Lists that are only ever `lists`. */
export const listsHeld = (lists: Lists): HarnessLists => ({
  now: () => lists,
  changes: Stream.make(lists),
  need: () => Effect.void,
  settled: () => Effect.succeed(lists),
});

export const NO_LISTS = listsHeld({});

/** The lists `readers` read, each read in the current scope. */
export const harnessLists = Effect.fnUntraced(function* (
  readers: Readonly<Record<string, ListReader>>,
) {
  const scope = yield* Effect.scope;
  const held = yield* SubscriptionRef.make<Lists>({});
  const read = (harness: string, reader: ListReader) =>
    reader.pipe(
      Effect.timeoutOption(READ_WITHIN),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail("it gave no answer within a minute"),
          onSome: Effect.succeed,
        }),
      ),
      Effect.match({
        onSuccess: (models): HarnessList => ({ from: "harness", models }),
        onFailure: (why): HarnessList => ({ from: "table", why }),
      }),
      Effect.flatMap((list) =>
        SubscriptionRef.update(held, (lists) => ({ ...lists, [harness]: list })),
      ),
    );
  const need = (harness: string) => {
    const reader = readers[harness];
    if (reader === undefined) return Effect.void;
    return SubscriptionRef.modify(held, (lists): readonly [boolean, Lists] => {
      const from = lists[harness]?.from;
      return from === "reading" || from === "harness"
        ? [false, lists]
        : [true, { ...lists, [harness]: READING }];
    }).pipe(
      Effect.flatMap((start) =>
        start ? read(harness, reader).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void,
      ),
    );
  };
  return {
    now: () => SubscriptionRef.getUnsafe(held),
    changes: SubscriptionRef.changes(held),
    need,
    settled: (harness) =>
      need(harness).pipe(
        Effect.andThen(
          SubscriptionRef.changes(held).pipe(
            Stream.filter((lists) => lists[harness]?.from !== "reading"),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOption(OPEN_WAITS),
          ),
        ),
        Effect.andThen(Effect.sync(() => SubscriptionRef.getUnsafe(held))),
      ),
  } satisfies HarnessLists;
});
