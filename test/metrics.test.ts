// Progress is evidence, not activity. These are the facts a Run records about itself,
// and the one judgement it makes from them — which produces a sentence, never a stop.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import type { AuditLine } from "../src/audit";
import {
  metricsOf,
  obstacleOf,
  repeatedFailure,
  type FailureLike,
  type Metric,
} from "../src/metrics";
import { usageLines, usageOf, withChildren, type UsageEntry } from "../src/usage-ledger-model";
import { compareSets, interventionsIn, trialLines, type TrialRun } from "../src/trial-model";

const failure = (over: Partial<FailureLike> = {}): FailureLike => ({
  name: "tests",
  result: "fail",
  exit: 1,
  tail: { stderr: "1 test failed\n  at cli.test.ts:9\n" },
  ...over,
});

const line = (over: Partial<Metric> & { kind: Metric["kind"] }): Metric => ({
  at: "2026-09-11T10:00:00.000Z",
  subject: "",
  value: 0,
  note: "",
  ...over,
});

test("three identical failures are a Run going round; two are not", () => {
  expect(repeatedFailure([failure(), failure()], 3)).toBeNull();
  const found = repeatedFailure([failure(), failure(), failure()], 3);
  expect(found).not.toBeNull();
  expect(found!.name).toBe("tests");
  expect(found!.times).toBe(3);
  expect(found!.exit).toBe(1);
  expect(found!.line).toBe("at cli.test.ts:9");
});

test("failing differently is working through a problem, not going round", () => {
  // A different last line each time: the Run is getting somewhere.
  expect(
    repeatedFailure(
      [
        failure({ tail: { stderr: "at a.ts:1" } }),
        failure({ tail: { stderr: "at b.ts:2" } }),
        failure({ tail: { stderr: "at c.ts:3" } }),
      ],
      3,
    ),
  ).toBeNull();
  // A different exit is a different failure too.
  expect(repeatedFailure([failure(), failure(), failure({ exit: 2 })], 3)).toBeNull();
  // A pass in the middle breaks the run of failures.
  expect(repeatedFailure([failure(), failure({ result: "pass" }), failure()], 3)).toBeNull();
});

test("the run of failures is the last n, and it is per command", () => {
  // Two commands failing once each is not one command failing twice.
  expect(
    repeatedFailure([failure(), failure({ name: "lint" }), failure({ name: "typecheck" })], 3),
  ).toBeNull();
  // An earlier pass does not save a command that has failed three times since.
  expect(
    repeatedFailure([failure({ result: "pass" }), failure(), failure(), failure()], 3),
  ).not.toBeNull();
  // Interleaved commands: each is judged on its own last three.
  expect(
    repeatedFailure(
      [
        failure(),
        failure({ name: "lint", result: "pass" }),
        failure(),
        failure({ name: "lint", result: "pass" }),
        failure(),
      ],
      3,
    ),
  ).not.toBeNull();
});

test("the obstacle says what is repeating and asks for a different approach", () => {
  const said = obstacleOf({ name: "tests", times: 3, exit: 1, line: "at cli.test.ts:9" });
  expect(said).toContain("tests has failed 3 times in a row the same way (exit 1)");
  expect(said).toContain("at cli.test.ts:9");
  expect(said).toContain("change approach");
  // Not a threat and not a limit: nothing here says the Run will be stopped.
  expect(said).not.toContain("stop");
  // A failure that printed nothing still reads as a sentence.
  expect(obstacleOf({ name: "build", times: 3, exit: 2, line: "" })).toContain("(exit 2).");
});

