import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { closeRenderer } from "../../src/ui/bridge";

const fakeRenderer = (closed: Promise<void>) => {
  let destroyed = false;
  return {
    renderer: {
      destroy: () => {
        destroyed = true;
      },
      get closed() {
        return closed;
      },
    },
    destroyed: () => destroyed,
  };
};

test("a closing pane waits for the renderer to give the terminal back", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const restored = Promise.withResolvers<void>();
      const fake = fakeRenderer(restored.promise);
      const closing = yield* Effect.forkChild(closeRenderer(fake.renderer));
      yield* Effect.yieldNow;
      expect(fake.destroyed()).toBe(true);
      expect(closing.pollUnsafe()).toBeUndefined();
      restored.resolve();
      expect(Exit.isSuccess(yield* Fiber.await(closing))).toBe(true);
    }),
  ));

test("a renderer that fails to give the terminal back still lets the pane close", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fake = fakeRenderer(Promise.reject(new Error("stdout closed")));
      const exit = yield* Effect.exit(closeRenderer(fake.renderer));
      expect(fake.destroyed()).toBe(true);
      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  ));
