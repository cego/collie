// A record reaches Desktop over a door of its own, so a board stream nobody reads cannot hold
// it back.

import { expect, test } from "bun:test";
import { Array as Arr, Effect, Option, Stream } from "effect";
import { DoorMap, openDoors, recordEvents, type Doors } from "../desktop/src/bun/machine";
import { recordKeeper } from "../desktop/src/bun/records";
import type { RunDetail } from "../src/board-model";
import { flowNode, mainFlow } from "./support/flow";

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
        const first = yield* recordEvents(doors, "i-1", "r-1").pipe(
          Stream.runHead,
          Effect.timeoutOption("5 seconds"),
        );
        expect(Option.flatten(first)).toEqual(Option.some({ _tag: "Frame", detail: null }));
      }).pipe(Effect.scoped),
    ),
  15_000,
);

test("a record's later frames reach the view without a Flow it already has", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      // SAFETY: the test reads only a frame's title and Flow.
      const bare = (title: string) => ({ title }) as RunDetail;
      const sent = (title: string, said: string): RunDetail => ({
        ...bare(title),
        flow: mainFlow([flowNode("child", { said })]),
      });
      const frames = [
        sent("head", "working"),
        sent("texts", "working"),
        sent("diff", "still working"),
        bare("mr"),
        null,
        sent("again", "still working"),
      ];
      const doors = new DoorMap<Pick<Doors, "record">>();
      doors.set("i-1", {
        // SAFETY: the test calls only `runDetail`, which answers with the frames above.
        record: {
          runDetail: (() => Stream.fromIterable(frames)) as Doors["record"]["runDetail"],
        } as Doors["record"],
      });
      const keeper = yield* recordKeeper(doors);
      const seen = yield* keeper.open("i-1", "r-1").pipe(
        Stream.map(({ detail }) => detail),
        Stream.take(frames.length),
        Stream.runCollect,
      );
      const said = (one: RunDetail | null) =>
        Option.match(
          Arr.findFirst(one?.flow?.lanes[1]?.nodes ?? [], (node) => node.id === "child"),
          { onNone: () => one?.title ?? null, onSome: (node) => node.said },
        );
      expect(Arr.map(seen, said)).toEqual([
        "working",
        "texts",
        "still working",
        "mr",
        null,
        "still working",
      ]);
    }).pipe(Effect.scoped),
  ));
