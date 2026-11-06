// Desktop holds a record's host subscription while the view holds it: one opened again is
// served from it, a frame goes only to its own record, and an older host's frames are whole.

import { expect, test } from "bun:test";
import { Array as Arr, Effect, Fiber, Stream } from "effect";
import { DoorMap, type Doors } from "../desktop/src/bun/machine";
import { recordKeeper } from "../desktop/src/bun/records";
import type { KeptRecord } from "../desktop/src/shared/flock";
import { frame, frameAt, recordDoor, type Asked } from "./support/record-doors";

const shownBy = (done: () => boolean) =>
  Effect.gen(function* () {
    while (!done()) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("2 seconds"));

const said = (records: ReadonlyArray<KeptRecord>) =>
  Arr.map(records, ({ detail, asOf }) => `${detail?.title}${asOf === null ? "" : " (as of)"}`);

test("with A, B and C selected 100 ms apart and A's frame last, C's record shows only C's", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Array<Asked> = [];
      const doors = new DoorMap<Pick<Doors, "record">>();
      const door = yield* recordDoor(asked);
      doors.set("i-1", door.door);
      const keeper = yield* recordKeeper(doors);
      const shown = {
        A: new Array<KeptRecord>(),
        B: new Array<KeptRecord>(),
        C: new Array<KeptRecord>(),
      };
      const show = (run: keyof typeof shown) =>
        keeper.open("i-1", run).pipe(
          Stream.runForEach((record) => Effect.sync(() => shown[run].push(record))),
          Effect.forkChild,
        );
      // The view's own hold on A, as it keeps a record it showed.
      yield* keeper.open("i-1", "A").pipe(Stream.runDrain, Effect.forkChild);
      const a = yield* show("A");
      yield* Effect.sleep("100 millis");
      const b = yield* show("B");
      yield* Fiber.interrupt(a);
      yield* Effect.sleep("100 millis");
      const c = yield* show("C");
      yield* Fiber.interrupt(b);
      yield* door.offer("C", frameAt("C", 1));
      yield* door.offer("B", frameAt("B", 1));
      yield* door.offer("A", frameAt("A", 1));
      yield* shownBy(() => shown.C.length > 0);
      expect(said(shown.C)).toEqual(["C"]);
      yield* Fiber.interrupt(c);

      // A's frame has reached the record the view holds, and the record shown before it had none.
      const again = yield* keeper.open("i-1", "A").pipe(Stream.runHead);
      expect(said(Arr.fromOption(again))).toEqual(["A"]);
      expect(said(shown.A)).toEqual([]);
      expect(Arr.map(asked, ({ runId }) => runId).sort()).toEqual(["A", "B", "C"]);
    }).pipe(Effect.scoped),
  ));

test("against a host that ignores what is held, a kept record is labelled until a whole frame comes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const older = yield* recordDoor([]);
      doors.set("i-1", older.door);
      const keeper = yield* recordKeeper(doors);
      const shown = new Array<KeptRecord>();
      yield* keeper.open("i-1", "r-1").pipe(
        Stream.runForEach((record) => Effect.sync(() => shown.push(record))),
        Effect.forkChild,
      );
      yield* older.offer("r-1", frame("one"));
      yield* shownBy(() => shown.length === 1);
      doors.delete("i-1");
      yield* older.close;
      yield* shownBy(() => shown.length === 2);
      expect(said(shown)).toEqual(["one", "one (as of)"]);

      const askedBack: Array<Asked> = [];
      const back = yield* recordDoor(askedBack);
      doors.set("i-1", back.door);
      yield* shownBy(() => askedBack.length > 0);
      expect(said(shown)).toEqual(["one", "one (as of)"]);
      yield* back.offer("r-1", frame("two"));
      yield* shownBy(() => shown.length === 3);
      expect(said(shown)).toEqual(["one", "one (as of)", "two"]);
    }).pipe(Effect.scoped),
  ));

test("a record its host ends while its door stays is kept current", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const door = yield* recordDoor([]);
      doors.set("i-1", door.door);
      const keeper = yield* recordKeeper(doors);
      const pull = yield* keeper.open("i-1", "r-1").pipe(Stream.toPull);
      yield* door.offer("r-1", frameAt("done", 3));
      expect(said(yield* pull)).toEqual(["done"]);
      yield* door.close;
      const after = yield* pull.pipe(Effect.timeoutOption("100 millis"));
      expect(after._tag).toBe("None");
    }).pipe(Effect.scoped),
  ));

test("a kept record is weighed in the bytes its frame encodes to", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const door = yield* recordDoor([]);
      doors.set("i-1", door.door);
      const keeper = yield* recordKeeper(doors);
      const pull = yield* keeper.open("i-1", "r-1").pipe(Stream.toPull);
      // `{"title":"ææææ"}`: twelve ASCII bytes and four two-byte letters.
      yield* door.offer("r-1", frame("ææææ"));
      const [record] = yield* pull;
      expect(record?.bytes).toBe(20);
    }).pipe(Effect.scoped),
  ));
