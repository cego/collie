// A Machine's connection is renewed under Desktop: a request it cut off fails naming the
// Machine, and a Run's details carry on over the next door.

import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { act, DoorMap, type Door, offersOn, runDetailOn } from "../desktop/src/bun/machine";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import type { RunDetail } from "../src/board-model";
import { ActionFailed } from "../desktop/src/shared/flock";
import { fastForward } from "./support/effect";

const machine = { profile: "vm", name: "vm-mk" };
const reached = (fake: Partial<Door>) => {
  // SAFETY: each test calls only what its fake answers.
  const desktop = fake as Door;
  return { machine, desktop };
};
const titles = (details: ReadonlyArray<{ readonly title: string } | null>) =>
  details.map((detail) => detail?.title);

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
      door: reached({
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
      }),
    }),
  );

test("a Run's details follow its Machine from door to door, closed or broken, with no failure between", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const open = new Set<string>();
      const doors = new DoorMap<ReturnType<typeof reached>>();
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
      const doors = new DoorMap<ReturnType<typeof reached>>();
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
      const doors = new DoorMap<ReturnType<typeof reached>>();
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
      const doors = new DoorMap<ReturnType<typeof reached>>();
      const a = yield* detailDoor("a", new Set());
      doors.set("i-1", a.door);
      yield* Queue.fail(a.queue, { _tag: "Died" });
      const exit = yield* runDetailOn(doors, "i-1", "r-1").pipe(Stream.runDrain, Effect.exit);
      expect(Exit.hasDies(exit)).toBe(true);
    }),
  ));
