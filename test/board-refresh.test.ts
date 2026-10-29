import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { shareBoard } from "../src/board-stream";
import { runEffect } from "./support/effect";

test("a timer refresh leaves covered readers free, but a write during it waits for another build", () =>
  runEffect(
    Effect.gen(function* () {
      const changed = yield* Queue.unbounded<void>();
      const refresh = yield* Queue.unbounded<void>();
      const entered = yield* Queue.unbounded<number>();
      const release = yield* Queue.unbounded<void>();
      let builds = 0;
      const build = Effect.gen(function* () {
        const at = ++builds;
        yield* Queue.offer(entered, at);
        yield* Queue.take(release);
        return at;
      });
      const { boards } = yield* shareBoard({
        build,
        changed: Stream.fromQueue(changed),
        refresh: Stream.fromQueue(refresh),
      });
      expect(yield* Queue.take(entered)).toBe(1);
      yield* Queue.offer(release, undefined);
      expect(yield* Stream.runHead(boards)).toEqual(Option.some(1));

      yield* Queue.offer(refresh, undefined);
      expect(yield* Queue.take(entered)).toBe(2);
      const free = yield* Stream.runHead(boards).pipe(Effect.timeout("1 second"));
      expect(free).toEqual(Option.some(1));

      const seen = yield* Deferred.make<void>();
      yield* Queue.offer(changed, undefined);
      // The producer marks writes before handing them to the build buffer.
      yield* Effect.yieldNow;
      const reader = yield* boards.pipe(
        Stream.tap(() => Deferred.succeed(seen, undefined)),
        Stream.runHead,
        Effect.forkScoped,
      );
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(seen)).toBe(false);
      yield* Queue.offer(release, undefined);
      expect(yield* Queue.take(entered)).toBe(3);
      yield* Queue.offer(release, undefined);
      expect(yield* Fiber.join(reader)).toEqual(Option.some(3));
    }),
  ));