test("a Run's metrics are what it produced, and when it first produced anything", () => {
  const metrics = metricsOf(
    [
      line({ kind: "context", at: "2026-09-11T10:01:00.000Z", subject: "impl", value: 120_000 }),
      line({
        kind: "verification",
        at: "2026-09-11T10:02:00.000Z",
        subject: "v1",
        value: 1,
        note: "pass",
      }),
      line({
        kind: "verification",
        at: "2026-09-11T10:03:00.000Z",
        subject: "v2",
        value: 0,
        note: "fail",
      }),
      line({
        kind: "verification",
        at: "2026-09-11T10:04:00.000Z",
        subject: "v3",
        value: 1,
        note: "unstable",
      }),
      line({ kind: "slice", subject: "01-a.md", note: "done" }),
      line({ kind: "slice", subject: "02-b.md", note: "blocked" }),
      line({ kind: "round", subject: "review", value: 2 }),
      line({ kind: "context", subject: "impl", value: 340_000 }),
      line({ kind: "halt", subject: "fix", note: "evidence_missing" }),
      line({ kind: "checkpoint", subject: "build", note: "tests has failed 3 times" }),
      line({ kind: "evidence", subject: "feature", value: 2, note: "a; b" }),
    ],
    "2026-09-11T10:00:00.000Z",
  );

  // The first collected result, not the first thing that happened: a context sample is
  // not evidence, and a Run that has sampled context has still proved nothing.
  expect(metrics.timeToFirstEvidence).toBe(120);
  expect(metrics.verifications).toEqual({ pass: 1, fail: 1, unstable: 1, byCollie: 2 });
  expect(metrics.slices).toEqual({ done: 1, total: 2 });
  // Fix rounds and halts both: each is the Run doing something a second time.
  expect(metrics.rework).toBe(2);
  expect(metrics.peakContext).toEqual({ agent: "impl", tokens: 340_000 });
  expect(metrics.halts).toEqual(["evidence_missing"]);
  expect(metrics.obstacles).toEqual(["tests has failed 3 times"]);
});

test("a ticket is one slice however often its status is noted, and only a re-review is rework", () => {
  const metrics = metricsOf(
    [
      line({ kind: "slice", subject: "01-a.md", note: "started" }),
      line({ kind: "round", subject: "review#1", value: 1 }),
      line({ kind: "slice", subject: "01-a.md", note: "done" }),
      line({ kind: "round", subject: "review#2", value: 2 }),
    ],
    "2026-09-11T10:00:00.000Z",
  );
  expect(metrics.slices).toEqual({ done: 1, total: 1 });
  expect(metrics.rework).toBe(1);
});

test("a Run that has proved nothing says so, rather than reporting a zero", () => {
  const metrics = metricsOf([], "2026-09-11T10:00:00.000Z");
  // Null, not 0: "no evidence yet" and "evidence immediately" are different facts.
  expect(metrics.timeToFirstEvidence).toBeNull();
  expect(metrics.peakContext).toBeNull();
  expect(metrics.verifications).toEqual({ pass: 0, fail: 0, unstable: 0, byCollie: 0 });
  expect(metrics.rework).toBe(0);
});

const spent = (
  agent: string,
  key: string,
  tokens: { input: number; cacheRead: number; cacheCreation: number | null; output: number },
  harness = "claude",
): UsageEntry => ({
  what: "request",
  key,
  at: "2026-09-11T10:00:00.000Z",
  agent,
  session: agent,
  parent: null,
  step: "triage",
  harness,
  model: null,
  effort: null,
  head: null,
  reasoning: null,
  ...tokens,
});

test("a Run's cost is its own usage plus each child Run's, by category, with each child listed", () => {
  const own = usageOf([
    spent("triage", "m1", { input: 1, cacheRead: 10, cacheCreation: 100, output: 1000 }),
  ]);
  const plan = usageOf([
    spent("plan", "m2", { input: 2, cacheRead: 20, cacheCreation: 200, output: 2000 }),
  ]);
  const build = usageOf([
    spent("build", "m3", { input: 3, cacheRead: 30, cacheCreation: null, output: 3000 }),
    spent("build", "m4", { input: 4, cacheRead: 40, cacheCreation: null, output: 4000 }),
  ]);
  const cost = withChildren(own, [
    { runId: "r-plan", usage: plan },
    { runId: "r-build", usage: build },
  ]);
  expect(cost.children).toEqual([
    {
      runId: "r-plan",
      requests: 1,
      input: 2,
      cacheRead: 20,
      cacheCreation: 200,
      output: 2000,
      reasoning: null,
    },
    {
      runId: "r-build",
      requests: 2,
      input: 7,
      cacheRead: 70,
      cacheCreation: null,
      output: 7000,
      reasoning: null,
    },
  ]);
  expect(cost.withChildren).toEqual({
    requests: 4,
    input: 10,
    cacheRead: 100,
    cacheCreation: null,
    output: 10000,
    reasoning: null,
  });
  expect(usageLines(cost)).toContain(
    "tokens with child Runs: 4 requests: output 10000 (reasoning unavailable of it), cache read 100, cache creation unavailable, uncached input 10",
  );
});

