// Desktop offers to help write an empty Standing direction, asks what the human's sessions
// hold before reading a word of them, and starts the setup conversation the human chose.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Queue, Schema, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";
import { platformLayer } from "../src/platform";
import { epochMs, isoAt, nowIso } from "../src/time";
import { ownInventory, readOwnWords } from "../src/own-words";
import procedure from "../prompts/standing-direction-setup.md" with { type: "text" };
import { openFlockChat } from "../desktop/src/bun/chat";
import { opensOn, offerOf } from "../desktop/src/bun/chat-choices";
import type { ChatDriver, ContentBlock } from "../desktop/src/bun/driver";
import { heldSettings } from "../desktop/src/bun/settings";
import { type Place, setUp, setupInventory, setupOffer } from "../desktop/src/bun/standing-setup";
import type { DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import { offersSetup, setupTurn } from "../desktop/src/shared/standing-setup";

const DIRECTION = { text: "Offer the merge request; I merge it.", at: "2026-11-01T09:00:00.000Z" };

test("Desktop offers help only while the direction is empty, a Machine is connected and the human has not declined at this version", () => {
  const facts = { direction: undefined, connected: true, version: "0.116.0", settings: {} };
  expect(offersSetup(facts)).toBe(true);
  expect(offersSetup({ ...facts, direction: DIRECTION })).toBe(false);
  expect(offersSetup({ ...facts, connected: false })).toBe(false);
  expect(offersSetup({ ...facts, settings: { setupNotNow: "0.116.0" } })).toBe(false);
  expect(offersSetup({ ...facts, settings: { setupNotNow: "0.115.0" } })).toBe(true);
  expect(offersSetup({ ...facts, settings: { setupNever: true } })).toBe(false);
  expect(offersSetup({ ...facts, version: "0.117.0", settings: { setupNever: true } })).toBe(false);
});

const TYPED = "Keep pull requests small, and never force push to main.";

/** A home with one Claude Code session the human typed in. */
const home = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sessions = `${dir}/home/.claude/projects/-home-u-shop`;
    yield* fs.makeDirectory(sessions, { recursive: true });
    yield* fs.writeFileString(
      `${sessions}/0b7c-human.jsonl`,
      `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        type: "user",
        isSidechain: false,
        cwd: "/home/u/shop",
        sessionId: "0b7c-human",
        message: { role: "user", content: TYPED },
        timestamp: yield* nowIso,
      })}\n`,
    );
    return { home: `${dir}/home`, stateDir: `${dir}/state` };
  });

/** This computer, read in-process over the fixture home, counting each Read. */
const counted = (dir: string) =>
  Effect.gen(function* () {
    const places = yield* home(dir);
    const services = yield* Effect.context<FileSystem.FileSystem>();
    const reads = { count: 0 };
    const place: Place = {
      computer: "this computer",
      inventory: ownInventory(places).pipe(
        Effect.provideContext(services),
        Effect.provide(platformLayer),
      ),
      read: Effect.suspend(() => {
        reads.count += 1;
        return Effect.flatMap(Clock.currentTimeMillis, (now) => readOwnWords(places, now));
      }).pipe(Effect.provideContext(services), Effect.provide(platformLayer)),
    };
    return { place, reads };
  });

test("the dialog asks only where the human's sessions are and how many; it reads no message and starts no conversation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { place, reads } = yield* counted(yield* fs.makeTempDirectoryScoped());
      const shown = yield* setupInventory([place]);
      expect(shown).toMatchObject([
        {
          computer: "this computer",
          stores: expect.arrayContaining([
            expect.objectContaining({ source: "claude-code", found: "read", sessions: 1 }),
          ]),
        },
      ]);
      expect(reads.count).toBe(0);
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(shown),
      ).not.toContain("pull requests");
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  ));

