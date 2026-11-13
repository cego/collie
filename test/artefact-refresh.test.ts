import { expect, test } from "bun:test";
import { Clock, Deferred, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import * as Str from "effect/String";
import { refreshJobs } from "../src/artefact-refresh";
import { runEffect } from "./support/effect";

test("refresh coalesces sources, limits work, times out and rotates past failing sources", () =>
  runEffect(
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      yield* clock.setTime(0);
      yield* Effect.gen(function* () {
        const jobs = refreshJobs();
        const entered = yield* Queue.unbounded<string>();
        const release = yield* Deferred.make<void>();
        let active = 0;
        let peak = 0;
        let copies = 0;
        const check = (key: string) => ({
          key,
          observed: -30_000,
          check: Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            copies++;
            yield* Queue.offer(entered, key);
            yield* Deferred.await(release).pipe(Effect.ensuring(Effect.sync(() => active--)));
            return true;
          }),
        });
        const a = check("a");
        const one = yield* jobs.refresh(a).pipe(Effect.forkScoped);
        const two = yield* jobs.refresh(a).pipe(Effect.forkScoped);
        expect(yield* Queue.take(entered)).toBe("a");
        const batch = yield* jobs.pass([a, check("b"), check("c")]).pipe(Effect.forkScoped);
        expect(yield* Queue.take(entered)).toBe("b");
        expect(jobs.status(a, yield* Clock.currentTimeMillis)).toEqual({
          pending: true,
          stale: true,
        });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(one)).toBe(true);
        expect(yield* Fiber.join(two)).toBe(true);
        yield* Fiber.join(batch);
        expect(peak).toBe(2);
        expect(copies).toBe(3);
        const stuck = {
          key: "stuck",
          observed: -30_000,
          check: Queue.offer(entered, "stuck").pipe(Effect.andThen(Effect.never)),
        };
        const blocked = yield* jobs.refresh(stuck).pipe(Effect.forkScoped);
        expect(yield* Queue.take(entered)).toBe("c");
        expect(yield* Queue.take(entered)).toBe("stuck");
        yield* clock.adjust(5001);
        expect(yield* Fiber.join(blocked)).toBe(false);
        expect(jobs.status(stuck, yield* Clock.currentTimeMillis)).toEqual({
          pending: false,
          stale: true,
        });
        const visited: string[] = [];
        const many = Array.from({ length: 12 }, (_, i) => ({
          key: `job-${Str.padStart(2, "0")(String(i))}`,
          observed: -30_000,
          check: Effect.sync(() => {
            visited.push(String(i));
            return true;
          }),
        }));
        yield* jobs.pass([stuck, ...many]);
        expect(visited).toHaveLength(8);
        yield* jobs.pass([stuck, ...many]);
        expect(new Set(visited).size).toBe(12);
        expect(visited).toHaveLength(12);
        yield* jobs.pass([stuck, ...many]);
        expect(visited).toHaveLength(12);
        yield* clock.adjust(30_000);
        yield* jobs.pass(many);
        expect(visited).toHaveLength(20);
        expect(yield* Clock.currentTimeMillis).toBe(35001);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    }),
  ));
