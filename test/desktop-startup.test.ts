import { expect, test } from "bun:test";
import { Array as Arr, Deferred, Effect, Queue, Stream } from "effect";
import { type BoardMessage, type BoardSnapshot, PROTOCOL } from "../src/board-model";
import { flockStream, type Route, type RouteChange } from "../desktop/src/bun/machine";
import type { FlockItem } from "../desktop/src/shared/flock";

const snapshot = (installation: string): BoardSnapshot => ({
  _tag: "Snapshot",
  installation,
  build: "1.0.5",
  protocol: PROTOCOL,
  files: true,
  seq: 0,
  tasks: [],
  herds: [],
});

interface Opening {
  readonly identity: {
    readonly installation: string;
    readonly protocol: number;
    readonly build: string;
  };
  readonly board: Stream.Stream<BoardMessage, { readonly message: string }>;
}

test("startup read connection: the identity-checked door is available before the first board and closes with its route", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const mayArrive = yield* Deferred.make<void>();
      const told: FlockItem[] = [];
      const doors = new Map<string, Opening>();
      const readDoors = new Map<string, Opening>();
      let closed = 0;
      const opened: Opening = {
        identity: { installation: "vm", protocol: PROTOCOL, build: "1.0.5" },
        board: Stream.fromEffect(
          Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Deferred.await(mayArrive))),
        ).pipe(
          Stream.flatMap(() => Stream.make(snapshot("vm"))),
          Stream.concat(Stream.never),
        ),
      };
      const route: Route<Opening> = {
        machine: { profile: "p-vm", name: "vm-mk", route: "link" },
        open: () =>
          Effect.acquireRelease(Effect.succeed(opened), () =>
            Effect.sync(() => {
              closed++;
            }),
          ),
        collie: () => Effect.die("no upgrade is due"),
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flockStream([route], doors, "1.0.5", Stream.empty, () => {}, readDoors).pipe(
            Stream.runForEach((item) => Effect.sync(() => told.push(item))),
            Effect.forkScoped,
          );
          yield* Deferred.await(subscribed);
          expect(readDoors.get("p-vm")).toBe(opened);
          expect(doors.size).toBe(0);
          expect(Arr.filter(told, (item) => "message" in item)).toEqual([]);
          expect(closed).toBe(0);

          yield* Deferred.succeed(mayArrive, undefined);
          while (!Arr.some(told, (item) => "message" in item)) yield* Effect.yieldNow;
          expect(Arr.filter(told, (item) => "message" in item)).toMatchObject([
            { machine: { installation: "vm" }, message: { _tag: "Snapshot", installation: "vm" } },
          ]);
          expect(doors.get("vm")).toBe(opened);
        }),
      );
      expect(doors.size).toBe(0);
      expect(readDoors.size).toBe(0);
      expect(closed).toBe(1);
    }),
  ));

test("startup read connection: removing an alias keeps another route to the same host readable", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const doors = new Map<string, Opening>();
        const readDoors = new Map<string, Opening>();
        const changes = yield* Queue.unbounded<RouteChange<Opening>>();
        let subscribed = 0;
        const route = (profile: string): Route<Opening> => ({
          machine: { profile, name: profile },
          open: () =>
            Effect.succeed({
              identity: { installation: "vm", protocol: PROTOCOL, build: "1.0.5" },
              board: Stream.never.pipe(Stream.onStart(Effect.sync(() => subscribed++))),
            }),
          collie: () => Effect.die("no upgrade is due"),
        });
        yield* flockStream(
          [route("first"), route("second")],
          doors,
          "1.0.5",
          Stream.fromQueue(changes),
          () => {},
          readDoors,
        ).pipe(Stream.runDrain, Effect.forkScoped);
        while (subscribed < 2) yield* Effect.yieldNow;
        const second = readDoors.get("second");
        expect(readDoors.has("first")).toBe(true);
        expect(second).toBeDefined();
        const done = yield* Deferred.make<void>();
        yield* Queue.offer(changes, { _tag: "Remove", profile: "first", done });
        yield* Deferred.await(done);
        expect(readDoors.has("first")).toBe(false);
        expect(readDoors.get("second")).toBe(second);
        expect(doors.size).toBe(0);
      }),
    ),
  ));

test("startup read connection: a board naming another installation is refused and its identity-checked door is retired", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doors = new Map<string, Opening>();
      const readDoors = new Map<string, Opening>();
      let closed = 0;
      const opened: Opening = {
        identity: { installation: "vm", protocol: PROTOCOL, build: "1.0.5" },
        board: Stream.make(snapshot("another-machine")).pipe(Stream.concat(Stream.never)),
      };
      const route: Route<Opening> = {
        machine: { profile: "p-vm", name: "vm-mk", route: "link" },
        open: () =>
          Effect.acquireRelease(Effect.succeed(opened), () =>
            Effect.sync(() => {
              closed++;
            }),
          ),
        collie: () => Effect.succeed({ code: 0, out: "collie v1.0.5", err: "" }),
      };
      const result = yield* Effect.scoped(
        flockStream([route], doors, "1.0.5", Stream.empty, () => {}, readDoors).pipe(
          Stream.take(1),
          Stream.runCollect,
        ),
      );
      expect(result).toMatchObject([{ _tag: "Lost", state: "unreachable" }]);
      expect(doors.size).toBe(0);
      expect(readDoors.size).toBe(0);
      expect(closed).toBe(1);
    }),
  ));
