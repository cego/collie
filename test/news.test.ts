// What Collie says without being asked, and what it is allowed to claim about it.
//
// The two failures this is built against. One turn per event is the notification storm
// proactivity was meant to replace, so a burst has to become a batch. And writing a
// notification is not evidence that anybody read it, so `sent` must never settle an item.

import { Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  BATCH,
  NATIVE,
  append,
  asText,
  newsPath,
  pending,
  read,
  settle,
  supersede,
  uncertain,
} from "../src/news";
import { eventsIn, holding } from "../src/proactive";
import { runFacts as record } from "./support/records";
import { runEffect } from "./support/effect";

const KEY = "herd-abc";
let stateDir: string;
let file: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-news-" });
      file = yield* newsPath(stateDir, KEY);
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

test("the same thing that happened is one piece of news, however often it is noticed", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* append(file, { key: "r1:halt:x", run: "r1", text: "r1 stopped" })).toBe(true);
      // Deduplicated by what happened, not by when it was seen.
      expect(yield* append(file, { key: "r1:halt:x", run: "r1", text: "r1 stopped" })).toBe(false);
      expect(pending(yield* read(file)).items).toHaveLength(1);
    }),
  ));

test("news older than one batch is still deduplicated", () =>
  runEffect(
    Effect.gen(function* () {
      for (let n = 0; n < BATCH + 5; n++)
        yield* append(file, { key: `r${n}:ended`, run: `r${n}`, text: `Run r${n} ended.` });
      // The oldest waiting item has fallen out of the batch, and it is still the same
      // news: a human who has not read in a while must not be told twice.
      expect(yield* append(file, { key: "r0:ended", run: "r0", text: "Run r0 ended." })).toBe(
        false,
      );
    }),
  ));

test("a burst becomes one batch that says what it left out, not a turn each", () =>
  runEffect(
    Effect.gen(function* () {
      for (let n = 0; n < BATCH + 5; n++)
        yield* append(file, { key: `r${n}:ended`, run: `r${n}`, text: `Run r${n} ended.` });
      const batch = pending(yield* read(file));
      expect(batch.items).toHaveLength(BATCH);
      expect(batch.omitted).toBe(5);
      // Said out loud. The five are still pending, not dropped, and not replaced by one
      // generic line that swallowed them.
      expect(asText(batch)).toContain("5 older item(s) not listed here");
      expect(asText(batch)).toContain("Run r14 ended.");
    }),
  ));

test("submitted is not read, and only reading settles anything", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { key: "r1:ended", run: "r1", text: "r1 ended." });
      // A transport accepted it. That is a fact about the transport.
      yield* settle(file, "r1:ended", "sent", NATIVE);
      expect(pending(yield* read(file)).items).toHaveLength(1);
      // The conversation took it. That is the receipt.
      yield* settle(file, "r1:ended", "read", NATIVE);
      expect(pending(yield* read(file)).items).toEqual([]);
    }),
  ));

test("a send nobody can account for stays a human's, and is never sent again by itself", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { key: "r1:ended", run: "r1", text: "r1 ended." });
      yield* settle(file, "r1:ended", "uncertain", NATIVE, "the process went away mid-send");
      const lines = yield* read(file);
      // Still pending — nothing pretends it arrived — and visibly uncertain, which is a
      // different thing from "not yet sent" and is what a human has to settle.
      expect(pending(lines).items).toHaveLength(1);
      expect(uncertain(lines)).toEqual(["r1:ended"]);
      // Reading it is what ends the doubt.
      yield* settle(file, "r1:ended", "read", NATIVE);
      expect(uncertain(yield* read(file))).toEqual([]);
    }),
  ));

