// A start that waits while its Machine is Short of memory, read again every 15 seconds
// (ADR-draft-new-work-waits-while-its-machine-is-short-of-memory, D2–D5).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { hostname } from "node:os";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { writeConfigValue } from "../src/config";
import { holdsBudgetOf, memoryWaitOf, waitForMemory } from "../src/memory-wait";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const runDir = () => `${rig.stateDir}/runs/r1`;

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

/** Lets the waiting fiber do its file IO, which the test clock does not drive. */
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
        expect(yield* memoryWaitOf(runDir())).toBeNull();
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
        expect((yield* memoryWaitOf(runDir()))?.sentence).toBe(
          `waiting for memory on ${hostname()}: 2.1 of 100.0 GB available`,
        );
        expect(yield* holdsBudgetOf(rig.stateDir, "r1", "r1-build")).toBe(true);
        expect(yield* holdsBudgetOf(rig.stateDir, "r1", "r1-review")).toBe(false);
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
        expect(yield* memoryWaitOf(runDir())).toBeNull();
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
        expect((yield* memoryWaitOf(runDir()))?.sentence).toBe(
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
        expect(yield* memoryWaitOf(runDir())).toBeNull();
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
            // The stop lands while it is read, so memory is seen free before the stop is.
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
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${runDir()}/memory-waits`, { recursive: true });
        yield* fs.writeFileString(
          `${runDir()}/memory-waits/0-1.json`,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            what: "build's agent",
            sentence: "waiting for memory on vm-mk: 2.0 of 100.0 GB available",
            since: 0,
            read: 0,
            every: 15_000,
            asker: "r1-build",
          }).pipe(Effect.orDie),
        );
        expect(yield* memoryWaitOf(runDir())).not.toBeNull();
        yield* TestClock.adjust("46 seconds");
        expect(yield* memoryWaitOf(runDir())).toBeNull();
        expect(yield* holdsBudgetOf(rig.stateDir, "r1", "r1-build")).toBe(false);
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
        expect(yield* memoryWaitOf(runDir())).not.toBeNull();
        yield* Fiber.interrupt(fiber);
      }),
    ),
  ));