test("a child Run whose records cannot be read is listed as such, and leaves the total with child Runs unavailable", () => {
  const own = usageOf([
    spent("triage", "m1", { input: 1, cacheRead: 10, cacheCreation: 100, output: 1000 }),
  ]);
  const cost = withChildren(own, [{ runId: "r-gone", usage: null }]);
  expect(cost.children).toEqual([
    {
      runId: "r-gone",
      unreadable: true,
      requests: 0,
      input: null,
      cacheRead: null,
      cacheCreation: null,
      output: null,
      reasoning: null,
    },
  ]);
  expect(cost.withChildren?.output).toBeNull();
  expect(usageLines(cost)).toContain("  child Run r-gone: its records could not be read");
  expect(usageLines(cost)).toContain("tokens with child Runs: unavailable");
});

test("a category one agent's harness does not report leaves the Run's total for it unavailable", () => {
  const usage = usageOf([
    spent("claude-agent", "c1", { input: 1, cacheRead: 2, cacheCreation: 500, output: 3 }),
    spent("codex-agent", "x1", { input: 4, cacheRead: 5, cacheCreation: null, output: 6 }, "codex"),
  ]);
  expect(usage.totals).toMatchObject({ requests: 2, output: 9, cacheCreation: null });
});

type Tokens = { input: number; cacheRead: number; cacheCreation: number | null; output: number };

const request = (
  session: string,
  key: string,
  at: string,
  tokens: Tokens,
  agent = "build",
): UsageEntry => ({
  what: "request",
  key,
  at: `2026-11-18T${at}:00.000Z`,
  agent,
  session,
  parent: null,
  step: "build",
  harness: "claude",
  model: null,
  effort: null,
  head: null,
  reasoning: null,
  ...tokens,
});

const healing = (session: string): UsageEntry => ({
  what: "session",
  agent: "heal",
  session,
  harness: "claude",
  recovery: true,
  startup: { system: null, persona: null, project: null, tools: null, skills: null },
});

const happened = (
  what: "compaction" | "reminder" | "repair",
  session: string,
  at: string,
  step = "build",
): UsageEntry => ({
  what,
  key: `${session}-${what}-${at}`,
  at: `2026-11-18T${at}:00.000Z`,
  agent: "build",
  session,
  parent: null,
  step,
  chars: null,
});
const compacted = (session: string) => happened("compaction", session, "10:06");

const spentOnly = (tokens: Tokens) => [request("s1", `k-${tokens.output}`, "10:00", tokens)];

const trialRun = (
  runId: string,
  over: Partial<Omit<TrialRun, "records">> & { records?: Partial<TrialRun["records"]> } = {},
): TrialRun => ({
  runId,
  created: "2026-11-18T10:00:00.000Z",
  usage: over.usage ?? spentOnly({ input: 1, cacheRead: 0, cacheCreation: 1, output: 1 }),
  audit:
    over.audit === undefined
      ? { reviews: [[]], checks: null, interventions: 0, ended: null }
      : over.audit,
  records: {
    reviews: [[]],
    checks: { passed: 1, of: 1 },
    interventions: 0,
    ended: "2026-11-18T10:30:00.000Z",
    ...over.records,
  },
});

const audited = (...findings: ReadonlyArray<{ severity: string; title: string }>) => ({
  reviews: [findings],
  checks: null,
  interventions: 0,
  ended: null,
});