test("every approved trigger is news, and activity alone is not", () => {
  const triggers = [
    record({ id: "r1", state: "waiting", asking: [{ name: "scope", prompt: "?", options: [] }] }),
    record({ id: "r2", state: "waiting", note: "the pane would not take the prompt" }),
    record({ id: "r3", state: "succeeded" }),
    record({ id: "r4", state: "failed" }),
    record({ id: "r5", state: "stopped" }),
  ];
  expect(eventsIn(triggers)).toHaveLength(triggers.length);
  // Drift Collie could not correct needs the journal's own answer.
  expect(eventsIn([record({ id: "r8" })], new Map([["r8", "stay in src"]]))).toHaveLength(1);

  // And none of these is: an agent working, a hold, time passing. A Run that is simply
  // working is a Run nobody needs to be told about.
  for (const busy of [record({ state: "running" }), record({ held: true })])
    expect(eventsIn([busy])).toEqual([]);
});

test("what one conversation read is still news to another", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { key: "r1:ended", run: "r1", text: "r1 ended." });
      yield* settle(file, "r1:ended", "read", NATIVE);
      yield* settle(file, "r1:ended", "uncertain", NATIVE, "the pane went away");
      const lines = yield* read(file);
      expect(pending(lines, NATIVE).items).toEqual([]);
      expect(pending(lines, "flock@pc").items.map((item) => item.key)).toEqual(["r1:ended"]);
      expect(uncertain(lines, "flock@pc")).toEqual([]);
      // Already news for one conversation, so noticing it again queues nothing new.
      expect(yield* append(file, { key: "r1:ended", run: "r1", text: "r1 ended." })).toBe(false);
    }),
  ));

test("news whose cause has gone drops out of every batch and stays in the journal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { key: "r1:parked:x", run: "r1", text: "r1 parked." });
      yield* append(file, { key: "r2:ended:failed", run: "r2", text: "r2 failed." });
      yield* settle(file, "r1:parked:x", "uncertain", NATIVE);
      expect(yield* supersede(file, (item) => item.key !== "r1:parked:x")).toBe(1);
      // Once is enough: it is not superseded again on the next look.
      expect(yield* supersede(file, (item) => item.key !== "r1:parked:x")).toBe(0);
      const lines = yield* read(file);
      for (const conversation of [NATIVE, "flock@pc"])
        expect(pending(lines, conversation).items.map((item) => item.key)).toEqual([
          "r2:ended:failed",
        ]);
      expect(uncertain(lines, NATIVE)).toEqual([]);
      expect(lines.some((line) => line.kind === "item" && line.key === "r1:parked:x")).toBe(true);
      // The same cause arising again later is news again.
      expect(yield* append(file, { key: "r1:parked:x", run: "r1", text: "r1 parked." })).toBe(true);
      expect(pending(yield* read(file), "flock@pc").items).toHaveLength(2);
    }),
  ));

test("a resumed halt, an answered question and a disposed finished Run no longer hold", () => {
  const before = [
    record({ id: "r1", state: "waiting", note: "out of budget" }),
    record({ id: "r2", state: "waiting", asking: [{ name: "scope", prompt: "?", options: [] }] }),
    record({ id: "r3", state: "succeeded" }),
  ];
  const keys = eventsIn(before).map((event) => event.key);
  expect([...holding(before)].sort()).toEqual([...keys].sort());
  const after = [
    record({ id: "r1", state: "running" }),
    record({ id: "r2", state: "running" }),
    record({ id: "r3", state: "succeeded" }),
  ];
  const now = holding(after, new Map(), new Set(["r3"]));
  for (const key of keys) expect([key, now.has(key)]).toEqual([key, false]);
  // Until its work has a disposition, a finished Run's outcome is still true.
  expect(holding(after).has("r3:ended:succeeded")).toBe(true);
});

test("a cause masked by a more pressing one still holds", () => {
  // Drift escalated before the Run asked a question is still drift.
  const run = record({ id: "r1", asking: [{ name: "scope", prompt: "?", options: [] }] });
  expect(holding([run], new Map([["r1", "stay in src"]])).has("r1:drift:stay in src")).toBe(true);
});
