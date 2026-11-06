import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Fiber, Scheduler } from "effect";
import { makeForeground, servedNow } from "../src/foreground";
import { TurnScheduler } from "../src/turns";

test("a served fiber's turns come before those of busy background fibers", () => {
  let steps = 0;
  const busy = Effect.forever(Effect.suspend(() => (steps++, Effect.yieldNow)));
  return Effect.runPromise(
    Effect.gen(function* () {
      const foreground = yield* makeForeground;
      const background = yield* Effect.forEach(Arr.range(1, 3), () => Effect.forkChild(busy));
      yield* Effect.yieldNow;
      const before = steps;
      yield* foreground.serve(Effect.forEach(Arr.range(1, 50), () => Effect.yieldNow));
      const taken = steps - before;
      yield* Effect.forEach(background, Fiber.interrupt);
      return taken;
    }).pipe(
      Effect.forkChild,
      Effect.flatMap(Fiber.join),
      Effect.provideService(Scheduler.Scheduler, new TurnScheduler(servedNow)),
      Effect.map((taken) => expect(taken).toBeLessThan(10)),
    ),
  );
});
