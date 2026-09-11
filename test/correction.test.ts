// Every gate on an automatic correction is somebody being deferred to, so the matrix is
// the test: each one flips the answer on its own, and none of them can be satisfied by
// any of the others.

import { expect, test } from "bun:test";
import {
  alignment,
  alreadyStood,
  correctionText,
  correctionsSent,
  decideCorrections,
  pendingEvaluation,
  shouldStand,
  type CorrectionContext,
  type DriftLine,
  type ElectionLine,
  EXTRA_PASSES,
  staleSince,
} from "../src/drift";
import { DEFAULT_AUTHORITY, seedIntent, type Authority, type Intent } from "../src/intent";
import type { DriftReport } from "../src/evaluator";

const report = (over: Partial<DriftReport> = {}): DriftReport => ({
  id: "d1",
  at: "2026-09-09T10:00:00Z",
  run: "r1",
  intent_version: 1,
  constraint: "c1",
  kind: "rule",
  severity: "warn",
  evidence: [{ kind: "diff", path: "docs/using.md" }],
  evidence_truncated: false,
  resolution: "open",
  ...over,
});

function intentWith(authority: Partial<Authority> = {}): Intent {
  return {
    ...seedIntent("r1", {
      constraints: [
        { id: "c1", kind: "rule", text: "stay inside src/", severity: "warn", source: "human" },
      ],
    }),
    authority: { ...DEFAULT_AUTHORITY, auto_correct: true, ...authority },
  };
}

const ctx = (over: Partial<CorrectionContext> = {}): CorrectionContext => ({
  overridden: false,
  attributable: true,
  held: false,
  sent: {},
  inFlight: new Set(),
  nowProven: false,
  ...over,
});

test("without the grant, nothing is corrected however bad it looks", () => {
  const ungranted = { ...intentWith(), authority: DEFAULT_AUTHORITY };
  expect(decideCorrections(ungranted, [report({ severity: "block" })], ctx())).toEqual([]);
  expect(decideCorrections(intentWith(), [report()], ctx())).toHaveLength(1);
});

test("each gate refuses on its own, and none of them substitutes for another", () => {
  const open = [report()];
  const intent = intentWith();

  // Somebody is at that keyboard.
  expect(decideCorrections(intent, open, ctx({ overridden: true }))).toEqual([]);
  // Somebody held the Run.
  expect(decideCorrections(intent, open, ctx({ held: true }))).toEqual([]);
  // Something about this constraint is already in the air.
  expect(decideCorrections(intent, open, ctx({ inFlight: new Set(["c1"]) }))).toEqual([]);
  // The bound is spent.
  expect(decideCorrections(intent, open, ctx({ sent: { c1: 2 } }))).toEqual([]);
  expect(decideCorrections(intent, open, ctx({ sent: { c1: 1 } }))).toHaveLength(1);
  // A report about an Intent that has since moved is about a Run that wanted something
  // else, and correcting towards it would be correcting towards the old thing.
  expect(decideCorrections(intent, [report({ intent_version: 0 })], ctx())).toEqual([]);
});

test("a harness that cannot tell Collie's own text from a human's needs to be told nobody else is steering", () => {
  const open = [report()];
  // No attribution: Collie cannot know whether it is taking turns with a person.
  expect(decideCorrections(intentWith(), open, ctx({ attributable: false }))).toEqual([]);
  expect(
    decideCorrections(intentWith({ exclusive_steering: true }), open, ctx({ attributable: false })),
  ).toHaveLength(1);
});

test("a blocking report may go now, but only where that was granted and proven", () => {
  const blocking = [report({ severity: "block" })];
  expect(decideCorrections(intentWith(), blocking, ctx())[0]?.mode).toBe("boundary");
  // Granted but never shown to work on this harness: still a boundary delivery.
  expect(decideCorrections(intentWith({ now_allowed: true }), blocking, ctx())[0]?.mode).toBe(
    "boundary",
  );
  expect(
    decideCorrections(intentWith({ now_allowed: true }), blocking, ctx({ nowProven: true }))[0]
      ?.mode,
  ).toBe("now");
  // A warning is never urgent, however much authority there is.
  expect(
    decideCorrections(intentWith({ now_allowed: true }), [report()], ctx({ nowProven: true }))[0]
      ?.mode,
  ).toBe("boundary");
});

test("the correction says what to do, and what to do instead of choosing", () => {
  const text = correctionText(
    "d-1",
    {
      id: "c1",
      kind: "rule",
      text: "stay inside src/",
      severity: "block",
      source: "human",
      since: 1,
    },
    report(),
  );
  expect(text).toContain("Steering correction d-1 for constraint c1");
  expect(text).toContain("stay inside src/");
  expect(text).toContain("docs/using.md");
  // The sentence that matters: an agent told only to obey would pick silently.
  expect(text).toContain("say so");
  expect(text).toContain("in your Output instead of choosing");
});

test("what has been sent is counted from the ledger, per constraint", () => {
  expect(
    correctionsSent([
      { cause: { kind: "correction", ref: "c1" } },
      { cause: { kind: "correction", ref: "c1" } },
      { cause: { kind: "correction", ref: "c2" } },
      { cause: { kind: "step", ref: "build" } },
    ]),
  ).toEqual({ c1: 2, c2: 1 });
});

