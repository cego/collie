import * as Cause from "effect/Cause";
import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { runEffect } from "../../../test/support/effect";
import { signalPrompts } from "../prompts";

const ITEMS = [
  { id: "plan", title: "plan — grill me first" },
  { id: "implement", title: "implement — build it" },
];

const untilAsked = Effect.fn("prompts.untilAsked")(function* (asked: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (asked()) {
      return;
    }
    yield* Effect.sleep("2 millis");
  }
  return yield* new Cause.TimeoutError("nothing was ever asked");
});

test("a menu parks until the answer comes back, then hands over the item", () =>
  runEffect(
    Effect.gen(function* () {
      const { prompts, pending } = signalPrompts();

      const asking = yield* Effect.forkChild(
        prompts.menu(ITEMS, { header: "Workflows — /w/collie" }),
      );
      yield* untilAsked(() => pending() !== null);

      const question = pending()!;
      expect(question.ask._tag).toBe("Menu");
      expect(question.ask.header).toBe("Workflows — /w/collie");
      question.answer("implement");

      expect(yield* Fiber.join(asking)).toEqual(ITEMS[1]!);
      expect(pending()).toBeNull();
    }),
  ));

test("a cancel is null, at a menu and at a question alike", () =>
  runEffect(
    Effect.gen(function* () {
      const { prompts, pending } = signalPrompts();

      const menu = yield* Effect.forkChild(prompts.menu(ITEMS, { header: "pick" }));
      yield* untilAsked(() => pending() !== null);
      pending()!.answer(null);
      expect(yield* Fiber.join(menu)).toBeNull();

      const asked = yield* Effect.forkChild(prompts.ask("What is the goal?"));
      yield* untilAsked(() => pending() !== null);
      expect(pending()!.ask.header).toBe("What is the goal?");
      pending()!.answer(null);
      expect(yield* Fiber.join(asked)).toBeNull();
    }),
  ));

test("a question hands back exactly what was typed", () =>
  runEffect(
    Effect.gen(function* () {
      const { prompts, pending } = signalPrompts();

      const asked = yield* Effect.forkChild(prompts.ask("What is the goal?"));
      yield* untilAsked(() => pending() !== null);
      pending()!.answer("Add a picker");

      expect(yield* Fiber.join(asked)).toBe("Add a picker");
    }),
  ));

test("an answer nobody offered is no answer, not a wrong one", () =>
  runEffect(
    Effect.gen(function* () {
      const { prompts, pending } = signalPrompts();

      const menu = yield* Effect.forkChild(prompts.menu(ITEMS, { header: "pick" }));
      yield* untilAsked(() => pending() !== null);
      pending()!.answer("no-such-workflow");

      expect(yield* Fiber.join(menu)).toBeNull();
    }),
  ));

test("a flow that is interrupted leaves no question on screen", () =>
  runEffect(
    Effect.gen(function* () {
      const { prompts, pending } = signalPrompts();

      const menu = yield* Effect.forkChild(prompts.menu(ITEMS, { header: "pick" }));
      yield* untilAsked(() => pending() !== null);
      yield* Fiber.interrupt(menu);

      expect(pending()).toBeNull();
    }),
  ));
