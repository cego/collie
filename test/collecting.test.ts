import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { DateTime, Deferred, Effect, Fiber, FileSystem, Ref } from "effect";
import { waitForOutput } from "../src/agents";
import type { CollectingApi } from "../src/collecting";
import { Collecting, collectingLayer, owedFor, released } from "../src/collecting";
import { runEffect } from "./support/effect";

const ended = (...ids: ReadonlyArray<[string, number]>) => ({
  under: false,
  since: null,
  ended: Arr.map(ids, ([id, at]) => ({ id, at, began: 0 })),
  untold: [],
});

const polls = (counter: Ref.Ref<number>, wanted: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i += 1) {
      if ((yield* Ref.get(counter)) >= wanted) {
        return;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`the collector did not poll ${wanted} times`));
  });

const verifyUnder = (held: CollectingApi, id: string) =>
  Effect.gen(function* () {
    const under = yield* Deferred.make<void>();
    const end = yield* Deferred.make<void>();
    const running = yield* Effect.forkChild(
      held.duringVerify(
        "r",
        "a",
        Deferred.succeed(under, undefined).pipe(Effect.andThen(Deferred.await(end))),
        () => id,
      ),
    );
    yield* Deferred.await(under);
    return {
      end: () => Deferred.succeed(end, undefined).pipe(Effect.andThen(Fiber.await(running))),
    };
  });

const waiting = (collector: Fiber.Fiber<string | null, never>) =>
  Effect.sync(() => collector.pollUnsafe() === undefined);