test("aligned: true is the strong claim, and every way of not knowing is unverified", () => {
  const intent = seedIntent("r1", {
    goal: "add a picker",
    constraints: [
      { id: "c1", kind: "semantic", text: "keep it readable", severity: "warn", source: "human" },
    ],
  });
  const judged = { semantic: true, truncated: false, goal: true };

  expect(alignment(intent, [], judged).aligned).toBe("true");

  // Every way of not knowing, one at a time.
  expect(alignment(null, [], judged)).toMatchObject({ aligned: "unverified" });
  expect(alignment(intent, [], { ...judged, semantic: false })).toMatchObject({
    aligned: "unverified",
    why: expect.stringContaining("never judged"),
  });
  expect(alignment(intent, [], { ...judged, truncated: true })).toMatchObject({
    aligned: "unverified",
    why: expect.stringContaining("truncated"),
  });
  expect(alignment(intent, [], { ...judged, goal: false })).toMatchObject({
    aligned: "unverified",
    why: expect.stringContaining("goal"),
  });

  const skipped: DriftLine[] = [
    { kind: "skipped", at: "t", run: "r1", reason: "budget_exhausted" },
  ];
  expect(alignment(intent, skipped, judged)).toMatchObject({
    aligned: "unverified",
    why: expect.stringContaining("budget_exhausted"),
  });

  // An open warning is not a failure, but it is not alignment either.
  expect(alignment(intent, [report()], judged)).toMatchObject({ aligned: "unverified" });
  // An open blocking report is the other strong claim.
  expect(alignment(intent, [report({ severity: "block" })], judged)).toMatchObject({
    aligned: "false",
  });
  // A correction that was sent settles nothing on its own: the report is still open.
  expect(
    alignment(intent, [report({ severity: "block", resolution: "correction_submitted" })], judged),
  ).toMatchObject({ aligned: "false" });
});

test("a Run with no goal and no semantic constraints can still be aligned", () => {
  const rulesOnly = seedIntent("r1", {
    constraints: [
      { id: "c1", kind: "rule", text: "rule:branch_is:main", severity: "block", source: "human" },
    ],
  });
  expect(
    alignment(rulesOnly, [], { semantic: false, truncated: false, goal: false }),
  ).toMatchObject({ aligned: "true" });
});

test("a Driver says it is standing once per pending, not once per boundary", () => {
  const pending: ElectionLine[] = [{ kind: "pending", since: "t1", runs: ["r1"] }];
  // Nothing pending: every election is its own event, and every candidate is written down.
  expect(alreadyStood([], "r1")).toBe(false);
  expect(alreadyStood(pending, "r1")).toBe(false);
  const stood: ElectionLine[] = [
    ...pending,
    { kind: "candidate", at: "t2", by: "boundary", run: "r1" },
  ];
  expect(alreadyStood(stood, "r1")).toBe(true);
  // Somebody else's line is not this Run's, and one from before the pending is not
  // about it.
  expect(alreadyStood(stood, "r2")).toBe(false);
  expect(
    alreadyStood([{ kind: "candidate", at: "t0", by: "boundary", run: "r1" }, ...pending], "r1"),
  ).toBe(false);
  // Standing again is still the wake rule working: only the journal line is suppressed.
  expect(shouldStand(stood, false)).toBe(true);
});

test("a pending evaluation is cleared by a Judgement that covers it, and by nothing less", () => {
  const owed: ElectionLine[] = [{ kind: "pending", since: "t1", runs: ["r1", "r2"] }];
  // A Judgement about only one of the Runs it named answers nothing the mark asked.
  const partial: ElectionLine[] = [
    ...owed,
    { kind: "evaluated", at: "t2", by: "r3", runs: ["r1"] },
  ];
  expect(pendingEvaluation(partial)).toMatchObject({ since: "t1" });
  // One that covers every named Run is the evaluation the Herd owed: cleared, so no
  // Driver stands — or pays — for it again.
  const covered: ElectionLine[] = [
    ...owed,
    { kind: "evaluated", at: "t2", by: "r3", runs: ["r1", "r2", "r3"] },
  ];
  expect(pendingEvaluation(covered)).toBeNull();
  expect(shouldStand(covered, false)).toBe(false);
  // An evaluation from before the mark is not an answer to it.
  const earlier: ElectionLine[] = [
    { kind: "evaluated", at: "t0", by: "r3", runs: ["r1", "r2"] },
    ...owed,
  ];
  expect(pendingEvaluation(earlier)).toMatchObject({ since: "t1" });
});

test("a snapshot is stale only when a loser wrote dirty after it was taken", () => {
  const lines: ElectionLine[] = [
    { kind: "dirty", at: "2026-01-01T00:00:01.000Z", by: "boundary", run: "r2" },
    { kind: "candidate", at: "2026-01-01T00:00:03.000Z", by: "boundary", run: "r3" },
  ];
  expect(staleSince(lines, "2026-01-01T00:00:02.000Z")).toBe(false);
  expect(staleSince(lines, "2026-01-01T00:00:00.000Z")).toBe(true);
  // The bound is a rule, not a detail: one call, then at most two more.
  expect(EXTRA_PASSES).toBe(2);
});

test("the wake rule makes every Driver a candidate, not only the ones with siblings", () => {
  const nobody: ElectionLine[] = [];
  // No siblings and nothing pending: this Driver has no cross-run question to ask.
  expect(shouldStand(nobody, false)).toBe(false);
  expect(shouldStand(nobody, true)).toBe(true);

  // A pending evaluation is everybody's: without this it would wait for a Driver with a
  // parent, which may never run again.
  const stuck: ElectionLine[] = [{ kind: "pending", since: "t1", runs: ["r1"] }];
  expect(shouldStand(stuck, false)).toBe(true);
  expect(pendingEvaluation(stuck)).toMatchObject({ runs: ["r1"] });
  expect(pendingEvaluation(nobody)).toBeNull();
});
