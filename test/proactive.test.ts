// Collie speaking without being spoken to. What matters is that it speaks about the right
// things, says each of them once, and that speaking first buys it no authority at all.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { eventsIn, idleAgain, readSaid, remember, type Event } from "../src/proactive";
import { task } from "./support/task";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import type { RunFacts } from "../src/runs";
import { runFacts } from "./support/records";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-proactive-" });
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

/** A Run as the board has already read it; nothing here reads a file. */
const record = (over: Partial<RunFacts> & { id: string }): RunFacts =>
  runFacts({ project: "/repo", created: "2026-09-11T10:00:00.000Z", ...over });

const asking = { name: "scope", prompt: "Which repository?", options: [] };

test("a Run getting on with it is not news", () => {
  expect(eventsIn([record({ id: "r1" })])).toEqual([]);
  // Nor is an agent working, or any amount of time passing: none of them is a fact about
  // whether the work is getting anywhere.
  expect(eventsIn([record({ id: "r1", held: true })])).toEqual([]);
});

test("the things worth saying are the things a human would want to know", () => {
  const said = (over: Partial<RunFacts>) => eventsIn([record({ id: "r1", ...over })])[0] ?? null;

  expect(said({ state: "waiting", asking: [asking] })!.text).toContain("waiting on me (scope)");
  expect(said({ state: "waiting", note: "the pane would not take it" })!.text).toContain(
    "parked its work: the pane would not take it",
  );
  expect(said({ state: "succeeded" })!.text).toContain("ended succeeded");
  expect(said({ state: "failed" })!.text).toContain("ended failed");
  expect(said({ state: "stopped" })!.text).toContain("ended stopped");
  // Drift Collie escalated rather than corrected is the human's already, and is said.
  const drifted = eventsIn([record({ id: "r1" })], new Map([["r1", "keep-envelope"]]))[0]!;
  expect(drifted.text).toContain("drifted from keep-envelope and Collie could not correct it");
  expect(drifted.key).toBe("r1:drift:keep-envelope");
  // A finished Run's drift is history; its ending is the event.
  expect(
    eventsIn([record({ id: "r1", state: "succeeded" })], new Map([["r1", "keep-envelope"]]))[0]!
      .text,
  ).toContain("ended succeeded");

  // Every one of them names the Run it is about, which is what a proposal would target.
  expect(said({ state: "failed" })!.run).toBe("r1");
});

/** What `sayWhatHappened` keeps: every event this Herd has not already said. */
const unsaid = (events: ReadonlyArray<Event>, said: ReadonlySet<string>) =>
  events.filter((event) => !said.has(event.key));

test("a Run that stopped says so once, and says so again only for a different reason", () => {
  const asked = eventsIn([record({ id: "r1", state: "waiting", asking: [asking] })]);
  const said = new Set(asked.map((e) => e.key));

  // The board redraws every few seconds: the same question must not be reported every time.
  expect(unsaid(asked, said)).toHaveLength(0);
  expect(
    unsaid(eventsIn([record({ id: "r1", state: "waiting", asking: [asking] })]), said),
  ).toHaveLength(0);

  // Answered, and asking something else: that is new, and is said.
  const other = eventsIn([
    record({ id: "r1", state: "waiting", asking: [{ ...asking, name: "target" }] }),
  ]);
  expect(unsaid(other, said)).toHaveLength(1);
});

test("several Runs ending together is every one of them, kept for one batch", () => {
  const events = eventsIn([
    record({ id: "r1", state: "succeeded" }),
    record({ id: "r2", state: "failed" }),
    record({ id: "r3", state: "waiting", asking: [asking] }),
  ]);

  // All three, not the first: none of them is dropped because the others happened at the
  // same moment. What stops three turns is that they go into one bounded batch, which is
  // `news.ts`'s job — not this one's.
  expect(unsaid(events, new Set()).map((event) => event.run)).toEqual(["r1", "r2", "r3"]);
});

test("a Run says the most pressing thing about it, not every true thing", () => {
  // Asking *and* drifted: the question is the human being waited on.
  const events = eventsIn(
    [record({ id: "r1", state: "waiting", asking: [asking] })],
    new Map([["r1", "keep-envelope"]]),
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.text).toContain("waiting on me");
});