test("an Output rewritten after its verify ended is not taken until that verify is told", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collector-" });
      const output = `${dir}/build.json`;
      const held = yield* Collecting;
      yield* held.during(
        "r",
        "a",
        Effect.gen(function* () {
          const underway = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const verify = yield* Effect.forkChild(
            held.duringVerify(
              "r",
              "a",
              Deferred.succeed(underway, undefined).pipe(Effect.andThen(Deferred.await(finish))),
              () => "v1",
            ),
          );
          yield* Deferred.await(underway);
          yield* fs.writeFileString(output, '{"verdict":"interim"}');
          const polling = yield* Deferred.make<void>();
          let settled = false;
          const collector = yield* Effect.forkChild(
            waitForOutput(output, null, {
              pollMs: 100,
              budgetMs: 1000,
              counts: Effect.succeed(false),
              usable: () => true,
              status: Effect.sync(() => (settled ? "idle" : "working")),
              holding: Effect.tap(held.verifying("r", "a"), () =>
                Deferred.succeed(polling, undefined).pipe(Effect.ignore),
              ),
              told: () => Effect.succeed(true),
            }),
          );
          yield* Deferred.await(polling);
          yield* Deferred.succeed(finish, undefined);
          yield* Fiber.await(verify);
          yield* fs.writeFileString(output, '{"verdict":"rewritten"}');
          const waiting = yield* Fiber.await(collector).pipe(Effect.timeoutOption("150 millis"));
          expect(Option.isNone(waiting)).toBe(true);
          settled = true;
          expect(yield* Fiber.join(collector)).toBe('{"verdict":"rewritten"}');
        }),
      );
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a byte-identical rewrite during a verify waits for that verify's tell", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collector-" });
      const output = `${dir}/build.json`;
      const held = yield* Collecting;
      yield* held.during(
        "r",
        "a",
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const settled = yield* Ref.make(false);
          const told = new Set<string>();
          const collector = yield* Effect.forkChild(
            waitForOutput(output, null, {
              pollMs: 5,
              budgetMs: 5000,
              counts: Effect.succeed(false),
              usable: () => true,
              status: Effect.map(Ref.get(settled), (over) => (over ? "idle" : "working")),
              holding: Effect.tap(held.verifying("r", "a"), () =>
                Ref.update(counter, (seen) => seen + 1),
              ),
              told: (id) => Effect.sync(() => told.has(id)),
            }),
          );
          const first = yield* verifyUnder(held, "v1");
          yield* fs.writeFileString(output, '{"verdict":"same"}');
          yield* polls(counter, 2);
          yield* first.end();
          told.add("v1");
          const second = yield* verifyUnder(held, "v2");
          const marked = yield* Ref.get(counter);
          yield* fs.writeFileString(output, '{"verdict":"same"}');
          yield* polls(counter, marked + 2);
          yield* Ref.set(settled, true);
          yield* polls(counter, marked + 4);
          expect(yield* waiting(collector)).toBe(true);
          yield* second.end();
          yield* polls(counter, marked + 6);
          expect(yield* waiting(collector)).toBe(true);
          told.add("v2");
          expect(yield* Fiber.join(collector)).toBe('{"verdict":"same"}');
        }),
      );
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a write during a verify keeps that verify owed after a later write", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collector-" });
      const output = `${dir}/build.json`;
      const held = yield* Collecting;
      yield* held.during(
        "r",
        "a",
        Effect.gen(function* () {
          const counter = yield* Ref.make(0);
          const told = new Set<string>();
          const collector = yield* Effect.forkChild(
            waitForOutput(output, null, {
              pollMs: 5,
              budgetMs: 5000,
              counts: Effect.succeed(false),
              usable: () => true,
              status: Effect.succeed("idle"),
              holding: Effect.tap(held.verifying("r", "a"), () =>
                Ref.update(counter, (seen) => seen + 1),
              ),
              told: (id) => Effect.sync(() => told.has(id)),
            }),
          );
          const only = yield* verifyUnder(held, "v2");
          const marked = yield* Ref.get(counter);
          yield* fs.writeFileString(output, '{"verdict":"middle"}');
          yield* polls(counter, marked + 1);
          expect(yield* waiting(collector)).toBe(true);
          yield* only.end();
          const later = yield* Ref.get(counter);
          yield* fs.writeFileString(output, '{"verdict":"later"}');
          yield* polls(counter, later + 2);
          expect(yield* waiting(collector)).toBe(true);
          told.add("v2");
          expect(yield* Fiber.join(collector)).toBe('{"verdict":"later"}');
        }),
      );
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a rewrite during a second verify waits for that verify too", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collector-" });
      const output = `${dir}/build.json`;
      const held = yield* Collecting;
      yield* held.during(
        "r",
        "a",
        Effect.gen(function* () {
          const under1 = yield* Deferred.make<void>();
          const end1 = yield* Deferred.make<void>();
          const first = yield* Effect.forkChild(
            held.duringVerify(
              "r",
              "a",
              Deferred.succeed(under1, undefined).pipe(Effect.andThen(Deferred.await(end1))),
              () => "v1",
            ),
          );
          yield* Deferred.await(under1);
          yield* fs.writeFileString(output, '{"verdict":"interim"}');
          const polling = yield* Deferred.make<void>();
          let settled = false;
          const told = new Set<string>();
          const collector = yield* Effect.forkChild(
            waitForOutput(output, null, {
              pollMs: 5,
              budgetMs: 5000,
              counts: Effect.succeed(false),
              usable: () => true,
              status: Effect.sync(() => (settled ? "idle" : "working")),
              holding: Effect.tap(held.verifying("r", "a"), () =>
                Deferred.succeed(polling, undefined).pipe(Effect.ignore),
              ),
              told: (id) => Effect.sync(() => told.has(id)),
            }),
          );
          yield* Deferred.await(polling);
          yield* Deferred.succeed(end1, undefined);
          yield* Fiber.await(first);
          const under2 = yield* Deferred.make<void>();
          const end2 = yield* Deferred.make<void>();
          const second = yield* Effect.forkChild(
            held.duringVerify(
              "r",
              "a",
              Deferred.succeed(under2, undefined).pipe(Effect.andThen(Deferred.await(end2))),
              () => "v2",
            ),
          );
          yield* Deferred.await(under2);
          yield* fs.writeFileString(output, '{"verdict":"rewritten"}');
          told.add("v1");
          settled = true;
          const waiting = yield* Fiber.await(collector).pipe(Effect.timeoutOption("300 millis"));
          expect(Option.isNone(waiting)).toBe(true);
          told.add("v2");
          yield* Deferred.succeed(end2, undefined);
          yield* Fiber.await(second);
          expect(yield* Fiber.join(collector)).toBe('{"verdict":"rewritten"}');
        }),
      );
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("an Output written before its verify began is taken while that verify is still under", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collector-" });
      const output = `${dir}/build.json`;
      const held = yield* Collecting;
      yield* held.during(
        "r",
        "a",
        Effect.gen(function* () {
          const earlier = DateTime.toDate(DateTime.subtract(DateTime.nowUnsafe(), { seconds: 30 }));
          yield* fs.writeFileString(output, '{"verdict":"done"}');
          yield* fs.utimes(output, earlier, earlier);
          const underway = yield* Deferred.make<void>();
          const verify = yield* Effect.forkChild(
            held.duringVerify(
              "r",
              "a",
              Deferred.succeed(underway, undefined).pipe(Effect.andThen(Effect.never)),
              () => "v1",
            ),
          );
          yield* Deferred.await(underway);
          const text = yield* waitForOutput(output, null, {
            pollMs: 5,
            budgetMs: 100,
            counts: Effect.succeed(true),
            usable: () => true,
            status: Effect.succeed("working"),
            holding: held.verifying("r", "a"),
            told: () => Effect.succeed(true),
          });
          expect(text).toBe('{"verdict":"done"}');
          yield* Fiber.interrupt(verify);
        }),
      );
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a verify that began after the Output was written is not one it waits on", () => {
  const hold = {
    under: false,
    since: null,
    ended: [{ id: "v1", began: 4000, at: 5000 }],
    untold: [],
  };
  expect(owedFor(100, hold)).toEqual([]);
  expect(owedFor(4500, hold)).toEqual(["v1"]);
});