const firstSet = [
  {
    case: "a",
    run: trialRun("A1", {
      usage: [
        request("s1", "a1", "10:00", { input: 10, cacheRead: 0, cacheCreation: 100, output: 50 }),
        request("s1", "a2", "10:05", { input: 5, cacheRead: 100, cacheCreation: 20, output: 30 }),
        compacted("s1"),
        healing("h1"),
        request(
          "h1",
          "a3",
          "10:10",
          { input: 1, cacheRead: 0, cacheCreation: 10, output: 5 },
          "heal",
        ),
      ],
      audit: audited({ severity: "minor", title: "a nit" }),
      records: {
        reviews: [
          [{ id: "f1", severity: "major", title: "wrong total", file: "src/a.ts", line: 3 }],
          [{ id: "f1", status: "fixed", severity: "major", title: "wrong total" }],
        ],
        checks: { passed: 2, of: 2 },
        interventions: 1,
        ended: "2026-11-18T11:00:00.000Z",
      },
    }),
  },
  {
    case: "b",
    run: trialRun("A2", {
      usage: spentOnly({ input: 20, cacheRead: 0, cacheCreation: 200, output: 100 }),
      audit: audited({ severity: "major", title: "lost write" }),
      records: {
        reviews: [
          [{ id: "g1", severity: "blocker", title: "crash" }],
          [{ id: "g1", status: "fixed", severity: "blocker", title: "crash" }],
          [{ id: "g1", status: "open" }],
        ],
        checks: { passed: 1, of: 2 },
      },
    }),
  },
  {
    case: "c",
    run: trialRun("A3", {
      usage: spentOnly({ input: 30, cacheRead: 0, cacheCreation: 300, output: 150 }),
      audit: null,
      records: { interventions: 2, ended: null },
    }),
  },
];

const secondSet = [
  {
    case: "a",
    run: trialRun("B1", {
      usage: spentOnly({ input: 8, cacheRead: 0, cacheCreation: 80, output: 40 }),
      audit: audited(),
      records: { checks: { passed: 2, of: 2 }, ended: "2026-11-18T10:20:00.000Z" },
    }),
  },
  {
    case: "b",
    run: trialRun("B2", {
      usage: spentOnly({ input: 10, cacheRead: 0, cacheCreation: 100, output: 60 }),
      audit: audited({ severity: "blocker", title: "w" }, { severity: "major", title: "v" }),
      records: { checks: { passed: 2, of: 2 }, ended: "2026-11-18T10:40:00.000Z" },
    }),
  },
  {
    case: "c",
    run: trialRun("B3", {
      usage: spentOnly({ input: 12, cacheRead: 0, cacheCreation: 120, output: 80 }),
      audit: audited(),
      records: { interventions: 1, ended: "2026-11-18T10:10:00.000Z" },
    }),
  },
];

const planted = { a: { file: "src/a.ts", line: 3 } };

test("two sets of Runs are compared per case and per set, on tokens and quality together, and per accepted change", () => {
  const report = compareSets({ compare: firstSet, against: secondSet, planted });
  expect(Arr.map(report.cases, (one) => one.case)).toEqual(["a", "b", "c"]);
  const [a, b, c] = report.cases;
  expect(a!.compare.runs).toEqual([
    {
      runId: "A1",
      figures: {
        "startup.output": 50,
        "startup.cacheRead": 0,
        "startup.cacheCreation": 100,
        "startup.input": 10,
        "startup.reasoning": null,
        "work.output": 30,
        "work.cacheRead": 100,
        "work.cacheCreation": 20,
        "work.input": 5,
        "work.reasoning": null,
        "recovery.output": 5,
        "recovery.cacheRead": 0,
        "recovery.cacheCreation": 10,
        "recovery.input": 1,
        "recovery.reasoning": null,
        "total.output": 85,
        "total.cacheRead": 100,
        "total.cacheCreation": 130,
        "total.input": 16,
        "total.reasoning": null,
        sessions: 2,
        compactions: 1,
        peakContext: 125,
        accepted: 1,
        checksPassed: 1,
        defectsFound: 1,
        escapedDefects: 0,
        reopenedFindings: 0,
        plantedCaught: 1,
        interventions: 1,
        wallMs: 3_600_000,
      },
    },
  ]);
  expect(b!.compare.runs[0]!.figures).toMatchObject({
    accepted: 0,
    checksPassed: 0,
    defectsFound: 1,
    escapedDefects: 1,
    reopenedFindings: 1,
    plantedCaught: null,
    wallMs: 1_800_000,
  });
  expect(c!.compare.runs[0]!.figures).toMatchObject({
    accepted: 1,
    defectsFound: 0,
    escapedDefects: null,
    interventions: 2,
    wallMs: null,
  });
  expect(a!.against.median).toMatchObject({ "total.output": 40, plantedCaught: 0 });
  expect(a!.direction).toEqual({
    accepted: "no worse",
    checksPassed: "no worse",
    escapedDefects: "no worse",
    plantedCaught: "worse",
    reopenedFindings: "no worse",
    interventions: "no worse",
  });
  expect(b!.direction).toMatchObject({ escapedDefects: "worse", plantedCaught: "unavailable" });
  expect(c!.direction).toMatchObject({ escapedDefects: "unavailable" });

  const { compare, against } = report.sets;
  expect(compare.runs).toEqual(["A1", "A2", "A3"]);
  expect(compare.figures).toMatchObject({
    "total.output": 335,
    "total.input": 66,
    "total.cacheCreation": 630,
    "total.reasoning": null,
    accepted: 2,
    defectsFound: 2,
    escapedDefects: null,
    interventions: 3,
    wallMs: null,
    peakContext: 330,
  });
  expect(compare.perAcceptedChange).toMatchObject({
    "total.output": 167.5,
    "total.input": 33,
    "total.cacheCreation": 315,
    "total.cacheRead": 50,
    "total.reasoning": null,
  });
  expect(against.figures).toMatchObject({ accepted: 3, escapedDefects: 2, wallMs: 4_200_000 });
  expect(against.perAcceptedChange).toMatchObject({
    "total.output": 60,
    "total.input": 10,
    "total.cacheCreation": 100,
    "startup.output": 60,
    "work.output": 0,
  });
  const said = Arr.join(trialLines(report), "\n");
  expect(said).not.toContain("%");
  expect(said).toContain("per accepted change");
});

