// A listing or sweep slower than the host's slow-call threshold says how long gathering its
// sweepers and judging each kind took, so its host log shows where the time went.

import { expect, test } from "bun:test";
import { Duration, Effect, Fiber, FileSystem, Logger } from "effect";
import { TestClock } from "effect/testing";
import { judge, sweep, type Sweeper } from "../src/cleanup";
import { runEffect } from "./support/effect";
import * as Layer from "effect/Layer";

const judgedIn = (kind: string, took: Duration.Input): Sweeper => ({
  kind,
  judge: Effect.sleep(took).pipe(Effect.as({ remove: [], keep: [] })),
  remove: () => Effect.succeed({ kept: "never asked" }),
});

const warnedOver = <A, E, R>(effect: Effect.Effect<A, E, R>, passes: Duration.Input) =>
  Effect.gen(function* () {
    const warned: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warned.push(String(message));
    });
    yield* Effect.gen(function* () {
      const running = yield* Effect.forkChild(effect);
      yield* TestClock.adjust(passes);
      yield* Fiber.join(running);
    }).pipe(Effect.provide(Logger.layer([logger]).pipe(Layer.provideMerge(TestClock.layer()))));
    return warned;
  });

test("a listing over 2 s says each kind's judging time, slowest first, and a faster one says nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const slow = [judgedIn("worktree", "1 second"), judgedIn("task", "3 seconds")];
      expect(yield* warnedOver(judge(slow), "4 seconds")).toEqual([
        "the cleanup listing took 4000 ms; judging took task 3000 ms, worktree 1000 ms",
      ]);
      const quick = [judgedIn("worktree", "500 millis"), judgedIn("task", "1 second")];
      expect(yield* warnedOver(judge(quick), "2 seconds")).toEqual([]);
    }),
  ));

test("a sweep over 2 s says the same of itself", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-timed-" });
      const slow = [judgedIn("worktree", "1 second"), judgedIn("task", "3 seconds")];
      expect(yield* warnedOver(sweep(slow, dir, "host"), "4 seconds")).toEqual([
        "the cleanup sweep took 4000 ms; judging took task 3000 ms, worktree 1000 ms",
      ]);
      const quick = [judgedIn("worktree", "500 millis"), judgedIn("task", "1 second")];
      expect(yield* warnedOver(sweep(quick, dir, "host"), "2 seconds")).toEqual([]);
    }),
  ));

test("the time spent gathering the sweepers counts, and is named", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "sweep-timed-" });
      const gathered = Effect.sleep("3 seconds").pipe(
        Effect.as([judgedIn("worktree", "500 millis")]),
      );
      expect(yield* warnedOver(judge(gathered), "3500 millis")).toEqual([
        "the cleanup listing took 3500 ms; gathering took 3000 ms; judging took worktree 500 ms",
      ]);
      expect(yield* warnedOver(sweep(gathered, dir, "host"), "3500 millis")).toEqual([
        "the cleanup sweep took 3500 ms; gathering took 3000 ms; judging took worktree 500 ms",
      ]);
    }),
  ));
