// Collie speaking without being spoken to. What matters is that it speaks about the right
// things, says each of them once, and that speaking first buys it no authority at all.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { eventsIn, readSaid, remember, type Event } from "../src/proactive";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import { RunStore, type RunRecord } from "../src/run";
import { runRecord } from "./support/records";

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

/**
 * A record as the board has already read it; nothing here reads a file.
 *
 * SAFETY: every field of `RunRecord` is spelled out below, so the assertion only drops
 * the `readonly` the schema adds. A field added to the schema fails the last test in this
 * file, which builds one through `RunStore` and runs it through the same function.
 */
const record = (over: Partial<RunRecord> & { id: string }): RunRecord =>
  ({
    seq: 1,
    slug: "implement-a-thing",
    named_after: "a thing",
    workflow: "implement",
    cwd: "/repo",
    session: null,
    workspace: null,
    workspace_label: null,
    workspace_worktree: null,
    activated_cwd: null,
    worktree: null,
    created_at: "2026-09-11T10:00:00.000Z",
    finished_at: null,
    status: "running",
    iteration: 1,
    max_iterations: 4,
    inputs: {},
    input_sources: {},
    steps: [],
    parent: null,
    children: [],
    choices: [],
    decisions: {},
    fanout: null,
    awaiting: null,
    handoffs: [],
    disputed: [],
    deferred: [],
    outstanding: [],
    target_label: "a thing",
    synthesis: null,
    notified: [],
    unpushed: null,
    fixed: 0,
    definition: null,
    outcome: null,
    evidence_gaps: [],
    obstacle: null,
    approved_verifications: [],
    halt: null,
    blocking_seen: null,
    unreviewed: null,
    previous_review: null,
    mr_url: null,
    linear_issues: [],
    summary: null,
    ...over,
  }) as RunRecord;

test("a Run getting on with it is not news", () => {
  expect(eventsIn([record({ id: "r1" })])).toEqual([]);
  // Nor is a step starting, a round going by, or any amount of time passing: none of
  // them is a fact about whether the work is getting anywhere.
  expect(eventsIn([record({ id: "r1", iteration: 3 })])).toEqual([]);
});

test("the things worth saying are the things a human would want to know", () => {
  const said = (over: Partial<RunRecord>) => eventsIn([record({ id: "r1", ...over })])[0] ?? null;

  expect(said({ halt: "evidence_missing" })!.text).toContain("stopped with evidence_missing");
  expect(said({ awaiting: "choice" })!.text).toContain("waiting on me");
  expect(said({ evidence_gaps: ["tests failed"] })!.text).toContain("cannot show it did what");
  expect(said({ obstacle: "tests has failed 3 times." })!.text).toContain("repeating itself");
  expect(said({ status: "done" })!.text).toContain("ended done");
  expect(said({ status: "failed" })!.text).toContain("ended failed");
  // Blocked with neither a halt code nor a question is still stopped for a human.
  expect(said({ status: "blocked", summary: "step build blocked: needs a token" })!.text).toContain(
    "is blocked: step build blocked: needs a token",
  );
  // Drift Collie escalated rather than corrected is the human's already, and is said.
  const drifted = eventsIn([record({ id: "r1" })], new Map([["r1", "keep-envelope"]]))[0]!;
  expect(drifted.text).toContain("drifted from keep-envelope and Collie could not correct it");
  expect(drifted.key).toBe("r1:drift:keep-envelope");
  // A finished Run's drift is history; its ending is the event.
  expect(
    eventsIn([record({ id: "r1", status: "done" })], new Map([["r1", "keep-envelope"]]))[0]!.text,
  ).toContain("ended done");

  // Every one of them names the Run it is about, which is what a proposal would target.
  expect(said({ halt: "no_progress" })!.run).toBe("r1");
});

/** What `sayWhatHappened` keeps: every event this Herd has not already said. */
const unsaid = (events: ReadonlyArray<Event>, said: ReadonlySet<string>) =>
  events.filter((event) => !said.has(event.key));