test("what has been said survives the Home being closed and reopened", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${stateDir}/herd-1`;
      yield* fs.makeDirectory(dir, { recursive: true });

      expect(yield* readSaid(dir)).toEqual(new Set());
      yield* remember(dir, "r1:ended:failed", "2026-09-11T10:00:00.000Z");

      // A new Home reads the same journal: an event announced before a restart is not
      // announced again after one.
      const said = yield* readSaid(dir);
      expect(said.has("r1:ended:failed")).toBe(true);
      const events = eventsIn([record({ id: "r1", state: "failed" })]);
      expect(unsaid(events, said)).toHaveLength(0);
    }),
  ));

test("a Run is named by what a human can find: its workflow and its target", () => {
  const events = eventsIn([
    record({
      id: "r1",
      workflow: "review",
      state: "succeeded",
      settled: { inputs: { target: "mr:mk/collie!65" }, strategies: { target: "diff-target" } },
    }),
  ]);
  expect(events[0]!.text).toContain("(Review · !65)");
});

test("the event carries no action, so speaking first grants nothing", () => {
  const event: Event = eventsIn([record({ id: "r1", state: "failed" })])[0]!;
  // An Event is a Run, a key and a question. There is nowhere in it to put a thing to
  // do: what may be done comes back from the evaluator and through `validate`, exactly
  // as it does for a message somebody typed.
  expect(Object.keys(event).sort()).toEqual(["key", "run", "text"]);
  expect(event.text.endsWith("?")).toBe(true);
});

test("noticing something costs a file append, and noticing nothing costs nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* newsPath(stateDir, "herd-abc");
      // A Run getting on with it. The board may redraw all day.
      const quiet = [record({ id: "r1" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(quiet)) yield* appendNews(file, event);
      // Nothing was written, so there is nothing to deliver and nothing to pay for. This
      // is the whole of the "unchanged state wakes no model" promise: there is no model
      // on this path at all any more, and no file either until something happens.
      expect(yield* fs.exists(file)).toBe(false);

      // And when something does happen, it is one append — not one per tick.
      const ended = [record({ id: "r1", state: "failed" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(ended)) yield* appendNews(file, event);
      expect(pendingNews(yield* readNews(file)).items).toHaveLength(1);
    }),
  ));

test("a Run ready to release when it ends is said once as ready, never as ended", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* newsPath(stateDir, "herd-abc");
      const sentence =
        "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it.";
      const ready = new Map([["r1", { at: "1a2b3c4d", sentence }]]);
      const ended = [record({ id: "r1", state: "succeeded" })];

      const events = eventsIn(ended, new Map(), ready);
      expect(events).toEqual([
        { run: "r1", key: "r1:ready:1a2b3c4d", text: `Run r1 (Implement): ${sentence}` },
      ]);
      for (let tick = 0; tick < 20; tick++)
        for (const event of eventsIn(ended, new Map(), ready)) yield* appendNews(file, event);
      expect(pendingNews(yield* readNews(file)).items.map((item) => item.key)).toEqual([
        "r1:ready:1a2b3c4d",
      ]);
    }),
  ));

test("a Reopened agent finishing what it was told is said once, and not while it works", () => {
  const card = (status: string) =>
    task({
      run: "r1",
      state: status === "working" ? "active" : "done",
      reopened: { delivery: "d-1", agent: "builder", told: "merge and tag it", status },
    });
  const seen = new Set<string>();
  const ended = [record({ id: "r1", state: "succeeded" })];
  const said = (status: string) =>
    eventsIn(ended, new Map(), new Map(), idleAgain([card(status)], seen)).filter((event) =>
      event.key.includes(":reopened:"),
    );

  // Idle before anyone saw it work: nothing it was told has finished yet.
  expect(said("idle")).toEqual([]);
  expect(said("working")).toEqual([]);
  expect(said("working")).toEqual([]);
  expect(said("idle")).toEqual([
    {
      run: "r1",
      key: "r1:reopened:d-1",
      text: "Run r1 (Implement): builder has finished what it was told after the Run ended (“merge and tag it”). What came of it?",
    },
  ]);
  // Once per Delivery: idle again is not finishing again.
  expect(said("idle")).toEqual([]);
});

test("a Reopened agent that goes from working to blocked has not finished what it was told", () => {
  const card = (status: string) =>
    task({
      run: "r1",
      reopened: { delivery: "d-1", agent: "builder", told: "merge it", status },
    });
  const seen = new Set<string>();
  expect(idleAgain([card("working")], seen).size).toBe(0);
  expect(idleAgain([card("blocked")], seen).size).toBe(0);
  // Still remembered as worked on: once it is idle, it has finished.
  expect([...idleAgain([card("idle")], seen).keys()]).toEqual(["r1"]);
});
