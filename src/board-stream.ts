// The board as the host tells it to its clients: one board built per change and shared,
// then told to each client as every Task once and each Task that changed, numbered so a
// client can tell it missed nothing.

import { Effect, Option, Scope, Stream, SubscriptionRef } from "effect";
import type { BoardMessage, BoardSnapshot, TaskView } from "./board-model";

/**
 * One board for every client: built when the first one subscribes and again whenever
 * `changed` says something may have moved, one build at a time, with the changes that arrive
 * during a build folded into the next. It keeps building for as long as `Scope` lasts.
 * `boards` is the latest board, then each one built after it.
 */
export const shareBoard = <E, R, R2>(options: {
  readonly build: Effect.Effect<ReadonlyArray<TaskView>, E, R>;
  readonly changed: Stream.Stream<unknown, never, R2>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R | R2>();
    const latest = yield* SubscriptionRef.make(Option.none<ReadonlyArray<TaskView>>());
    const builder = Stream.concat(Stream.make(undefined), options.changed).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      // A build that fails is skipped: the last board stands until a change builds again.
      Stream.mapEffect(() => Effect.option(options.build)),
      Stream.runForEach((built) =>
        Option.isSome(built) ? SubscriptionRef.set(latest, built) : Effect.void,
      ),
      Effect.provideContext(context),
    );
    let started = false;
    const boards = Stream.unwrap(
      Effect.gen(function* () {
        if (!started) {
          started = true;
          yield* Effect.forkIn(builder, scope);
        }
        return SubscriptionRef.changes(latest).pipe(
          Stream.filter(Option.isSome),
          Stream.map((built) => built.value),
        );
      }),
    );
    return { boards };
  }) satisfies Effect.Effect<unknown, never, Scope.Scope | R | R2>;

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
        const now = new Map(views.map((view) => [view.id, JSON.stringify(view)]));
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
