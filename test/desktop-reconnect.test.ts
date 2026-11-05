// A Machine's connection is renewed under Desktop: a request it cut off fails naming the
// Machine, and a Run's details carry on over the next door.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Queue, Result, Stream } from "effect";
import {
  act,
  definitionsIn,
  DoorMap,
  type Door,
  type Doors,
  offersOn,
  recordEvents,
  type RecordEvent,
} from "../desktop/src/bun/machine";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import { HostRefused, type RunDetail } from "../src/board-model";
import type { HostDefinitions } from "../src/definitions-model";
import { ActionFailed, type KeptRecord } from "../desktop/src/shared/flock";
import { recordKeeper } from "../desktop/src/bun/records";
import { recordStanding } from "../desktop/src/shared/kept-records";
import { frameAt, recordDoor, unchanged, type Asked } from "./support/record-doors";
import { fastForward } from "./support/effect";

const machine = { profile: "vm", name: "vm-mk" };
const reached = (fake: Partial<Door>) => {
  // SAFETY: each test calls only what its fake answers.
  const desktop = fake as Door;
  return { machine, desktop };
};
/** A Run's details as its record's frames carry them. */
const runDetailOn = (doors: DoorMap<Pick<Doors, "record">>, installation: string, runId: string) =>
  recordEvents(doors, installation, runId).pipe(
    Stream.filterMap((event: RecordEvent) =>
      event._tag === "Frame" ? Result.succeed(event.detail) : Result.failVoid,
    ),
  );
const titles = (details: ReadonlyArray<{ readonly title: string } | null>) =>
  Arr.map(details, (detail) => detail?.title);

test("an action cut off by its Machine's renewed connection fails naming the Machine, under its request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      const door = reached({
        control: () => Deferred.await(closed).pipe(Effect.andThen(Effect.interrupt)),
      });
      const acting = yield* act(door, "hold-1", {
        _tag: "Control",
        runId: "r-1",
        control: "hold",
        set: true,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(closed, undefined);
      expect(yield* Fiber.join(acting)).toEqual(
        new ActionFailed({
          request: "hold-1",
          reason: "vm-mk's connection was renewed before this finished",
        }),
      );
    }),
  ));

test("a call whose caller lets go is still an interrupt", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asking = yield* offersOn(reached({ offers: () => Effect.never }), "r-1").pipe(
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const exit = yield* Fiber.interrupt(asking).pipe(Effect.andThen(Fiber.await(asking)));
      expect(Exit.hasInterrupts(exit)).toBe(true);
    }),
  ));

/** A door whose Run's details are whatever its queue is given, and which says it is open. */
const detailDoor = (name: string, open: Set<string>) =>
  Effect.map(
    Queue.unbounded<string, { readonly _tag: "Closed" | "Broken" | "Died" }>(),
    (queue) => ({
      queue,
      door: {
        // SAFETY: the tests read only a record's details.
        record: {
          // SAFETY: a stream, as the client gives one when not asked for a queue.
          runDetail: (() =>
            Stream.fromQueue(queue).pipe(
              // SAFETY: the tests read only a detail's title.
              Stream.map((title) => ({ title }) as RunDetail),
              Stream.catch(({ _tag }) =>
                _tag === "Died"
                  ? Stream.die(new Error("the Run could not be read"))
                  : _tag === "Broken"
                    ? Stream.fail(
                        new RpcClientError({
                          reason: new RpcClientDefect({ message: "socket closed", cause: null }),
                        }),
                      )
                    : Stream.fromEffect(Effect.interrupt),
              ),
              Stream.onStart(Effect.sync(() => open.add(name))),
              Stream.ensuring(Effect.sync(() => open.delete(name))),
            )) as Door["runDetail"],
        } as Door,
      },
    }),
  );

test("a Run's details follow its Machine from door to door, closed or broken, with no failure between", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const open = new Set<string>();
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* detailDoor("a", open);
      const b = yield* detailDoor("b", open);
      const c = yield* detailDoor("c", open);
      doors.set("i-1", a.door);
      const pull = yield* runDetailOn(doors, "i-1", "r-1").pipe(Stream.toPull);
      yield* Queue.offer(a.queue, "from a");
      expect(titles(yield* pull)).toEqual(["from a"]);
      doors.delete("i-1");
      yield* Queue.fail(a.queue, { _tag: "Closed" });
      doors.set("i-1", b.door);
      yield* Queue.offer(b.queue, "from b");
      expect(titles(yield* pull)).toEqual(["from b"]);
      yield* Queue.fail(b.queue, { _tag: "Broken" });
      doors.set("i-1", c.door);
      yield* Queue.offer(c.queue, "from c");
      expect(titles(yield* pull)).toEqual(["from c"]);
    }).pipe(Effect.scoped),
  ));