test("a token category one Run of a set never reported is unavailable for the set, not counted as 0", () => {
  const report = compareSets({
    compare: [
      { case: null, run: trialRun("A1") },
      {
        case: null,
        run: trialRun("A2", {
          usage: spentOnly({ input: 1, cacheRead: 2, cacheCreation: null, output: 3 }),
        }),
      },
    ],
    against: [{ case: null, run: trialRun("B1") }],
    planted: {},
  });
  expect(report.sets.compare.figures).toMatchObject({
    "total.cacheCreation": null,
    "startup.cacheCreation": null,
    "total.output": 4,
  });
  expect(report.sets.compare.perAcceptedChange).toMatchObject({
    "total.cacheCreation": null,
    "total.output": 2,
  });
  expect(report.sets.against.figures).toMatchObject({ "total.cacheCreation": 1 });
  expect(report.cases[1]!.compare.median["total.cacheCreation"]).toBeNull();
});

test("a set with no accepted change says so, and gives no per-change figure", () => {
  const report = compareSets({
    compare: [{ case: null, run: trialRun("A1", { records: { checks: { passed: 0, of: 1 } } }) }],
    against: [{ case: null, run: trialRun("B1") }],
    planted: {},
  });
  expect(report.sets.compare.perAcceptedChange).toBe("no accepted change");
  expect(report.sets.against.perAcceptedChange).toMatchObject({ "total.output": 1 });
  expect(Arr.join(trialLines(report), "\n")).toContain("no accepted change");
});

test("fewer defects found by the second set's own reviewers is a figure with no better or worse mark", () => {
  const report = compareSets({
    compare: [
      {
        case: "x",
        run: trialRun("A1", {
          records: { reviews: [[{ severity: "major", title: "m" }], []] },
        }),
      },
    ],
    against: [{ case: "x", run: trialRun("B1") }],
    planted: {},
  });
  const [x] = report.cases;
  expect(x!.compare.median.defectsFound).toBe(1);
  expect(x!.against.median.defectsFound).toBe(0);
  expect(Rec.keys(x!.direction)).not.toContain("defectsFound");
});

test("more blocking findings in the second set's audits marks escaped defects worse for the case", () => {
  const report = compareSets({
    compare: [{ case: "x", run: trialRun("A1", { audit: audited() }) }],
    against: [
      {
        case: "x",
        run: trialRun("B1", { audit: audited({ severity: "blocker", title: "escaped" }) }),
      },
    ],
    planted: {},
  });
  expect(report.cases[0]!.direction.escapedDefects).toBe("worse");
  expect(report.cases[0]!.against.median.escapedDefects).toBe(1);
});

