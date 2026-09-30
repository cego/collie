// Where Runs end, counted across all of them. Data only: nothing here is a threshold.

import { expect, test } from "bun:test";
import type { RunView } from "../src/engine";
import type { Metrics } from "../src/metrics";
import { reportOf } from "../src/report";

const view = (over: Partial<RunView> & { runId: string }): RunView => ({
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
  mr: null,
  ...over,
});

const metrics = (rework: number, pass: number, fail: number, unstable: number): Metrics => ({
  timeToFirstEvidence: null,
  verifications: { pass, fail, unstable, byCollie: 0 },
  slices: { done: 0, total: 0 },
  rework,
  peakContext: null,
  halts: [],
  obstacles: [],
});

test("each workflow is tallied by how its Runs ended, and only a recorded MR counts", () => {
  const report = reportOf(
    [
      view({ runId: "a", status: { status: "complete", value: "done" }, mr: "https://mr/1" }),
      view({ runId: "b", status: { status: "failed", reason: "boom", entry: "e" } }),
      view({ runId: "c", workflow: "review", status: { status: "suspended" } }),
      view({ runId: "d", workflow: "review", status: { status: "pending" } }),
      view({ runId: "e", status: { status: "complete", value: "no mr" } }),
    ],
    new Map(),
    null,
  );
  expect(report.total).toBe(5);
  expect(report.workflows.map((tally) => tally.workflow)).toEqual(["implement", "review"]);
  const [implement, review] = report.workflows;
  expect(implement).toMatchObject({ total: 3, complete: 2, failed: 1, withMr: 1 });
  expect(review).toMatchObject({ total: 2, suspended: 1, pending: 1, complete: 0, withMr: 0 });
  expect(report.failed).toEqual([{ runId: "b", workflow: "implement", reason: "boom" }]);
});

test("a Run carrying a stop control is counted and listed as stopped", () => {
  const report = reportOf(
    [
      view({ runId: "a", controls: ["stop"], status: { status: "suspended" } }),
      view({ runId: "b", controls: ["hold"] }),
    ],
    new Map(),
    null,
  );
  expect(report.workflows[0]!.stopped).toBe(1);
  expect(report.stopped).toEqual([{ runId: "a", workflow: "implement" }]);
});

test("answered and open decisions come from each question's answer", () => {
  const report = reportOf(
    [
      view({
        runId: "a",
        waiting: [
          { name: "q1", prompt: "?", options: [], answer: "yes" },
          { name: "q2", prompt: "?", options: [], answer: null },
          { name: "q3", prompt: "?", options: [], answer: "no" },
        ],
      }),
    ],
    new Map(),
    null,
  );
  expect(report.workflows[0]).toMatchObject({ answered: 2, open: 1 });
});

test("since drops Runs admitted earlier, and the total says so", () => {
  const report = reportOf(
    [
      view({ runId: "old", created: "2026-09-01T00:00:00.000Z" }),
      view({ runId: "new", created: "2026-09-20T00:00:00.000Z" }),
    ],
    new Map(),
    "2026-09-10",
  );
  expect(report.since).toBe("2026-09-10");
  expect(report.total).toBe(1);
  expect(report.workflows[0]!.total).toBe(1);
});

test("metrics are summed per workflow, and a Run without any adds nothing", () => {
  const report = reportOf(
    [view({ runId: "a" }), view({ runId: "b" }), view({ runId: "c" })],
    new Map([
      ["a", metrics(2, 3, 1, 0)],
      ["b", metrics(1, 4, 0, 2)],
    ]),
    null,
  );
  expect(report.workflows[0]).toMatchObject({
    rework: 3,
    verifications: { pass: 7, fail: 1, unstable: 2 },
  });
});

test("a completed value that is not a string is shown as JSON, oldest first", () => {
  const report = reportOf(
    [
      view({
        runId: "later",
        created: "2026-09-30T12:00:00.000Z",
        status: { status: "complete", value: { mr: 7 } },
        mr: "https://mr/7",
      }),
      view({
        runId: "earlier",
        created: "2026-09-30T09:00:00.000Z",
        status: { status: "complete", value: "plain" },
      }),
    ],
    new Map(),
    null,
  );
  expect(report.completed).toEqual([
    { runId: "earlier", workflow: "implement", value: "plain", mr: null },
    { runId: "later", workflow: "implement", value: '{"mr":7}', mr: "https://mr/7" },
  ]);
});