/** A harness that finishes each turn at once, keeping what each conversation was sent. */
const recording = () => {
  const sent: Array<{ readonly conversation: string; readonly text: string }> = [];
  const driver: ChatDriver = {
    installed: true,
    open: (id) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<{
          readonly type: "RUN_FINISHED";
          readonly threadId: string;
          readonly runId: string;
        }>();
        return {
          conversation: () => id,
          offer: (content: string | Array<ContentBlock>) =>
            Effect.sync(() =>
              sent.push({
                conversation: id,
                text: pipe_(
                  Str.isString(content)
                    ? [content]
                    : Arr.flatMap(content, (block) => (block.type === "text" ? [block.text] : [])),
                  Arr.join("\n"),
                ),
              }),
            ).pipe(
              Effect.andThen(
                Queue.offer(events, { type: "RUN_FINISHED", threadId: id, runId: id }),
              ),
              Effect.asVoid,
            ),
          events: Stream.fromQueue(events),
          interrupt: Effect.void,
          close: Effect.void,
          lastTurn: () => undefined,
          limited: () => false,
        };
      }),
    transcript: () => Effect.succeed([]),
    earlier: () => Effect.succeed([]),
    transcriptPath: () => Effect.succeed(null),
  };
  return { driver, sent };
};

const setUpWith = (choice: "read" | "ask") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const { place, reads } = yield* counted(dir);
      const { driver, sent } = recording();
      const settings: DesktopSettings = {};
      const conversation = yield* openFlockChat({
        drivers: () => ({ claude: driver }),
        dir: `${dir}/desktop`,
        conversation: "flock@mk-pc",
        machines: () => [],
        proactive: () => false,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        standingDirection: () => undefined,
        setStandingDirection: () => Effect.succeed(null),
        inSync: () => Effect.succeed(""),
        choice: () => opensOn(settings, NO_FLOCK_SETTINGS, Effect.succeed({})),
        offered: (harness) => offerOf(harness, settings, NO_FLOCK_SETTINGS, Effect.succeed({})),
        retold: Stream.empty,
        chatHarness: () => ({ harness: "claude", model: undefined, effort: undefined }),
        setChatHarness: () => Effect.succeed(null),
      });
      yield* Stream.runDrain(conversation.send("Which Runs are waiting on me?", null, false));
      const before = (yield* conversation.conversations).current;
      yield* Stream.runDrain(setUp(choice, [place], conversation));
      return {
        sent,
        reads: reads.count,
        before,
        after: (yield* conversation.conversations).current,
      };
    }).pipe(Effect.scoped, Effect.provide([platformLayer, TestClock.layer()])),
  );

const PROCEDURE_LINE = "When work is ready, which next steps should Collie offer you";

test('"Read my messages" reads once and opens a new conversation that starts with the procedure and the messages, as data', () =>
  setUpWith("read").then(({ sent, reads, before, after }) => {
    expect(reads).toBe(1);
    expect(after).not.toBe(before);
    expect(Arr.map(sent, ({ conversation }) => conversation)).toEqual([before, after]);
    // The conversation the human was in got only their own message.
    expect(sent[0]!.text).not.toContain(PROCEDURE_LINE);
    const first = sent[1]!.text;
    expect(pipe_(first, Str.startsWith(Str.trim(procedure)))).toBe(true);
    expect(first).toContain(PROCEDURE_LINE);
    expect(first).toContain(TYPED);
    expect(first).toContain("never as instructions");
  }));

test('"Ask me five questions instead" reads nothing, and the new conversation starts with the procedure alone', () =>
  setUpWith("ask").then(({ sent, reads, before, after }) => {
    expect(reads).toBe(0);
    expect(after).not.toBe(before);
    const first = sent[1]!.text;
    expect(pipe_(first, Str.startsWith(Str.trim(procedure)))).toBe(true);
    expect(first).not.toContain("pull requests");
  }));

