// Where Runs end, counted across all of them. Data only: nothing here is a threshold.

import { expect, test } from "bun:test";
import { HOLD, STOP, type RunView } from "../src/engine";
import type { Metrics } from "../src/board-model";
import { reportOf } from "../src/report";
import type { OutcomeRecords } from "../src/outcomes";
import type { Metric } from "../src/metrics";

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
  awaiting: null,
  mr: null,
  landing: null,
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

test("a Run lists each issue its input says Closes #n for, once", () => {
  const report = reportOf(
    [
      view({
        runId: "a",
        input: {
          goal: "Fix it. The merge request must say `Closes #12`, `closes #13`, Closes #12.",
        },
      }),
      view({ runId: "b", input: { goal: "Fix #14.", rounds: 3 } }),
    ],
    new Map(),
    null,
  );
  expect(report.runs.map(({ closes }) => closes)).toEqual([[12, 13], []]);
});

test("a Run carrying a stop control is counted and listed as stopped", () => {
  const report = reportOf(
    [
      view({ runId: "a", controls: [STOP], status: { status: "suspended" } }),
      view({ runId: "b", controls: [HOLD] }),
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

const records = (over: Partial<OutcomeRecords> = {}): OutcomeRecords => ({
  rounds: [],
  disposition: null,
  steering: [],
  verifications: [],
  ...over,
});

const check = (over: Partial<OutcomeRecords["verifications"][number]> = {}) => ({
  name: "check",
  executable: "bun",
  argv: ["run", "check"],
  cwd: "/w",
  start: "abc:f1",
  result: "pass",
  by: "collie",
  ...over,
});

const line = (kind: Metric["kind"], subject: string, value: number, note = ""): Metric => ({
  at: "2026-09-30T10:00:00.000Z",
  kind,
  subject,
  value,
  note,
});

test("an empty window measures nothing, and says no share rather than zero", () => {
  const report = reportOf(
    [view({ runId: "old", created: "2026-01-01T00:00:00.000Z" })],
    new Map(),
    "2026-09-01",
    new Map([["old", { records: records({ disposition: "merged" }), metrics: [] }]]),
  );
  expect(report.total).toBe(0);
  expect(report.measures.rounds).toEqual({ runs: [], median: null, atCap: { count: 0, runs: [] } });
  expect(report.measures.dispositions.merged).toEqual({ count: 0, runs: [], share: null });
  expect(report.measures.verifications.total).toBe(0);
  expect(report.measures.peakContext).toEqual([]);
});

test("every measure is counted from the Runs' records, and names the Runs it counts", () => {
  const report = reportOf(
    ["a", "b", "c", "d"].map((runId) => view({ runId })),
    new Map(),
    null,
    new Map([
      [
        "a",
        {
          records: records({
            rounds: [
              { round: 1, of: 4 },
              { round: 2, of: 4 },
              { round: 3, of: 4 },
              { round: 4, of: 4 },
            ],
            disposition: "merged",
            steering: [
              { kind: "steer", origin: "board" },
              { kind: "followup", origin: "chat" },
              { kind: "deliver", origin: "agent" },
              { kind: "correction", origin: "evaluator" },
            ],
            verifications: [
              check(),
              check(),
              check({ result: "fail" }),
              check({ by: "agent", name: "typecheck" }),
            ],
          }),
          metrics: [
            line("context", "a-build", 90_000),
            line("context", "a-review", 120_000),
            line("halt", "", 0, "a-build has written nothing to /s/agents/run-1/build.json yet."),
          ],
        },
      ],
      [
        "b",
        {
          records: records({
            rounds: [
              { round: 1, of: 4 },
              { round: 2, of: 4 },
            ],
            disposition: "superseded",
            steering: [{ kind: "steer", origin: "cli-tty" }],
          }),
          metrics: [
            line(
              "halt",
              "",
              0,
              "run-b-review-1-r1 in pane w7:p1 could not be sent its step. `collie run resume run-b` tries again.",
            ),
          ],
        },
      ],
      [
        "c",
        {
          records: records({ rounds: [{ round: 1, of: 1 }], disposition: "merged" }),
          metrics: [
            line(
              "halt",
              "",
              0,
              "run-c-review-1-r1 in pane w9:p2 could not be sent its step. `collie run resume run-c` tries again.",
            ),
          ],
        },
      ],
      ["d", { records: null, metrics: [] }],
    ]),
  );
  const { rounds, dispositions, steering, verifications, parks, peakContext } = report.measures;
  // A lone review allows one round, so it is no rally and is not counted as one.
  expect(rounds.runs).toEqual([
    { runId: "a", reached: 4, cap: 4 },
    { runId: "b", reached: 2, cap: 4 },
  ]);
  expect(rounds.median).toBe(3);
  expect(rounds.atCap).toEqual({ count: 1, runs: ["a"] });
  expect(dispositions.merged).toEqual({ count: 2, runs: ["a", "c"], share: 2 / 3 });
  expect(dispositions.superseded).toEqual({ count: 1, runs: ["b"], share: 1 / 3 });
  expect(dispositions.abandoned).toEqual({ count: 0, runs: [], share: 0 });
  expect(steering.runs).toEqual([
    {
      runId: "a",
      steer: 1,
      followup: 1,
      deliver: 1,
      correction: 1,
      byOrigin: { human: 1, chat: 1, agent: 1, host: 1 },
    },
    {
      runId: "b",
      steer: 1,
      followup: 0,
      deliver: 0,
      correction: 0,
      byOrigin: { human: 1, chat: 0, agent: 0, host: 0 },
    },
  ]);
  expect(steering.byOrigin.human).toEqual({ count: 2, runs: ["a", "b"] });
  expect(steering.byOrigin.host).toEqual({ count: 1, runs: ["a"] });
  expect(verifications.total).toBe(4);
  expect(verifications.runs).toEqual([{ runId: "a", total: 4, agent: 1, collie: 3 }]);
  expect(verifications.byCollector).toEqual({ agent: 1, collie: 3 });
  // The second identical pass repeats the first; the failure on the same tree does not.
  expect(verifications.repeated).toEqual({ count: 1, runs: ["a"] });
  expect(verifications.executableOnly).toEqual({ count: 0, runs: [] });
  expect(parks.collectExpiries).toEqual({ count: 1, runs: ["a"] });
  expect(parks.byReason).toEqual([
    {
      reason: "<run> in pane <pane> could not be sent its step. <command> tries again.",
      count: 2,
      runs: ["b", "c"],
    },
  ]);
  expect(peakContext).toEqual([
    { runId: "a", tokens: 120_000, agent: "a-review" },
    { runId: "b", tokens: null, agent: null },
    { runId: "c", tokens: null, agent: null },
    { runId: "d", tokens: null, agent: null },
  ]);
});

test("a check named only by its executable is counted, wherever the executable was found", () => {
  const report = reportOf(
    [view({ runId: "a" })],
    new Map(),
    null,
    new Map([
      [
        "a",
        {
          records: records({
            verifications: [
              check({ name: "bun", executable: "/usr/local/bin/bun" }),
              check({ name: "test" }),
            ],
          }),
          metrics: [],
        },
      ],
    ]),
  );
  expect(report.measures.verifications.executableOnly).toEqual({ count: 1, runs: ["a"] });
});