test("a Run that stopped says so once, and says so again only for a different reason", () => {
  const halted = eventsIn([record({ id: "r1", halt: "evidence_missing" })]);
  const said = new Set(halted.map((e) => e.key));

  // The board redraws every few seconds: the same halt must not be reported every time.
  expect(unsaid(halted, said)).toHaveLength(0);
  expect(unsaid(eventsIn([record({ id: "r1", halt: "evidence_missing" })]), said)).toHaveLength(0);

  // Resumed, and halted again for something else: that is new, and is said.
  const other = eventsIn([record({ id: "r1", halt: "no_progress", iteration: 2 })]);
  expect(unsaid(other, said)).toHaveLength(1);

  // And proving one of three gaps is progress worth saying, so the gap list is the key.
  const three = eventsIn([record({ id: "r2", evidence_gaps: ["a", "b", "c"] })]);
  const two = eventsIn([record({ id: "r2", evidence_gaps: ["a", "b"] })]);
  expect(three[0]!.key).not.toBe(two[0]!.key);
});

test("several Runs ending together is every one of them, kept for one batch", () => {
  const events = eventsIn([
    record({ id: "r1", status: "done" }),
    record({ id: "r2", status: "failed" }),
    record({ id: "r3", halt: "no_progress" }),
  ]);

  // All three, not the first: none of them is dropped because the others happened at the
  // same moment. What stops three turns is that they go into one bounded batch, which is
  // `news.ts`'s job — not this one's.
  expect(unsaid(events, new Set()).map((event) => event.run)).toEqual(["r1", "r2", "r3"]);
});

test("a Run says the most pressing thing about it, not every true thing", () => {
  // Halted *and* with gaps: the halt is why it stopped, and that is what to ask about.
  const events = eventsIn([
    record({ id: "r1", halt: "evidence_missing", evidence_gaps: ["tests failed"] }),
  ]);
  expect(events).toHaveLength(1);
  expect(events[0]!.text).toContain("stopped with evidence_missing");
});

test("what has been said survives the Home being closed and reopened", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = `${stateDir}/herd-1`;
      yield* fs.makeDirectory(dir, { recursive: true });

      expect(yield* readSaid(dir)).toEqual(new Set());
      yield* remember(dir, "r1:halt:no_progress:1", "2026-09-11T10:00:00.000Z");

      // A new Home reads the same journal: an event announced before a restart is not
      // announced again after one.
      const said = yield* readSaid(dir);
      expect(said.has("r1:halt:no_progress:1")).toBe(true);
      const events = eventsIn([record({ id: "r1", halt: "no_progress" })]);
      expect(unsaid(events, said)).toHaveLength(0);
    }),
  ));

test("a Run with no label is still named by something a human can find", () => {
  const events = eventsIn([record({ id: "r1", status: "done", target_label: null })]);
  expect(events[0]!.text).toContain("implement-a-thing");
});

test("the event carries no action, so speaking first grants nothing", () => {
  const event: Event = eventsIn([record({ id: "r1", halt: "no_progress" })])[0]!;
  // An Event is a Run, a key and a question. There is nowhere in it to put a thing to
  // do: what may be done comes back from the evaluator and through `validate`, exactly
  // as it does for a message somebody typed.
  expect(Object.keys(event).sort()).toEqual(["key", "run", "text"]);
  expect(event.text.endsWith("?")).toBe(true);
});

test("RunStore records and these events agree about what a Run is", () =>
  runEffect(
    Effect.gen(function* () {
      // The point of the fixture above is that it is a real record; if the schema grows
      // a required field, this fails rather than the fixture quietly drifting.
      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd: "/repo",
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "a thing",
      });
      run.record.status = "failed";
      expect(eventsIn([run.record])[0]!.text).toContain("ended failed");
    }),
  ));

test("noticing something costs a file append, and noticing nothing costs nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* newsPath(stateDir, "herd-abc");
      // A Run getting on with it. The board may redraw all day.
      const quiet = [runRecord({ id: "r1" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(quiet)) yield* appendNews(file, event);
      // Nothing was written, so there is nothing to deliver and nothing to pay for. This
      // is the whole of the "unchanged state wakes no model" promise: there is no model
      // on this path at all any more, and no file either until something happens.
      expect(yield* fs.exists(file)).toBe(false);

      // And when something does happen, it is one append — not one per tick.
      const halted: RunRecord[] = [runRecord({ id: "r1", halt: "evidence_missing" })];
      for (let tick = 0; tick < 50; tick++)
        for (const event of eventsIn(halted)) yield* appendNews(file, event);
      expect(pendingNews(yield* readNews(file)).items).toHaveLength(1);
    }),
  ));