test("every verify that ended after the Output was written is owed its tell, not only the last", () => {
  const hold = ended(["v1", 150], ["v2", 160]);
  expect(owedFor(100, hold)).toEqual(["v1", "v2"]);
  expect(released(owedFor(100, hold), true, (one) => one === "v2")).toBe(false);
  expect(released(owedFor(100, hold), true, () => true)).toBe(true);
});

test("a verify that ended before the Output was written is not something that Output waits on", () => {
  expect(owedFor(200, ended(["v1", 150]))).toEqual([]);
  expect(released(owedFor(200, ended(["v1", 150])), false, () => false)).toBe(false);
});

test("an Output is not taken until the agent is idle and its tell was taken", () => {
  const owed = owedFor(100, ended(["v1", 150]));
  expect(released(owed, false, () => true)).toBe(false);
  expect(released(owed, true, () => false)).toBe(false);
  expect(released(owed, true, () => true)).toBe(true);
});

test("a collection that has not ended is never released", () => {
  expect(released([], false, () => true)).toBe(false);
  expect(released([], true, () => true)).toBe(true);
});

test("a finished agent's verify is retired once no collection needs it", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
          expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(1);
        }),
      );
      expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(0);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a collection of another agent keeps no agent's verify alive", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      const held = yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
          yield* collecting.during("r", "b", Effect.succeed(null));
          expect(yield* collecting.has("r", "a")).toBe(true);
          expect(yield* collecting.has("r", "b")).toBe(false);
          return (yield* collecting.verifying("r", "a")).ended.length;
        }),
      );
      expect(held).toBe(1);
      expect((yield* collecting.verifying("r", "a")).ended).toHaveLength(0);
      expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a launch's own collection is counted apart from the agent's", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.during(
        "r",
        "a",
        Effect.gen(function* () {
          expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
          yield* collecting.during(
            "r",
            "a",
            Effect.gen(function* () {
              expect(yield* collecting.has("r", "a", "launch-1")).toBe(true);
              expect(yield* collecting.has("r", "a")).toBe(true);
            }),
            "launch-1",
          );
          expect(yield* collecting.has("r", "a", "launch-1")).toBe(false);
          expect(yield* collecting.has("r", "a")).toBe(true);
        }),
        "launch-2",
      );
      expect(yield* collecting.has("r", "a", "launch-2")).toBe(false);
      expect(yield* collecting.has("r", "a")).toBe(false);
    }).pipe(Effect.provide(collectingLayer)),
  ));

test("a verify whose tell could not be sent is not released by the absence of a tell", () =>
  runEffect(
    Effect.gen(function* () {
      const collecting = yield* Collecting;
      yield* collecting.duringVerify("r", "a", Effect.succeed("v1"), (one) => one);
      expect((yield* collecting.verifying("r", "a")).untold).toEqual([]);
      yield* collecting.markUntold("r", "a", "v1");
      expect((yield* collecting.verifying("r", "a")).untold).toEqual(["v1"]);
    }).pipe(Effect.provide(collectingLayer)),
  ));
