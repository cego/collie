import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { openedOnce } from "../desktop/src/bun/machine";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

test("two callers asking for one Machine open it once", () =>
  run(
    Effect.gen(function* () {
      const once = openedOnce(new Map<string, Deferred.Deferred<string>>());
      const started: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const open = (key: string) =>
        once(key, () =>
          Effect.gen(function* () {
            started.push(key);
            yield* Deferred.await(release);
            return `${key} #${started.length}`;
          }),
        );

      const first = yield* Effect.forkChild(open("vm"));
      const second = yield* Effect.forkChild(open("vm"));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const one = yield* Fiber.join(first);
      const two = yield* Fiber.join(second);

      expect(started).toEqual(["vm"]);
      expect(two).toBe(one);
    }),
  ));
