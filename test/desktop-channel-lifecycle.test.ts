import { expect, test } from "bun:test";
import {
  Array as Arr,
  Clock,
  Deferred,
  Effect,
  Fiber,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import {
  DoorMap,
  flockStream,
  openDoors,
  recordEvents,
  syncNow,
  type RouteChange,
  type BoardSource,
  type Doors,
  type Route,
} from "../desktop/src/bun/machine";
import type { FlockItem } from "../desktop/src/shared/flock";

const machine = { profile: "fixture", name: "vm-mk" };
const bridge = `${import.meta.dir}/fixtures/channel-bridge.ts`;
const identity = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      channel: Schema.String,
      generation: Schema.String,
      pid: Schema.Int,
    }),
  ),
);
const read = (door: Doors["chat"], input = {}) => door.read({ tool: "collie_workspaces", input });
const readIdentity = (door: Doors["chat"]) => read(door).pipe(Effect.flatMap(identity));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const [channel, mode] of [
  ["chat", "exit"],
  ["chat", "socket"],
  ["record", "socket"],
  ["chat", "rpc"],
  ["record", "exit"],
] as const)
  test(
    `a ${channel}-only ${mode} failure replaces the channels while the board stays live`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pids: number[] = [];
          const doors = new DoorMap<Doors>();
          const items = yield* Queue.unbounded<FlockItem>();
          let generation = 0;
          const route: Route = {
            machine,
            open: () =>
              Effect.gen(function* () {
                let desktop = 0;
                const opened = yield* openDoors(machine, (as) => [
                  process.execPath,
                  bridge,
                  as === "chat" ? "chat" : desktop++ === 0 ? "board" : "record",
                  String(++generation),
                ]);
                for (const channel of [opened.desktop, opened.record, opened.chat]) {
                  pids.push((yield* readIdentity(channel).pipe(Effect.orDie)).pid);
                }
                return opened;
              }),
            collie: () => Effect.die("no upgrade expected"),
          };
          const connection = yield* flockStream([route], doors, "0.132.3").pipe(
            Stream.runForEach((item) => Queue.offer(items, item)),
            Effect.forkScoped,
          );
          yield* Queue.take(items);
          const first = doors.get("fixture-vm")!;
          expect((yield* readIdentity(first.chat)).channel).toBe("chat");
          yield* read(first[channel], { break: mode }).pipe(Effect.exit);
          const next = yield* Queue.take(items).pipe(Effect.timeout("4 seconds"));
          expect("_tag" in next && next._tag).toBe("Lost");
          yield* Queue.take(items).pipe(Effect.timeout("4 seconds"));
          const renewed = doors.get("fixture-vm")!;
          expect(Arr.filter(Arr.take(pids, 3), alive)).toEqual([]);
          expect(renewed).not.toBe(first);
          expect((yield* readIdentity(renewed.chat)).channel).toBe("chat");
          const frame = yield* recordEvents(doors, "fixture-vm", "r-1").pipe(Stream.runHead);
          expect(frame).toEqual(Option.some({ _tag: "Frame", detail: null }));
          yield* Fiber.interrupt(connection);
          expect(doors.size).toBe(0);
          expect(Arr.filter(pids, alive)).toEqual([]);
        }).pipe(Effect.scoped),
      ),
    15_000,
  );

test("failed channel renewals close each generation before capped backoff, and stop when released", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* Deferred.make<never, { state: "unreachable"; reason: string }>();
      const items = yield* Queue.unbounded<FlockItem>();
      const times: number[] = [];
      let active = 0;
      let peak = 0;
      const route: Route<BoardSource> = {
        machine,
        open: () =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                active++;
                peak = Math.max(peak, active);
              }),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            );
            times.push(yield* Clock.currentTimeMillis);
            if (times.length > 1)
              return yield* Effect.fail({
                state: "unreachable" as const,
                reason: "bridge unavailable",
              });
            return {
              closed: Deferred.await(failed),
              board: Stream.make({
                _tag: "Snapshot" as const,
                installation: "fixture-vm",
                build: "0.132.3",
                protocol: 5,
                herds: [],
                tasks: [],
                seq: 0,
              }).pipe(Stream.concat(Stream.never)),
            };
          }),
        collie: () => Effect.die("no upgrade expected"),
      };
      const connection = yield* flockStream([route], new DoorMap(), "0.132.3").pipe(
        Stream.runForEach((item) => Queue.offer(items, item)),
        Effect.forkScoped,
      );
      yield* Queue.take(items);
      yield* Deferred.fail(failed, { state: "unreachable" as const, reason: "chat socket lost" });
      yield* TestClock.adjust(0);
      expect(active).toBe(0);
      yield* Queue.take(items);
      for (const millis of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
        yield* TestClock.adjust(millis);
        yield* Queue.take(items);
        expect(active).toBe(0);
      }
      expect(times).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000]);
      expect(peak).toBe(1);
      yield* Fiber.interrupt(connection);
      yield* TestClock.adjust("5 minutes");
      expect(times).toHaveLength(9);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test(
  "Sync now renews a same-version connection and restores calls on a fresh client",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const doors = new DoorMap<Doors>();
        const changes = yield* Queue.unbounded<RouteChange>();
        const items = yield* Queue.unbounded<FlockItem>();
        let generation = 0;
        const route: Route = {
          machine,
          open: () =>
            openDoors(machine, (as) => [process.execPath, bridge, as, String(++generation)]),
          collie: () => Effect.die("no upgrade expected"),
        };
        yield* flockStream([route], doors, "0.132.3", Stream.fromQueue(changes)).pipe(
          Stream.runForEach((item) => Queue.offer(items, item)),
          Effect.forkScoped,
        );
        yield* Queue.take(items);
        const before = yield* readIdentity(doors.get("fixture-vm")!.chat);
        const result = yield* syncNow(machine, [], {
          reopen: Queue.offer(changes, { _tag: "Reopen", profile: machine.profile }),
          sync: Effect.succeed(null),
          syncDefinitions: Effect.succeed(null),
          give: Effect.succeed([]),
        });
        expect(result.failed).toBe(false);
        yield* Queue.take(items).pipe(Effect.timeout("2 seconds"));
        yield* Queue.take(items).pipe(Effect.timeout("2 seconds"));
        const after = yield* readIdentity(doors.get("fixture-vm")!.chat);
        expect(after.pid).not.toBe(before.pid);
        expect(after.channel).toBe("chat");
      }).pipe(Effect.scoped),
    ),
  10_000,
);
