// What Collie says without being asked, and what it is allowed to claim about it.
//
// The two failures this is built against. One turn per event is the notification storm
// proactivity was meant to replace, so a burst has to become a batch. And writing a
// notification is not evidence that anybody read it, so `sent` must never settle an item.

import { Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { BATCH, append, asText, newsPath, pending, read, settle, uncertain } from "../src/news";
import { eventsIn } from "../src/proactive";
import { runRecord as record } from "./support/records";
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

test("an unchanged Herd has nothing to say, however often it is looked at", () => {
  // The whole of the "no model call on an idle Herd" promise, at its source: a Run that
  // is getting on with it produces no event, so nothing is ever queued to say.
  const going = [record(), record({ id: "r2", status: "running" })];
  expect(eventsIn(going)).toEqual([]);
  // And re-reading the same board a hundred times finds the same nothing.
  for (let n = 0; n < 100; n++) expect(eventsIn(going)).toHaveLength(0);
});

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
      yield* settle(file, "r1:ended", "sent");
      expect(pending(yield* read(file)).items).toHaveLength(1);
      // The conversation took it. That is the receipt.
      yield* settle(file, "r1:ended", "read");
      expect(pending(yield* read(file)).items).toEqual([]);
    }),
  ));

test("a send nobody can account for stays a human's, and is never sent again by itself", () =>
  runEffect(
    Effect.gen(function* () {
      yield* append(file, { key: "r1:ended", run: "r1", text: "r1 ended." });
      yield* settle(file, "r1:ended", "uncertain", "the process went away mid-send");
      const lines = yield* read(file);
      // Still pending — nothing pretends it arrived — and visibly uncertain, which is a
      // different thing from "not yet sent" and is what a human has to settle.
      expect(pending(lines).items).toHaveLength(1);
      expect(uncertain(lines)).toEqual(["r1:ended"]);
      // Reading it is what ends the doubt.
      yield* settle(file, "r1:ended", "read");
      expect(uncertain(yield* read(file))).toEqual([]);
    }),
  ));

test("every approved trigger is news, and activity alone is not", () => {
  const triggers = [
    record({ halt: "evidence_missing" }),
    record({ id: "r2", awaiting: "choice" }),
    record({ id: "r3", evidence_gaps: ["nothing was verified"] }),
    record({ id: "r4", obstacle: "the same test keeps failing" }),
    record({ id: "r5", status: "done" }),
    record({ id: "r6", status: "failed" }),
    record({ id: "r7", status: "blocked", summary: "a step stopped for a human" }),
  ];
  expect(eventsIn(triggers)).toHaveLength(triggers.length);
  // Drift Collie could not correct is the eighth, and it needs the journal's own answer.
  expect(eventsIn([record({ id: "r8" })], new Map([["r8", "stay in src"]]))).toHaveLength(1);

  // And none of these is: a step starting, output arriving, a commit, time passing. A
  // Run that is simply working is a Run nobody needs to be told about.
  for (const busy of [record({ status: "running", iteration: 9 }), record({ iteration: 40 })])
    expect(eventsIn([busy])).toEqual([]);
});
