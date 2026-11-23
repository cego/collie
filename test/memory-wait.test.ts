import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { hostname } from "node:os";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { writeConfigValue } from "../src/config";
import {
  holdsBudgetOf,
  MEMORY_WAIT,
  memoryWaitOf,
  waitForMemory,
  waitLine,
} from "../src/memory-wait";
import { RunRecords } from "../src/run-records";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const log = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(`${rig.stateDir}/agents/r1/agents.log`)
    .pipe(Effect.orElseSucceed(() => ""));
});

const waiting = (asker: string | null = null) =>
  waitForMemory({
    env: rig.pluginEnv(),
    stateDir: rig.stateDir,
    runId: "r1",
    what: "build's agent",
    asker,
  });

const settle = Effect.gen(function* () {
  for (let tries = 0; tries < 50; tries++) yield* TestClock.withLive(Effect.sleep("2 millis"));
});

const onTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));

test("a Machine with memory to spare starts at once, leaving no wait behind", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* waiting();
        expect(yield* memoryWaitOf("r1")).toBeNull();
        expect(yield* log).toBe("");
      }),
    ),
  ));

test("a short Machine holds the start, read again every 15 seconds, until it is not", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(2.1);
        const fiber = yield* Effect.forkChild(waiting("r1-build"));
        yield* settle;
        expect((yield* memoryWaitOf("r1"))?.sentence).toBe(
          `waiting for memory on ${hostname()}: 2.1 of 100.0 GB available`,
        );
        expect(yield* holdsBudgetOf("r1", "r1-build")).toBe(true);
        expect(yield* holdsBudgetOf("r1", "r1-review")).toBe(false);
        expect(yield* log).toContain(
          `build's agent: waiting for memory on ${hostname()}: 2.1 of 100.0 GB available`,
        );

        yield* rig.memory(40);
        yield* TestClock.adjust("14 seconds");
        yield* settle;
        expect(fiber.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("1 second");
        yield* settle;
        expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
        expect(yield* memoryWaitOf("r1")).toBeNull();
        expect(yield* log).toContain("build's agent: waited 15s for memory");
      }),
    ),
  ));

test("pressure that holds the start is named in the sentence", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(50, 90.75);
        const fiber = yield* Effect.forkChild(waiting());
        yield* settle;
        expect((yield* memoryWaitOf("r1"))?.sentence).toBe(
          `waiting for memory on ${hostname()}: 50.0 of 100.0 GB available, pressure 90.8`,
        );
        yield* Fiber.interrupt(fiber);
      }),
    ),
  ));

test("setting memory_hold to 0 releases a waiting start within one read", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(2);
        const fiber = yield* Effect.forkChild(waiting());
        yield* settle;
        yield* writeConfigValue(rig.userDir, "memory_hold", 0);
        yield* TestClock.adjust("15 seconds");
        yield* settle;
        expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true);
      }),
    ),
  ));

test("a stop ends the wait, and the Run's log says it was stopped", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(2);
        const fiber = yield* Effect.forkChild(waiting());
        yield* settle;
        yield* TestClock.adjust("30 seconds");
        yield* settle;
        yield* Fiber.interrupt(fiber);
        expect(yield* memoryWaitOf("r1")).toBeNull();
        expect(yield* log).toContain("build's agent: stopped after waiting 30s for memory");
      }),
    ),
  ));

test("a stop that lands as memory frees still stops the start", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(2);
        let stop = false;
        const fiber = yield* Effect.forkChild(
          waitForMemory({
            env: rig.pluginEnv(),
            stateDir: rig.stateDir,
            runId: "r1",
            what: "build's agent",
            // WARNING: the stop lands while memory is read, so memory is seen free before the stop is.
            stopped: Effect.suspend(() =>
              stop
                ? TestClock.withLive(Effect.sleep("100 millis")).pipe(Effect.as(true))
                : Effect.succeed(false),
            ),
          }),
        );
        yield* settle;
        yield* TestClock.adjust("14500 millis");
        yield* settle;
        yield* rig.memory(40);
        stop = true;
        yield* TestClock.adjust("500 millis");
        expect(yield* Fiber.join(fiber)).toBe("stopped");
        expect(yield* log).toContain("build's agent: stopped after waiting 15s for memory");
      }),
    ),
  ));

test("a wait whose host died, reading nothing for three of its periods, is no longer shown or held", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* (yield* RunRecords).setControl(
          MEMORY_WAIT,
          "r1",
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            what: "build's agent",
            sentence: "waiting for memory on vm-mk: 2.0 of 100.0 GB available",
            since: 0,
            read: 0,
            every: 15_000,
            asker: "r1-build",
          }).pipe(Effect.orDie),
          "0-1.json",
        );
        expect(yield* memoryWaitOf("r1")).not.toBeNull();
        yield* TestClock.adjust("46 seconds");
        expect(yield* memoryWaitOf("r1")).toBeNull();
        expect(yield* holdsBudgetOf("r1", "r1-build")).toBe(false);
      }),
    ),
  ));

test("a live wait reads again within its period, so it stays shown however long it waits", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.memory(2);
        const fiber = yield* Effect.forkChild(waiting());
        yield* settle;
        for (let period = 0; period < 4; period++) {
          yield* TestClock.adjust("15 seconds");
          yield* settle;
        }
        expect(yield* memoryWaitOf("r1")).not.toBeNull();
        yield* Fiber.interrupt(fiber);
      }),
    ),
  ));

test("a Machine short of disk holds the start, saying so on the card, until space frees", () =>
  runEffect(
    onTestClock(
      Effect.gen(function* () {
        yield* rig.disk(2);
        const fiber = yield* Effect.forkChild(waiting());
        yield* settle;
        const wait = yield* memoryWaitOf("r1");
        expect(wait === null ? null : waitLine(wait)).toBe(
          `Short of disk on ${hostname()}, waiting for space: / has 2.0 GiB free (2%).`,
        );

        yield* rig.disk(40);
        yield* TestClock.adjust("15 seconds");
        yield* settle;
        expect(yield* Fiber.join(fiber)).toBe("waited");
        expect(yield* memoryWaitOf("r1")).toBeNull();
        expect(yield* log).toContain("build's agent: waited 15s for disk");
      }),
    ),
  ));
