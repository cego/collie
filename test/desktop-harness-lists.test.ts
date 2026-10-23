// When each harness's own list of models is read, what every chat window is offered while it
// is read or after it could not be, and that a read list is kept.

import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { chatChoicesStream } from "../desktop/src/bun/chat-choices";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import type { ChatChoices, ListedModel } from "../desktop/src/shared/chat-choices";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";

const OPUS: ListedModel = {
  id: "opus",
  label: "Opus 5.5",
  description: "For complex work and everyday tasks",
  efforts: ["low", "medium", "high", "xhigh", "max"],
};
const HAIKU: ListedModel = {
  id: "claude-haiku-4-5-20251001",
  label: "Haiku 4.5",
  description: "Fastest for quick answers",
  efforts: [],
};

/** A reader that answers each read as its next answer says, once that answer is released. */
const scriptedReader = (
  answers: ReadonlyArray<Deferred.Deferred<ReadonlyArray<ListedModel>, string>>,
) => {
  const reads = { count: 0 };
  const reader = Effect.suspend(() => {
    const answer = answers[reads.count++];
    return answer === undefined ? Effect.never : Deferred.await(answer);
  });
  return { reads, reader };
};

/** The account stream over these settings, and every account it has sent. */
const watched = (
  lists: Effect.Success<ReturnType<typeof harnessLists>>,
  settings: SubscriptionRef.SubscriptionRef<DesktopSettings>,
) =>
  Effect.gen(function* () {
    const sent: ChatChoices[] = [];
    yield* chatChoicesStream({
      held: Stream.make({ heldOn: "claude", runsOn: null, turning: false }),
      settings: SubscriptionRef.changes(settings),
      flock: Stream.make(NO_FLOCK_SETTINGS),
      installed: { claude: true, pi: true },
      pi: Effect.succeed({}),
      lists,
    }).pipe(
      Stream.runForEach((choices) => Effect.sync(() => sent.push(choices))),
      Effect.forkChild,
    );
    /** What `harness` was offered in each account, until `last` is its latest. */
    const offered = (harness: string, last: string) =>
      Effect.gen(function* () {
        const of = () =>
          sent.map((choices) => {
            const offer = choices.harnesses.find((one) => one.harness === harness)!.offered;
            return offer.from === "table" && offer.why !== undefined
              ? `table: ${offer.why}`
              : offer.from;
          });
        for (let turn = 0; turn < 1000 && of().at(-1) !== last; turn++) yield* Effect.yieldNow;
        return [...new Set(of())];
      });
    return { sent, offered };
  });

test("the set harness's list is read when a window subscribes: reading, then Claude Code's own, kept", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const answer = yield* Deferred.make<ReadonlyArray<ListedModel>, string>();
      const claude = scriptedReader([answer]);
      const pi = scriptedReader([]);
      const lists = yield* harnessLists({ claude: claude.reader, pi: pi.reader });
      const settings = yield* SubscriptionRef.make<DesktopSettings>({ proactive: true });
      const { sent, offered } = yield* watched(lists, settings);

      expect(yield* offered("claude", "reading")).toEqual(["reading"]);
      // Pi is not set, so its list is not read yet.
      expect(pi.reads.count).toBe(0);
      expect(yield* offered("pi", "table")).toEqual(["table"]);

      yield* Deferred.succeed(answer, [OPUS, HAIKU]);
      expect(yield* offered("claude", "harness")).toEqual(["reading", "harness"]);
      const latest = sent.at(-1)!.harnesses[0]!.offered;
      expect(latest.from === "harness" && latest.models.map(({ label }) => label)).toEqual([
        "Opus 5.5",
        "Haiku 4.5",
      ]);

      // Choosing Pi reads its list; Claude Code's is kept, not read again.
      yield* SubscriptionRef.set(settings, { proactive: true, chatHarness: "pi" });
      expect(yield* offered("pi", "reading")).toEqual(["table", "reading"]);
      yield* lists.need("claude");
      for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow;
      expect(claude.reads.count).toBe(1);
      expect(lists.now().claude?.from).toBe("harness");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("a list that cannot be read is offered from Collie's table with why, and read again when next needed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* Deferred.make<ReadonlyArray<ListedModel>, string>();
      const again = yield* Deferred.make<ReadonlyArray<ListedModel>, string>();
      const claude = scriptedReader([failed, again]);
      const lists = yield* harnessLists({ claude: claude.reader });
      const settings = yield* SubscriptionRef.make<DesktopSettings>({ proactive: true });
      const { sent, offered } = yield* watched(lists, settings);

      yield* offered("claude", "reading");
      yield* Deferred.fail(failed, "Claude Code is not logged in");
      expect(yield* offered("claude", "table: Claude Code is not logged in")).toEqual([
        "reading",
        "table: Claude Code is not logged in",
      ]);
      const fallback = sent.at(-1)!.harnesses[0]!.offered;
      expect(fallback.from === "table" && fallback.models.map(({ id }) => id)).toEqual([
        "fable",
        "opus",
        "sonnet",
        "haiku",
        "opusplan",
      ]);

      yield* lists.need("claude");
      for (let turn = 0; turn < 100 && claude.reads.count < 2; turn++) yield* Effect.yieldNow;
      expect(claude.reads.count).toBe(2);
      yield* Deferred.succeed(again, [OPUS]);
      expect(yield* offered("claude", "harness")).toEqual([
        "reading",
        "table: Claude Code is not logged in",
        "harness",
      ]);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("a read that gives no answer within a minute is offered from the table, saying so", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const claude = scriptedReader([]);
      const lists = yield* harnessLists({ claude: claude.reader });
      yield* lists.need("claude");
      expect(lists.now().claude).toEqual({ from: "reading" });
      yield* TestClock.adjust("59 seconds");
      expect(lists.now().claude).toEqual({ from: "reading" });
      yield* TestClock.adjust("1 second");
      for (let turn = 0; turn < 100 && lists.now().claude?.from === "reading"; turn++)
        yield* Effect.yieldNow;
      expect(lists.now().claude).toEqual({
        from: "table",
        why: "it gave no answer within a minute",
      });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));

test("an open waits for its harness's list while it is read, and no longer than 20 seconds", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const answer = yield* Deferred.make<ReadonlyArray<ListedModel>, string>();
      const lists = yield* harnessLists({ claude: scriptedReader([answer]).reader });
      const waiting = yield* lists.settled("claude").pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(answer, [OPUS]);
      expect((yield* Fiber.join(waiting)).claude?.from).toBe("harness");

      const slow = yield* harnessLists({ claude: scriptedReader([]).reader });
      const opening = yield* slow.settled("claude").pipe(Effect.forkChild);
      yield* TestClock.adjust("19 seconds");
      expect(opening.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(opening)).claude).toEqual({ from: "reading" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
