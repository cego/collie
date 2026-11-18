import * as Arr from "effect/Array";
import { Cause, Clock, Effect, Option, Stream, SubscriptionRef } from "effect";
import type { BoardMessage, BoardSnapshot, TaskView } from "./board-model";
import { recordMarks } from "./record-marks";
import { Foreground } from "./foreground";

const SLOW_BUILD_MS = 2_000;

const MAX_REST_MS = 5_000;

export const shareBoard = <A, E, R, R2>(options: {
  readonly build: Effect.Effect<A, E, R>;
  readonly changed: Stream.Stream<unknown, never, R2>;
  readonly refresh?: Stream.Stream<unknown, never, R2>;
}) =>
  Effect.gen(function* () {
    const mark = yield* recordMarks;
    let seen = 0;
    const latest = yield* SubscriptionRef.make(
      Option.none<{ readonly covers: number; readonly board: A }>(),
    );
    let rest = 0;
    const timed = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const built = yield* options.build;
      const took = (yield* Clock.currentTimeMillis) - started;
      if (mark !== null) yield* mark("board:built", String(took));
      if (took > SLOW_BUILD_MS) yield* Effect.logWarning(`the board took ${took} ms to build`);
      rest = Math.min(took, MAX_REST_MS);
      return built;
    });
    const changes = options.changed.pipe(Stream.map(() => ++seen));
    const refreshes = (options.refresh ?? Stream.never).pipe(Stream.map(() => seen));
    yield* Stream.concat(Stream.make(0), Stream.merge(changes, refreshes)).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
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
        (Option.isSome(built) ? SubscriptionRef.set(latest, built) : Effect.void).pipe(
          Effect.andThen(Effect.suspend(() => (rest > 0 ? Effect.sleep(rest) : Effect.void))),
        ),
      ),
      Effect.forkScoped,
    );
    const boards = Stream.transformPull(
      Stream.unwrap(
        Effect.sync(() => {
          const since = seen;
          return SubscriptionRef.changes(latest).pipe(
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.filter(Option.isSome),
            Stream.map((built) => built.value),
            Stream.filter((built) => built.covers >= since),
            Stream.map((built) => built.board),
          );
        }),
      ),
      (pull) => Effect.map(Foreground, ({ wait }) => wait(pull)),
    );
    const latestBoard = SubscriptionRef.changes(latest).pipe(
      Stream.filter(Option.isSome),
      Stream.map((built) => built.value.board),
      Stream.runHead,
      Effect.flatMap((board) =>
        Option.isSome(board) ? Effect.succeed(board.value) : Effect.never,
      ),
      (effect) => Effect.flatMap(Foreground, ({ wait }) => wait(effect)),
    );
    return { boards, latest: latestBoard };
  });

export const boardMessages = <R>(options: {
  readonly head: Omit<BoardSnapshot, "_tag" | "tasks" | "seq">;
  readonly boards: Stream.Stream<ReadonlyArray<TaskView>, never, R>;
}) =>
  Stream.unwrap(
    Effect.sync(() => {
      let seq = 0;
      let told: Map<string, { readonly view: TaskView; readonly text: string }> | null = null;
      const changesTo = (views: ReadonlyArray<TaskView>) => {
        const now = new Map(
          Arr.map(views, (view) => {
            const was = told?.get(view.id);
            return [
              view.id,
              was?.view === view ? was : { view, text: JSON.stringify(view) },
            ] as const;
          }),
        );
        const out: BoardMessage[] = [];
        for (const view of views) {
          if (told?.get(view.id)?.text !== now.get(view.id)!.text)
            out.push({ _tag: "Upsert", seq: ++seq, task: view });
        }
        for (const id of told?.keys() ?? []) {
          if (!now.has(id)) out.push({ _tag: "Remove", seq: ++seq, id });
        }
        told = now;
        return out;
      };
      return options.boards.pipe(
        Stream.flatMap((views) => {
          if (told !== null) return Stream.fromIterable(changesTo(views));
          changesTo(views);
          return Stream.make({ _tag: "Snapshot", ...options.head, tasks: views, seq });
        }),
      );
    }),
  );