test("repeats of a case are reported per Run and as the case's median and range", () => {
  const spent = (output: number) => spentOnly({ input: 0, cacheRead: 0, cacheCreation: 0, output });
  const repeats = (prefix: string, outputs: ReadonlyArray<number>) =>
    Arr.map(outputs, (output, at) => ({
      case: "x",
      run: trialRun(`${prefix}${at + 1}`, { usage: spent(output) }),
    }));
  const report = compareSets({
    compare: repeats("A", [10, 30, 20]),
    against: repeats("B", [5, 50, 7]),
    planted: {},
  });
  expect(report.cases).toHaveLength(1);
  const [x] = report.cases;
  expect(Arr.map(x!.compare.runs, (one) => [one.runId, one.figures["total.output"]])).toEqual([
    ["A1", 10],
    ["A2", 30],
    ["A3", 20],
  ]);
  expect(x!.compare.median["total.output"]).toBe(20);
  expect(x!.compare.range.min["total.output"]).toBe(10);
  expect(x!.compare.range.max["total.output"]).toBe(30);
  expect(x!.against.median["total.output"]).toBe(7);
  expect(x!.against.range.min["total.output"]).toBe(5);
  expect(x!.against.range.max["total.output"]).toBe(50);
});

test("interventions are what anyone outside the Run did to it, not its own agents or its host", () => {
  const acted = (
    operation: string,
    origin: AuditLine["actor"]["origin"],
    from?: AuditLine["actor"]["from"],
  ): AuditLine => ({
    at: "2026-11-18T10:00:00.000Z",
    operation,
    request: `${operation}-${origin}`,
    actor: from === undefined ? { origin, requestId: "r" } : { origin, requestId: "r", from },
    result: null,
  });
  expect(
    interventionsIn("run-1", [
      acted("steer", "cli-tty"),
      acted("answer", "agent", { run: "run-operator", agent: "operator" }),
      acted("resume", "host"),
      acted("steer", "agent", { run: "run-1", agent: "build" }),
      acted("start", "cli-tty"),
    ]),
  ).toBe(2);
});

test("a finding a reviewer's seat raised and its synthesis repeated with an id is one defect found", () => {
  const report = compareSets({
    compare: [
      {
        case: null,
        run: trialRun("A1", {
          records: {
            reviews: [
              [{ severity: "major", title: "Lost write", file: "src/a.ts" }],
              [{ id: "F1", severity: "major", title: "lost write", file: "src/a.ts" }],
              [{ id: "F1", status: "fixed" }],
            ],
          },
        }),
      },
    ],
    against: [],
    planted: {},
  });
  expect(report.cases[0]!.compare.median.defectsFound).toBe(1);
});

test("a repair's and an Output reminder's turns are recovery, from when Collie sent each to the end of its step", () => {
  const tokens = (output: number) => ({ input: 1, cacheRead: 0, cacheCreation: 0, output });
  const entries = [
    request("s1", "w1", "10:00", tokens(100)),
    request("s1", "w2", "10:05", tokens(200)),
    happened("reminder", "s1", "10:06"),
    request("s1", "r1", "10:07", tokens(30)),
    { ...request("s1", "n1", "10:20", tokens(400)), step: "fix" },
    happened("repair", "s1", "10:21", "fix"),
    { ...request("s1", "r2", "10:22", tokens(5)), step: "fix" },
  ];
  expect(usageOf(entries).recovery).toMatchObject({ requests: 2, output: 35 });
  const report = compareSets({
    compare: [{ case: null, run: trialRun("A1", { usage: entries }) }],
    against: [],
    planted: {},
  });
  expect(report.cases[0]!.compare.median).toMatchObject({
    "startup.output": 100,
    "work.output": 600,
    "recovery.output": 35,
    "total.output": 735,
  });
});

test("escaped defects are the audit's final review's blocking findings, not every seat's", () => {
  const report = compareSets({
    compare: [
      {
        case: null,
        run: trialRun("A1", {
          audit: {
            reviews: [
              [{ severity: "major", title: "lost write", file: "src/a.ts" }],
              [{ severity: "blocker", title: "rejected by the synthesis", file: "src/b.ts" }],
              [{ id: "F1", severity: "major", title: "lost write", file: "src/a.ts" }],
            ],
            checks: null,
            interventions: 0,
            ended: null,
          },
        }),
      },
    ],
    against: [],
    planted: {},
  });
  expect(report.cases[0]!.compare.median.escapedDefects).toBe(1);
});
