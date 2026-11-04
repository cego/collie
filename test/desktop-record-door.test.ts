// A record reaches Desktop over a door of its own, so a board stream nobody reads cannot hold
// it back.

import { expect, test } from "bun:test";
import { Effect, Option, Stream } from "effect";
import { DoorMap, openDoors, runDetailOn } from "../desktop/src/bun/machine";

const bridge = [process.execPath, `${import.meta.dir}/fixtures/endless-board-bridge.ts`];

test(
  "a record frame reaches Desktop while its Machine's board stream is stalled",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const opened = yield* openDoors({ profile: "vm", name: "vm-mk" }, () => bridge);
        yield* opened.board.pipe(
          Stream.runForEach(() => Effect.never),
          Effect.forkScoped,
        );
        const doors = new DoorMap<typeof opened>();
        doors.set("i-1", opened);
        const first = yield* runDetailOn(doors, "i-1", "r-1").pipe(
          Stream.runHead,
          Effect.timeoutOption("5 seconds"),
        );
        expect(Option.flatten(first)).toEqual(Option.some(null));
      }).pipe(Effect.scoped),
    ),
  15_000,
);
