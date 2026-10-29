// The board as the host tells it to its clients: one board built per change and shared,
// then told to each client as every Task once and each Task that changed, numbered so a
// client can tell it missed nothing.

import * as Arr from "effect/Array";
import { Cause, Clock, Effect, Option, type Scope, Stream, SubscriptionRef } from "effect";
import type { BoardMessage, BoardSnapshot, TaskView } from "./board-model";

/** How long a build may take before the host log says so. */
const SLOW_BUILD_MS = 2_000;

/**
 * One board for everything that reads it: built at once and again whenever `changed` says
 * something may have moved, one build at a time, with the changes that arrive during a
 * build folded into the next. It keeps building for as long as `Scope` lasts. Its `boards`
 * are the latest board that covers every change seen before it was read, then each one
 * built after it, so a reader reads its own writes. `latest` is the last board built, or
 * the first once it is, never waiting for a newer one.
 */
export const shareBoard = <A, E, R, R2>(options: {
  readonly build: Effect.Effect<A, E, R>;
  readonly changed: Stream.Stream<unknown, never, R2>;
}): Effect.Effect<
  { readonly boards: Stream.Stream<A>; readonly latest: Effect.Effect<A> },
  never,
  Scope.Scope | R | R2
> =>
  Effect.gen(function* () {
    let seen = 0;
    const latest = yield* SubscriptionRef.make(
      Option.none<{ readonly covers: number; readonly board: A }>(),
    );
    const timed = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const built = yield* options.build;
      const took = (yield* Clock.currentTimeMillis) - started;
      if (took > SLOW_BUILD_MS) yield* Effect.logWarning(`the board took ${took} ms to build`);
      return built;
    });
    yield* Stream.concat(Stream.make(undefined), options.changed).pipe(
      Stream.map(() => ++seen),
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      // A build that fails is skipped: the last board stands until a change builds again.
      Stream.mapEffect((covers) =>
        timed.pipe(
          Effect.map((board) => Option.some({ covers, board })),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("the board could not be built", cause).pipe(
                  Effect.as(Option.none()),
                ),
          ),
        ),
      ),
      Stream.runForEach((built) =>
        Option.isSome(built) ? SubscriptionRef.set(latest, built) : Effect.void,
      ),
      Effect.forkScoped,
    );
    const boards = Stream.unwrap(
      Effect.sync(() => {
        const since = seen;
        return SubscriptionRef.changes(latest).pipe(
          // A reader that reads slowly skips to the latest board; a client is told by diff.
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.filter(Option.isSome),
          Stream.map((built) => built.value),
          Stream.filter((built) => built.covers >= since),
          Stream.map((built) => built.board),
        );
      }),
    );
    const latestBoard = SubscriptionRef.changes(latest).pipe(
      Stream.filter(Option.isSome),
      Stream.map((built) => built.value.board),
      Stream.runHead,
      Effect.flatMap((board) =>
        Option.isSome(board) ? Effect.succeed(board.value) : Effect.never,
      ),
    );
    return { boards, latest: latestBoard };
  });

/**
 * What one client is told: a snapshot of the first board, then each later board as the
 * Tasks that differ from what this client was told. Its own copy of what it was told makes
 * a reconnect a fresh snapshot by construction.
 */
export const boardMessages = <R>(options: {
  readonly head: Omit<BoardSnapshot, "_tag" | "tasks" | "seq">;
  readonly boards: Stream.Stream<ReadonlyArray<TaskView>, never, R>;
}): Stream.Stream<BoardMessage, never, R> =>
  Stream.unwrap(
    Effect.sync(() => {
      let seq = 0;
      let told: Map<string, string> | null = null;
      const changesTo = (views: ReadonlyArray<TaskView>): BoardMessage[] => {
        const now = new Map(Arr.map(views, (view) => [view.id, JSON.stringify(view)]));
        const out: BoardMessage[] = [];
        for (const view of views) {
          if (told?.get(view.id) !== now.get(view.id))
            out.push({ _tag: "Upsert", seq: ++seq, task: view });
        }
        for (const id of told?.keys() ?? []) {
          if (!now.has(id)) out.push({ _tag: "Remove", seq: ++seq, id });
        }
        told = now;
        return out;
      };
      return options.boards.pipe(
        Stream.flatMap((views): Stream.Stream<BoardMessage> => {
          if (told !== null) return Stream.fromIterable(changesTo(views));
          changesTo(views);
          return Stream.make({ _tag: "Snapshot", ...options.head, tasks: views, seq });
        }),
      );
    }),
  );
