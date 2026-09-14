// Collie speaking without being spoken to. What matters is that it speaks about the right
// things, says each of them once, and that speaking first buys it no authority at all.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { eventsIn, nextEvent, readSaid, remember, type Event } from "../src/proactive";
import { RunStore, type RunRecord } from "../src/run";

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

test("a Run that stopped says so once, and says so again only for a different reason", () => {
  const halted = eventsIn([record({ id: "r1", halt: "evidence_missing" })]);
  const said = new Set(halted.map((e) => e.key));

  // The board redraws every few seconds: the same halt must not be reported every time.
  expect(nextEvent(halted, said)).toBeNull();
  expect(nextEvent(eventsIn([record({ id: "r1", halt: "evidence_missing" })]), said)).toBeNull();

  // Resumed, and halted again for something else: that is new, and is said.
  const other = eventsIn([record({ id: "r1", halt: "no_progress", iteration: 2 })]);
  expect(nextEvent(other, said)).not.toBeNull();

  // And proving one of three gaps is progress worth saying, so the gap list is the key.
  const three = eventsIn([record({ id: "r2", evidence_gaps: ["a", "b", "c"] })]);
  const two = eventsIn([record({ id: "r2", evidence_gaps: ["a", "b"] })]);
  expect(three[0]!.key).not.toBe(two[0]!.key);
});

test("one thing at a time: several Runs ending together is one thing that happened", () => {
  const events = eventsIn([
    record({ id: "r1", status: "done" }),
    record({ id: "r2", status: "failed" }),
    record({ id: "r3", halt: "no_progress" }),
  ]);
  expect(events).toHaveLength(3);

  // The next one, not all of them: a board that fired three turns at once would be the
  // notification storm this exists to replace.
  const first = nextEvent(events, new Set())!;
  expect(first.run).toBe("r1");
  const second = nextEvent(events, new Set([first.key]))!;
  expect(second.run).toBe("r2");
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
      expect(nextEvent(events, said)).toBeNull();
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
