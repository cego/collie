// The board as the host tells it to one client: every Task once, then each Task that
// changed, numbered so a client can tell it missed nothing.

import { Effect, Option, Stream } from "effect";
import type { BoardMessage, BoardSnapshot, TaskView } from "./board-model";

/**
 * Built again whenever `changed` says something may have moved. Each client keeps its own
 * copy of what it was told, so a reconnect is a fresh snapshot by construction.
 */
// ponytail: one build per client, a shared board if several clients make that costly.
export const boardMessages = <E, R, R2>(options: {
  readonly head: Omit<BoardSnapshot, "_tag" | "tasks" | "seq">;
  readonly build: Effect.Effect<ReadonlyArray<TaskView>, E, R>;
  readonly changed: Stream.Stream<unknown, never, R2>;
}): Stream.Stream<BoardMessage, E, R | R2> =>
  Stream.unwrap(
    Effect.gen(function* () {
      let seq = 0;
      let told = new Map<string, string>();
      const changesTo = (views: ReadonlyArray<TaskView>): BoardMessage[] => {
        const now = new Map(views.map((view) => [view.id, JSON.stringify(view)]));
        const out: BoardMessage[] = [];
        for (const view of views) {
          if (told.get(view.id) !== now.get(view.id))
            out.push({ _tag: "Upsert", seq: ++seq, task: view });
        }
        for (const id of told.keys()) {
          if (!now.has(id)) out.push({ _tag: "Remove", seq: ++seq, id });
        }
        told = now;
        return out;
      };
      const first = yield* options.build;
      changesTo(first);
      const snapshot: BoardMessage = { _tag: "Snapshot", ...options.head, tasks: first, seq };
      const changes = options.changed.pipe(
        // A build that fails is skipped; the next change or tick builds again.
        Stream.mapEffect(() => Effect.option(options.build)),
        Stream.flatMap((views) =>
          Option.isSome(views) ? Stream.fromIterable(changesTo(views.value)) : Stream.empty,
        ),
      );
      return Stream.concat(Stream.make(snapshot), changes);
    }),
  );
