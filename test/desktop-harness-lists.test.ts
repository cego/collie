import { expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { offerOf, opensOn } from "../desktop/src/bun/chat-choices";
import { harnessLists, type HarnessList } from "../desktop/src/bun/harness-lists";
import { changeSettings } from "../desktop/src/bun/settings";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";

const MODELS = [
  { id: "opus", label: "Opus 5", description: "Complex work", efforts: ["low", "medium", "high"] },
];

test("opening rechecks a saved explicit effort after the harness finishes listing its model's levels", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (const { harness, model, effort, listed, problem } of [
        {
          harness: "pi",
          model: "openai-codex/gpt-5.5",
          effort: "max",
          listed: {
            id: "openai-codex/gpt-5.5",
            label: "GPT-5.5",
            efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
          },
          problem: '"max" is not an effort GPT-5.5 takes (off, minimal, low, medium, high, xhigh)',
        },
        {
          harness: "claude",
          model: "claude-haiku-4-5",
          effort: "high",
          listed: { id: "claude-haiku-4-5", label: "Haiku 4.5", efforts: [] },
          problem: 'Haiku 4.5 takes no effort, so "high" cannot be asked of it',
        },
      ]) {
        const lists = yield* harnessLists({
          [harness]: Effect.sleep("2 seconds").pipe(Effect.as([listed])),
        });
        const saved = changeSettings({ proactive: true }, NO_FLOCK_SETTINGS, {
          chatHarness: harness,
          chatModel: model,
          chatEffort: effort,
        });
        if ("refused" in saved) return yield* Effect.die(saved.refused);
        const first = yield* opensOn(saved, NO_FLOCK_SETTINGS, Effect.succeed({}), lists).pipe(
          Effect.forkScoped,
        );
        yield* TestClock.adjust("1 second");
        expect(lists.now(harness)).toEqual({ from: "reading" });
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(first)).toEqual({ ok: false, problem });
        expect(saved.chatEffort).toBe(effort);
        expect(
          yield* opensOn(
            { ...saved, chatEffort: undefined },
            NO_FLOCK_SETTINGS,
            Effect.succeed({}),
            lists,
          ),
        ).toEqual({
          ok: true,
          choice: { harness, model, effort: harness === "pi" ? "medium" : null },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("a list pushes reading, failure with its reason, retry, and success kept for Desktop's lifetime", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let reads = 0;
      const lists = yield* harnessLists({
        claude: Effect.suspend(() => {
          reads++;
          return Effect.sleep("2 seconds").pipe(
            Effect.andThen(reads === 1 ? Effect.fail("Not logged in") : Effect.succeed(MODELS)),
          );
        }),
      });
      const pushed: Array<HarnessList | undefined> = [];
      yield* lists.changes.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            pushed.push(lists.now("claude"));
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      expect(reads).toBe(0);
      yield* lists.need("claude");
      yield* Effect.yieldNow;
      expect(lists.now("claude")).toEqual({ from: "reading" });
      yield* lists.need("claude");
      yield* TestClock.adjust("2 seconds");
      expect(lists.now("claude")).toEqual({ from: "table", why: "Not logged in" });
      expect(reads).toBe(1);
      yield* lists.need("claude");
      yield* Effect.yieldNow;
      expect(lists.now("claude")).toEqual({ from: "reading" });
      yield* TestClock.adjust("2 seconds");
      expect(lists.now("claude")).toEqual({ from: "harness", models: MODELS });
      yield* lists.need("claude");
      expect(reads).toBe(2);
      expect(pushed).toEqual([
        undefined,
        { from: "reading" },
        { from: "table", why: "Not logged in" },
        { from: "reading" },
        { from: "harness", models: MODELS },
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("after twenty seconds the first open uses the table, then the late list changes the next open", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lists = yield* harnessLists({
        claude: Effect.sleep("30 seconds").pipe(
          Effect.as([{ id: "opus", label: "Opus 5", efforts: [] }]),
        ),
      });
      let opened = false;
      const open = opensOn({ proactive: true }, NO_FLOCK_SETTINGS, Effect.succeed({}), lists);
      const first = yield* open.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            opened = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("19 seconds");
      expect(opened).toBe(false);
      yield* TestClock.adjust("1 second");
      expect(opened).toBe(true);
      expect(yield* Fiber.join(first)).toEqual({
        ok: true,
        choice: { harness: "claude", model: "opus", effort: "medium" },
      });
      expect(
        yield* offerOf("claude", { proactive: true }, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
      ).toMatchObject({ from: "table", why: "The model list did not arrive within 20 seconds" });
      yield* TestClock.adjust("10 seconds");
      expect(
        yield* offerOf("claude", { proactive: true }, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
      ).toMatchObject({
        from: "harness",
        models: [{ id: "opus", label: "Opus 5", efforts: [], unsetEffort: null }],
      });
      expect(yield* open).toEqual({
        ok: true,
        choice: { harness: "claude", model: "opus", effort: null },
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("the first open waits for the harness list and uses its model's effort levels", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lists = yield* harnessLists({
        claude: Effect.sleep("2 seconds").pipe(
          Effect.as([{ id: "opus", label: "Opus 5", efforts: [] }]),
        ),
      });
      let opened = false;
      const first = yield* opensOn(
        { proactive: true },
        NO_FLOCK_SETTINGS,
        Effect.succeed({}),
        lists,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            opened = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("1 second");
      expect(opened).toBe(false);
      expect(
        yield* offerOf("claude", { proactive: true }, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
      ).toEqual({ from: "reading" });
      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(first)).toEqual({
        ok: true,
        choice: { harness: "claude", model: "opus", effort: null },
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
