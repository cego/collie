import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Deferred, Option, Ref, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import { rosterFollowed } from "../desktop/src/bun/machine";
import type { Route } from "../desktop/src/bun/machine";
import type { FlockItem } from "../desktop/src/shared/flock";
import type { HerdrMachine } from "../src/peers-model";
import { platformLayer } from "../src/platform";
import type { PlatformServices } from "../src/platform";
import { fastForward } from "./support/effect";

const run = <A, E>(effect: Effect.Effect<A, E, PlatformServices | Scope.Scope>) =>
  Effect.runPromise(fastForward(effect).pipe(Effect.provide(platformLayer)));

const runFar = <A, E>(effect: Effect.Effect<A, E, PlatformServices | Scope.Scope>) =>
  Effect.runPromise(fastForward(effect, 15_000).pipe(Effect.provide(platformLayer)));

const until = (what: () => boolean) =>
  Effect.suspend(() => (what() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry(Schedule.spaced("5 millis")),
  );

const VM: HerdrMachine = {
  id: "vm",
  label: "vm",
  target: "mk@vm",
  session: "default",
  enabled: true,
};

const routeOf = (machine: HerdrMachine) => {
  const returned: Route = {
    machine: { profile: machine.id, name: machine.label, target: machine.target, route: "ssh" },
    open: () => Effect.die("nothing connects in this test"),
    collie: () => Effect.die("nothing is asked in this test"),
  };
  return returned;
};

const nameOf = (item: FlockItem) =>
  "machine" in item ? `${item.machine.profile} ${"_tag" in item ? item._tag : ""}` : item._tag;

interface Harness {
  readonly reads: Array<boolean>;
  readonly opened: Array<string>;
  readonly told: Array<FlockItem>;
}

const following = (
  ready: Ref.Ref<boolean>,
  listed: ReadonlyArray<HerdrMachine>,
  dropped: ReadonlyArray<string>,
  paired: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const reads: Array<boolean> = [];
    const opened: Array<string> = [];
    const told: Array<FlockItem> = [];
    const harness: Harness = { reads, opened, told };
    yield* rosterFollowed(
      Effect.gen(function* () {
        const up = yield* Ref.get(ready);
        reads.push(up);
        return up ? listed : yield* Effect.fail("core has not answered yet");
      }),
      Effect.sync(() => ({ profiles: [...opened], dropped })),
      Effect.succeed(paired),
      (machine) =>
        Effect.sync(() => {
          opened.push(machine.id);
          return routeOf(machine);
        }),
    ).pipe(
      Stream.runForEach((item) => Effect.sync(() => void told.push(item))),
      Effect.forkScoped,
    );
    return harness;
  });

test("Desktop routes a Machine core lists only after it started, and never twice", () =>
  run(
    Effect.gen(function* () {
      const ready = yield* Ref.make(false);
      const { reads, opened, told } = yield* following(ready, [VM], [], []);

      yield* until(() => reads.length >= 2);
      expect(opened).toEqual([]);

      yield* Ref.set(ready, true);
      yield* until(() => opened.length > 0);
      yield* until(() => reads.length >= 6);

      expect(opened).toEqual(["vm"]);
      expect(Arr.filter(told, (item) => nameOf(item) === "vm Routed")).toHaveLength(1);
    }),
  ));

test("a paired Machine stays visible while core's list is unread, and its row goes once core lists it", () =>
  run(
    Effect.gen(function* () {
      const ready = yield* Ref.make(false);
      const { reads, told } = yield* following(ready, [VM], [], ["vm"]);

      yield* until(() => Arr.some(told, (item) => nameOf(item) === "paired:vm Lost"));
      const lost = Arr.findFirst(told, (item) => nameOf(item) === "paired:vm Lost");
      expect(Option.getOrUndefined(lost)).toMatchObject({
        _tag: "Lost",
        state: "unreachable",
        reason: "core has not answered yet",
      });

      yield* Ref.set(ready, true);
      yield* until(() => Arr.some(told, (item) => nameOf(item) === "vm Routed"));

      expect(Arr.map(told, nameOf)).toContain("paired:vm Removed");
      expect(Arr.filter(reads, (up) => up)).toHaveLength(1);
    }),
  ));

test("a Machine a human removed while a roster read is pending is not routed from that reply", () =>
  run(
    Effect.gen(function* () {
      const replied = yield* Deferred.make<void>();
      const dropped = new Set<string>();
      const reads: Array<number> = [];
      const opened: Array<string> = [];
      const told: Array<FlockItem> = [];
      yield* rosterFollowed(
        Effect.gen(function* () {
          reads.push(1);
          yield* Deferred.await(replied);
          return [VM];
        }),
        Effect.sync(() => ({ profiles: [], dropped: [...dropped] })),
        Effect.succeed([]),
        (machine) =>
          Effect.sync(() => {
            opened.push(machine.id);
            return routeOf(machine);
          }),
      ).pipe(
        Stream.runForEach((item) => Effect.sync(() => void told.push(item))),
        Effect.forkScoped,
      );

      yield* until(() => reads.length >= 1);
      yield* Effect.sync(() => dropped.add("vm"));
      yield* Deferred.succeed(replied, undefined);
      yield* until(() => reads.length >= 3);

      expect(opened).toEqual([]);
      expect(Arr.filter(told, (item) => nameOf(item) === "vm Routed")).toEqual([]);
    }),
  ));

test("a Machine a human removed while an unread roster is retried is not shown as a placeholder", () =>
  run(
    Effect.gen(function* () {
      const replied = yield* Deferred.make<void>();
      const dropped = new Set<string>();
      const reads: Array<number> = [];
      const told: Array<FlockItem> = [];
      yield* rosterFollowed(
        Effect.gen(function* () {
          reads.push(1);
          yield* Deferred.await(replied);
          return yield* Effect.fail("core is unread");
        }),
        Effect.sync(() => ({ profiles: [], dropped: [...dropped] })),
        Effect.succeed(["vm"]),
        (machine) => Effect.sync(() => routeOf(machine)),
      ).pipe(
        Stream.runForEach((item) => Effect.sync(() => void told.push(item))),
        Effect.forkScoped,
      );

      yield* until(() => reads.length >= 1);
      yield* Effect.sync(() => dropped.add("vm"));
      yield* Deferred.succeed(replied, undefined);
      yield* until(() => reads.length >= 3);

      expect(told).toEqual([]);
    }),
  ));

test("a Machine a human removed while Desktop ran is not routed from a stale list", () =>
  run(
    Effect.gen(function* () {
      const ready = yield* Ref.make(true);
      const { reads, opened } = yield* following(ready, [VM], ["vm"], ["vm"]);

      yield* until(() => reads.length >= 4);
      expect(opened).toEqual([]);
    }),
  ));

test("a finished roster round is not kept by the round after it", () =>
  runFar(
    Effect.gen(function* () {
      const ready = yield* Ref.make(true);
      const { reads } = yield* following(ready, [], [], []);

      yield* until(() => reads.length >= 50);
      Bun.gc(true);
      const settled = process.memoryUsage().heapUsed;
      yield* until(() => reads.length >= 250);
      Bun.gc(true);
      const later = process.memoryUsage().heapUsed;

      expect(later - settled).toBeLessThan(512 * 1024);
    }),
  ));
