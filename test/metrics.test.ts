// Progress is evidence, not activity. These are the facts a Run records about itself,
// and the one judgement it makes from them — which produces a sentence, never a stop.

import { expect, test } from "bun:test";
import {
  metricsOf,
  obstacleOf,
  repeatedFailure,
  type FailureLike,
  type Metric,
} from "../src/metrics";
import { usageLines, usageOf, withChildren } from "../src/usage-ledger-model";

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
): Metric =>
  line({
    kind: "usage",
    subject: agent,
    usage: {
      what: "request",
      key,
      at: "2026-09-11T10:00:00.000Z",
      agent,
      session: agent,
      parent: null,
      step: "triage",
      harness: "claude",
      model: null,
      effort: null,
      head: null,
      reasoning: null,
      ...tokens,
    },
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
    cacheCreation: 300,
    output: 10000,
    reasoning: null,
  });
  expect(usageLines(cost)).toContain(
    "tokens with child Runs: 4 requests: output 10000 (reasoning unavailable of it), cache read 100, cache creation 300, uncached input 10",
  );
});