test("a Run's details wait for a Machine with no door yet, and end with nothing left open", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const open = new Set<string>();
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* detailDoor("a", open);
      const reading = yield* runDetailOn(doors, "i-1", "r-1").pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      doors.set("i-1", a.door);
      yield* Queue.offer(a.queue, "at last");
      expect(yield* Fiber.join(reading)).toHaveLength(1);
      expect(open).toEqual(new Set());

      const b = yield* detailDoor("b", open);
      const held = yield* runDetailOn(doors, "i-1", "r-1").pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.yieldNow;
      expect(open).toEqual(new Set(["a"]));
      yield* Fiber.interrupt(held);
      doors.set("i-1", b.door);
      yield* Effect.yieldNow;
      expect(open).toEqual(new Set());
    }),
  ));

test("a door that breaks and stays fails a Run's details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* detailDoor("a", new Set());
      doors.set("i-1", a.door);
      yield* Queue.fail(a.queue, { _tag: "Broken" });
      const failed = yield* fastForward(
        runDetailOn(doors, "i-1", "r-1").pipe(Stream.runDrain, Effect.flip),
        1_000,
      );
      expect(failed.reason).toContain("socket closed");
    }),
  ));

test("a host that cannot read a Run still fails its details", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* detailDoor("a", new Set());
      doors.set("i-1", a.door);
      yield* Queue.fail(a.queue, { _tag: "Died" });
      const exit = yield* runDetailOn(doors, "i-1", "r-1").pipe(Stream.runDrain, Effect.exit);
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  ));

test("a Machine's definitions are read over its door, as its other reads are", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const answer: HostDefinitions = { workflows: [], problems: [], personas: [], errors: ["x"] };
      const doors = new DoorMap<ReturnType<typeof reached>>();
      // SAFETY: answered as the client answers a call not asked to discard its reply.
      const answering = (reply: Effect.Effect<HostDefinitions, HostRefused>) =>
        reached({ definitions: (() => reply) as Door["definitions"] });
      doors.set("i-1", answering(Effect.succeed(answer)));
      doors.set("i-2", answering(Effect.fail(new HostRefused({ reason: "Unknown request tag" }))));
      expect(yield* definitionsIn(doors, "i-1")).toBe(answer);
      expect((yield* Effect.flip(definitionsIn(doors, "i-2"))).reason).toBe(
        "vm-mk: Unknown request tag",
      );
      expect((yield* Effect.flip(definitionsIn(doors, "i-3"))).reason).toBe(
        "that Machine is not connected",
      );
    }),
  ));

const keptTitles = (records: ReadonlyArray<KeptRecord>) =>
  Arr.map(records, ({ detail, asOf }) => ({ title: detail?.title, labelled: asOf !== null }));

test("a kept record is labelled while its door is gone, and current again once the next door says it is unchanged", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Array<Asked> = [];
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* recordDoor(asked);
      doors.set("i-1", a.door);
      const keeper = yield* recordKeeper(doors);
      const pull = yield* keeper.open("i-1", "r-1").pipe(Stream.toPull);
      yield* a.offer("r-1", frameAt("one", 4));
      const [current] = yield* pull;
      expect(keptTitles([current!])).toEqual([{ title: "one", labelled: false }]);
      expect(recordStanding(current!.asOf, null)).toBeNull();

      doors.delete("i-1");
      yield* a.close;
      const [lost] = yield* pull;
      expect(keptTitles([lost!])).toEqual([{ title: "one", labelled: true }]);
      const standing = recordStanding(lost!.asOf, null);
      expect(standing?.title).toBe("Reconnecting");
      expect(standing?.asOf).toBe(lost!.asOf);

      const b = yield* recordDoor(asked);
      doors.set("i-1", b.door);
      yield* b.offer("r-1", unchanged(4));
      const [again] = yield* pull;
      expect(keptTitles([again!])).toEqual([{ title: "one", labelled: false }]);
      expect(Arr.map(asked, ({ held }) => held?.seq)).toEqual([undefined, 4]);
    }).pipe(Effect.scoped),
  ));

test("a kept record whose Machine stays out of reach is labelled as its Machine is", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new DoorMap<Pick<Doors, "record">>();
      const a = yield* recordDoor([]);
      doors.set("i-1", a.door);
      const keeper = yield* recordKeeper(doors);
      const pull = yield* keeper.open("i-1", "r-1").pipe(Stream.toPull);
      yield* a.offer("r-1", frameAt("one", 4));
      yield* pull;
      doors.delete("i-1");
      yield* a.close;
      const [lost] = yield* pull;
      const outOfReach = { icon: "i-lucide-unplug", title: "vm-mk is out of reach", reason: "" };
      expect(recordStanding(lost!.asOf, outOfReach)).toEqual({
        ...outOfReach,
        asOf: lost!.asOf,
      });
      const waited = yield* pull.pipe(Effect.timeoutOption("200 millis"));
      expect(waited._tag).toBe("None");
    }).pipe(Effect.scoped),
  ));
