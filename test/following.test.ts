// What `collie run wait` stops at, and what `--follow` prints, from two looks at a Run.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { MissingFact, RunProgress } from "../src/board-model";
import type { RunView } from "../src/engine";
import { followEvents, followLine, reached } from "../src/following";

const view = (over: Partial<RunView> = {}): RunView => ({
  runId: "r1",
  workflow: "implement",
  project: "/p",
  task: null,
  parent: null,
  registration: "r",
  entry: "e",
  input: {},
  provenance: {},
  strategies: {},
  options: {},
  cwd: "/p",
  branch: null,
  workspace: null,
  worktree: null,
  outcome: "feature",
  created: "2026-09-30T10:00:00.000Z",
  status: { status: "pending" },
  waiting: [],
  controls: [],
  diagnostic: null,
  parked: null,
  awaiting: null,
  mr: null,
  landing: null,
  ...over,
});

const ciRunning: MissingFact = { fact: "ci", said: "CI is still running", settling: true };
const failed: MissingFact = { fact: "succeeded", said: "it failed", settling: false };

const progress = (over: Partial<RunProgress> = {}): RunProgress => ({
  ready: { ready: false, missing: [ciRunning] },
  ci: null,
  steps: [],
  ...over,
});

test("attention stops at a park whose status is still pending", () => {
  expect(reached("attention", view(), null, false)).toBe("waiting");
  expect(
    reached("attention", view({ parked: "the pane will not take a prompt" }), null, false),
  ).toBe("reached");
  expect(reached("attention", view({ status: { status: "suspended" } }), null, false)).toBe(
    "reached",
  );
  expect(reached("terminal", view({ parked: "stuck" }), null, false)).toBe("waiting");
});

test("ready waits while what is missing may still come, and is stuck once only a human can help", () => {
  const done = view({ status: { status: "complete", value: "ok" } });
  expect(reached("ready", done, null, true)).toBe("waiting");
  expect(reached("ready", done, progress(), true)).toBe("waiting");
  expect(reached("ready", done, progress({ ready: { ready: true, missing: [] } }), true)).toBe(
    "reached",
  );
  expect(
    reached("ready", done, progress({ ready: { ready: false, missing: [failed] } }), true),
  ).toBe("stuck");
});

test("needs-human stops at ready, at attention, and at an end nothing will move by itself", () => {
  const done = view({ status: { status: "complete", value: "ok" } });
  expect(reached("needs-human", view(), progress(), false)).toBe("waiting");
  expect(reached("needs-human", done, progress(), true)).toBe("waiting");
  expect(
    reached("needs-human", done, progress({ ready: { ready: true, missing: [] } }), true),
  ).toBe("reached");
  expect(
    reached("needs-human", done, progress({ ready: { ready: false, missing: [failed] } }), true),
  ).toBe("reached");
  expect(reached("needs-human", view({ parked: "stuck" }), progress(), false)).toBe("reached");
});

test("follow says each operation started and finished, each agent once, a park, the merge request and CI", () => {
  const first = { view: view(), progress: progress() };
  const building = {
    view: view(),
    progress: progress({ steps: [{ operation: "01-a.md", agent: "builder", done: false }] }),
  };
  expect(followEvents(first, building)).toEqual([
    { type: "agent", agent: "builder", operation: "01-a.md" },
    { type: "operation", operation: "01-a.md", agent: "builder", state: "started" },
  ]);
  const reviewed = {
    view: view({ mr: "mr:github.com/cego/collie#30", parked: "the gate's checks failed" }),
    progress: progress({
      ci: { state: "running" },
      steps: [
        { operation: "01-a.md", agent: "builder", done: true },
        { operation: "02-b.md", agent: "builder", done: false },
      ],
    }),
  };
  const events = followEvents(building, reviewed);
  expect(events).toEqual([
    { type: "operation", operation: "01-a.md", agent: "builder", state: "finished" },
    { type: "operation", operation: "02-b.md", agent: "builder", state: "started" },
    { type: "ci", ci: { state: "running" } },
    { type: "parked", reason: "the gate's checks failed" },
    { type: "mr", mr: "mr:github.com/cego/collie#30" },
  ]);
  expect(Arr.map(events, (event) => followLine("r1", event))).toEqual([
    "r1: operation 01-a.md finished",
    "r1: operation 02-b.md started",
    "r1: CI running",
    "r1: parked: the gate's checks failed",
    "r1: merge request mr:github.com/cego/collie#30 opened",
  ]);
  // Nothing moved: nothing to say.
  expect(followEvents(reviewed, reviewed)).toEqual([]);
  // No pipeline at all is not news on the first look.
  expect(
    followEvents(first, { view: view(), progress: progress({ ci: { state: "none" } }) }),
  ).toEqual([]);
});

test("a wait that ends by itself is no attention, and is followed as what it awaits", () => {
  const awaiting = { on: "CI on group/app!3", who: null, since: "2026-10-21T10:00:00.000Z" };
  expect(reached("attention", view({ awaiting }), null, false)).toBe("waiting");
  const events = followEvents(
    { view: view(), progress: null },
    { view: view({ awaiting }), progress: null },
  );
  expect(events).toEqual([{ type: "awaiting", on: "CI on group/app!3", who: null }]);
  expect(followLine("r1", events[0]!)).toBe("r1: Waiting for CI on group/app!3.");
  expect(
    followEvents(
      { view: view({ awaiting }), progress: null },
      { view: view({ awaiting }), progress: null },
    ),
  ).toEqual([]);
});
