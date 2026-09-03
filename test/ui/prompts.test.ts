import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { runEffect } from "../support/effect";
import { signalPrompts } from "../../src/ui/prompts";

const ITEMS = [
  { id: "plan", title: "plan — grill me first" },
  { id: "implement", title: "implement — build it" },
];

/** Waits for a question to be on screen, rather than for a duration. */
const untilAsked = Effect.fn("prompts.untilAsked")(function* (asked: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (asked()) return;
    yield* Effect.sleep("2 millis");
  }
  return yield* Effect.fail(new Error("nothing was ever asked"));
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
      // Answered, so nothing is on screen waiting.
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
      // The component can only send an id it drew, but the flow settles Inputs from
      // this and a value it never offered would be recorded as if a human chose it.
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

      // The popup closing mid-flow must not leave a menu nothing is waiting for.
      expect(pending()).toBeNull();
    }),
  ));