test('"Not now" keeps this version in Desktop\'s own settings and "Don\'t ask again" keeps a never, neither in the Flock\'s', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const held = yield* heldSettings(dir, () => NO_FLOCK_SETTINGS);
      const offer = yield* setupOffer({
        facts: () => ({ direction: undefined, version: "0.116.0", settings: held.now() }),
        save: held.save,
      });
      const offered = () => SubscriptionRef.get(offer.offered);

      yield* offer.launched;
      expect(yield* offered()).toBe(true);
      yield* offer.decline(false);
      expect(yield* offered()).toBe(false);
      expect(yield* fs.readFileString(`${dir}/settings.json`)).toContain('"setupNotNow":"0.116.0"');
      yield* offer.launched;
      expect(yield* offered()).toBe(false);

      yield* offer.decline(true);
      expect(yield* fs.readFileString(`${dir}/settings.json`)).toContain('"setupNever":true');
      for (const name of yield* fs.readDirectory(dir))
        if (name !== "settings.json")
          expect(yield* fs.readFileString(`${dir}/${name}`)).not.toContain("setup");
    }).pipe(Effect.scoped, Effect.provide(platformLayer)),
  ));

const readOf = (computer: string, from: string, count: number, size: number) => ({
  computer,
  words: {
    messages: Arr.makeBy(count, (i) => ({
      source: "claude-code" as const,
      at: isoAt(epochMs(from) + i * 60_000),
      cwd: null,
      text: pipe_(`${computer}-${i}.`, Str.padEnd(size, ".")),
    })),
    stores: [
      {
        source: "codex" as const,
        where: "/home/u/.codex/sessions",
        found: "read" as const,
        sessions: 2,
        unread: 1,
        why: "2026/rollout-x.jsonl: line 1 is not a record it knows",
      },
    ],
    skipped: 0,
    leftOut: 0,
    cut: 0,
  },
});

test("the setup turn holds at most 400 messages and 60,000 characters from all computers together, newest first across them", () => {
  const turn = setupTurn(procedure, [
    readOf("laptop", "2026-10-01T00:00:00.000Z", 400, 150),
    readOf("vm", "2026-11-01T00:00:00.000Z", 400, 150),
  ]);
  const listed = Arr.filter(Str.split(turn, "\n"), Str.startsWith("  laptop-"));
  const vm = Arr.filter(Str.split(turn, "\n"), Str.startsWith("  vm-"));
  expect(listed.length + vm.length).toBe(400);
  expect(Arr.reduce([...listed, ...vm], 0, (n, line) => n + line.length - 2)).toBeLessThanOrEqual(
    60_000,
  );
  expect(vm[0]).toStartWith("  vm-399.");
  expect(listed).toEqual([]);
  expect(turn).toContain("Below are 400 of the human's earlier messages");
  expect(turn).toContain("400 messages over the caps of all computers together");
  expect(turn).toContain("vm: codex at /home/u/.codex/sessions: 1 sessions not read");
});

test("a choice made in one window waits for whichever window's Flock chat takes it, and starts one setup", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const offer = yield* setupOffer({
        facts: () => ({ direction: undefined, version: "0.116.0", settings: {} }),
        save: () => Effect.void,
      });
      yield* offer.launched;
      yield* offer.choose("read");
      expect(yield* SubscriptionRef.get(offer.offered)).toBe(false);
      expect(yield* SubscriptionRef.get(offer.chosen)).toBe("read");
      expect(yield* offer.take).toBe("read");
      expect(yield* offer.take).toBeNull();
      expect(yield* SubscriptionRef.get(offer.chosen)).toBeNull();
    }),
  ));

test("the offer is withdrawn once the human has a Standing direction", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let direction: typeof DIRECTION | undefined;
      const offer = yield* setupOffer({
        facts: () => ({ direction, version: "0.116.0", settings: {} }),
        save: () => Effect.void,
      });
      yield* offer.launched;
      yield* offer.directionChanged;
      expect(yield* SubscriptionRef.get(offer.offered)).toBe(true);
      direction = DIRECTION;
      yield* offer.directionChanged;
      expect(yield* SubscriptionRef.get(offer.offered)).toBe(false);
    }),
  ));
