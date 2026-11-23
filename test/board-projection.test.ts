// The board as a projection the host keeps (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs):
// what a client is told by a host started on a state directory a previous host left.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Option, Stream } from "effect";
import type { BoardMessage, TaskView } from "../src/board-model";
import { frontDoor, socketOf } from "../src/host";
import { writeTask } from "../src/task";
import { stopHost, until } from "./support/host";
import { recordsAt } from "./support/records";
import { collie, proves } from "./support/world";

/** Every message the board stream tells, as it tells them. */
const following = Effect.fn("Projection.following")(function* (state: string) {
  const door = yield* frontDoor(socketOf(state)).pipe(Effect.orDie);
  const told: Array<BoardMessage> = [];
  yield* door.board().pipe(
    Stream.runForEach((message) => Effect.sync(() => told.push(message))),
    Effect.forkScoped,
  );
  return told;
});

const cardIn = (told: ReadonlyArray<BoardMessage>, task: string): TaskView | undefined => {
  let card: TaskView | undefined;
  for (const message of told)
    if (message._tag === "Snapshot")
      card = Arr.findFirst(message.tasks, (one) => one.id === task).pipe(Option.getOrUndefined);
    else if (message._tag === "Upsert" && message.task.id === task) card = message.task;
    else if (message._tag === "Remove" && message.id === task) card = undefined;
  return card;
};

test(
  "a host started where another left its board tells that board first, unconfirmed, then confirms each card unchanged",
  () =>
    proves(
      "collie-projection-",
      (world, core) =>
        Effect.gen(function* () {
          const extra = { COLLIE_BOARD_TICK: "1 hour" };
          yield* writeTask({
            id: "task-1",
            workspace: null,
            label: "project | Keep the board",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.provide(recordsAt(world.state)), Effect.orDie);
          const started = yield* collie(
            world,
            ["run", "start", "plain", "--task", "task-1", "--input", "note=hi"],
            extra,
          );
          expect(started.envelope.ok).toBe(true);
          const first = yield* following(world.state);
          // Settled, so nothing about the card moves while no host runs.
          yield* until(
            () => Effect.sync(() => cardIn(first, "task-1")),
            (card) => card !== undefined && card.state === "done",
          );
          const left = cardIn(first, "task-1")!;
          yield* stopHost(world.state);

          // The next host's first pass waits on core; its first board does not.
          const release = core.hold("terminal.list");
          // `collie board` starts the host, and is answered from the board it was left.
          const board = yield* collie(world, ["board"], extra);
          expect(board.envelope.ok).toBe(true);
          const second = yield* following(world.state);
          yield* until(
            () => Effect.sync(() => second.length),
            (length) => length > 0,
          );
          const snapshot = second[0]!;
          expect(snapshot._tag).toBe("Snapshot");
          const shown = cardIn([snapshot], "task-1")!;
          expect(shown.confirmed).toBe(false);
          expect(shown.asOf).toBeGreaterThan(0);
          const bare = (card: TaskView) => ({
            ...card,
            confirmed: undefined,
            asOf: undefined,
            revision: undefined,
          });
          expect(bare(shown)).toEqual(bare(left));

          release();
          yield* until(
            () => Effect.sync(() => cardIn(second, "task-1")),
            (card) => card !== undefined && card.confirmed === undefined,
          );
          const confirmed = cardIn(second, "task-1")!;
          expect(confirmed.sentence).toBe(left.sentence);
          const log = yield* (yield* FileSystem.FileSystem).readFileString(
            `${world.state}/host.log`,
          );
          // A seconds-old card's age is due again by then, so it may be derived rather than confirmed.
          expect(log).toMatch(/[01] of 1 cards the last host left were confirmed unchanged/);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);
