// One row of the evidence table per test. The point of each is what it refuses: an
// outcome nobody can close with a claim, and one that is not asked for evidence it never
// promised.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import {
  checkGaps,
  evidenceGaps,
  evidenceRoots,
  endsWithoutPatch,
  baseFailuresOf,
  baselinesOwed,
  flakesOf,
  isOutcome,
  KINDS,
  noCheckNamed,
  recheckOwed,
  refInside,
  renderEvidence,
  wholeRunsOwed,
  renderRecordedChecks,
  REQUESTABLE,
  reviewGaps,
} from "../src/outcome";
import type { Collected, Outcome } from "../src/outcome";
import type { Measurement } from "../src/measurement-model";
import type { Judgement } from "../src/measurement-verdict";
import type { Snapshot, Verification } from "../src/verify";
import type { VerifySpec } from "../src/verify-spec";
import type { YamlValue } from "../src/yaml";

const FINAL = { head_sha: "abc123", fingerprint: "tree-1" };
const EARLIER = { head_sha: "abc000", fingerprint: "tree-0" };

const TESTS: VerifySpec = { name: "tests", executable: "bun", argv: ["test"], cwd: "." };

function record(over: Partial<Verification> & { name: string }): Verification {
  return {
    id: `${over.name}-1`,
    run: "r1",
    executable: "/usr/bin/true",
    argv: [],
    cwd: "/repo",
    start: FINAL,
    end: FINAL,
    exit: 0,
    seconds: 1,
    tail: { stdout: "", stderr: "" },
    expect: "pass",
    result: "pass",
    at: "2026-09-11T10:00:00.000Z",
    by: "collie",
    ...over,
  };
}

function collected(over: Partial<Collected> = {}): Collected {
  return {
    verifications: [record({ name: "tests" })],
    final: FINAL,
    approved: [TESTS],
    outputs: new Map<string, YamlValue>(),
    reviewed: new Set<string>(),
    insideRun: () => true,
    tickets: [],
    ...over,
  };
}

/** The fields only a reviewer may give, as `workflows/review.md` defines them. */
const JUDGEMENTS = new Set([
  "scope_met",
  "behavior_preserved",
  "supported",
  "accurate",
  "compatible",
  "measurement_valid",
]);

/** A Run whose implementer and reviewer each wrote the fields that are theirs to write. */
const withOutput = (fields: Record<string, YamlValue>, over: Partial<Collected> = {}) => {
  const build: Record<string, YamlValue> = {};
  const review: Record<string, YamlValue> = {};
  for (const [key, value] of Rec.toEntries(fields)) {
    if (JUDGEMENTS.has(key)) review[key] = value;
    else build[key] = value;
  }
  return collected({
    outputs: new Map<string, YamlValue>([
      ["build", build],
      ["review", review],
    ]),
    reviewed: new Set(["review"]),
    ...over,
  });
};

/** The same Run with the implementer writing everything, including what is not its to say. */
const claimedByTheImplementer = (fields: Record<string, YamlValue>) =>
  collected({
    outputs: new Map<string, YamlValue>([
      ["build", fields],
      ["review", {}],
    ]),
    reviewed: new Set(["review"]),
  });

test("every kind is a kind, and nothing else is", () => {
  for (const kind of KINDS) expect(isOutcome(kind)).toBe(true);
  expect(isOutcome("feature ")).toBe(false);
  expect(isOutcome("chore")).toBe(false);
  expect(isOutcome("")).toBe(false);
});

test("an unclassified Run proves the approved set and is asked for nothing else", () => {
  expect(evidenceGaps("unspecified", collected())).toEqual([]);
  // Not a feature by default: no tickets are demanded of work nobody called a feature.
  expect(Arr.join(evidenceGaps("unspecified", collected()), " ")).not.toContain("ticket");
});

test("a Run with no check named is a gap its implementer closes by naming the checks", () => {
  const got = collected({ approved: [], verifications: [] });
  expect(evidenceGaps("unspecified", got)).toEqual([noCheckNamed]);
  expect(checkGaps("feature", got)).toContain(noCheckNamed);
  expect(noCheckNamed).toContain("collie run intent verification");
  for (const kind of ["investigation", "plan", "review"] as const)
    expect(evidenceGaps(kind, got)).not.toContain(noCheckNamed);
});

test("the approved set has to pass here, now, as its own command", () => {
  expect(evidenceGaps("unspecified", collected({ verifications: [] }))).toEqual([
    "tests was never run",
  ]);
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [record({ name: "tests", result: "fail" })] }),
    ),
  ).toEqual(["tests failed"]);
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [record({ name: "tests", result: "unstable" })] }),
    ),
  ).toEqual(["tests ran on a tree that moved under it"]);
  // Passed, but on a tree that is not this one: history, not evidence.
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [record({ name: "tests", end: EARLIER })] }),
    ),
  ).toEqual(["tests last passed on a different tree"]);
  // An agent's record that only shares the check's name is not the check.
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [record({ name: "tests", by: "agent" })] }),
    ),
  ).toEqual(["tests was never run"]);
});

test("an agent's pass of exactly a check's command on this tree counts, and its name alone does not", () => {
  const tests = { name: "tests", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  const agents = (name: string, argv: ReadonlyArray<string>) =>
    record({ name, by: "agent", executable: "/usr/bin/bun", argv: [...argv], cwd: "/repo" });
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [agents("mine", ["test"])], commands: [tests] }),
    ),
  ).toEqual([]);
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [agents("tests", ["test", "--other"])], commands: [tests] }),
    ),
  ).toEqual(["tests was never run"]);
});

test("the latest of Collie's results on this tree is the one that counts", () => {
  const passThenFail = [record({ name: "tests" }), record({ name: "tests", result: "fail" })];
  expect(evidenceGaps("unspecified", collected({ verifications: passThenFail }))).toEqual([
    "tests failed",
  ]);
  expect(
    evidenceGaps("unspecified", collected({ verifications: [...passThenFail].reverse() })),
  ).toEqual([]);
});

test("a whole check failing on the base too does not prove this Run's approved check", () => {
  const failing = [
    record({ name: "tests", result: "fail" }),
    record({ name: "tests", id: "base", pass: "baseline", result: "fail", start: BASE, end: BASE }),
  ];
  expect(evidenceGaps("unspecified", collected({ verifications: failing }))).toEqual([
    "tests failed",
  ]);
  const promised = {
    verifications: failing,
    tickets: [{ file: "01-picker.md", checks: ["tests"] }],
  };
  const built = { tickets_done: ["01"], scope_met: true };
  expect(evidenceGaps("feature", withOutput(built, promised))).toEqual([
    "tests failed",
    '01-picker.md promised check "tests", which has no passing verification on this tree',
  ]);
});

test("a feature names what it built and the review says the scope was met", () => {
  expect(evidenceGaps("feature", collected())).toEqual([
    "no ticket is reported built (tickets_done is empty)",
    "the review did not report scope_met: true for the agreed scope",
  ]);
  expect(
    evidenceGaps("feature", withOutput({ tickets_done: ["01 the picker"], scope_met: true })),
  ).toEqual([]);
  // `scope_met: false` is not "did not say": both are gaps, and neither passes.
  expect(
    evidenceGaps("feature", withOutput({ tickets_done: ["01"], scope_met: false })),
  ).toHaveLength(1);
  // What a ticket promised would prove it has to have passed here, by whoever ran it.
  const promised = [{ file: "01-picker.md", checks: ["tests", "typecheck"] }];
  const built = { tickets_done: ["01 the picker"], scope_met: true };
  expect(evidenceGaps("feature", withOutput(built, { tickets: promised }))).toEqual([
    '01-picker.md promised check "typecheck", which has no passing verification on this tree',
  ]);
  expect(
    evidenceGaps(
      "feature",
      withOutput(built, {
        tickets: promised,
        verifications: [record({ name: "tests" }), record({ name: "typecheck", by: "agent" })],
      }),
    ),
  ).toEqual([]);
  // A promise kept on an earlier tree is history, like any other verification.
  expect(
    evidenceGaps(
      "feature",
      withOutput(built, {
        tickets: promised,
        verifications: [record({ name: "tests" }), record({ name: "typecheck", end: EARLIER })],
      }),
    ),
  ).toHaveLength(1);
});

test("a gap is a check's only where a verification on this tree could close it", () => {
  // The reviewer's judgement and the implementer's Output are what they are; running a
  // check again moves neither, so a fix is never asked to.
  const got = withOutput(
    { tickets_done: [], scope_met: false },
    { verifications: [], tickets: [{ file: "01.md", checks: ["typecheck"] }] },
  );
  expect(checkGaps("feature", got)).toEqual([
    "tests was never run",
    '01.md promised check "typecheck", which has no passing verification on this tree',
  ]);
  expect(evidenceGaps("feature", got)).toHaveLength(4);
});

test("a bug is a fail then a pass, on two different trees", () => {
  const reproduced = record({
    name: "regression",
    expect: "fail",
    exit: 1,
    result: "pass",
    start: EARLIER,
    end: EARLIER,
  });
  const fixed = record({ name: "regression" });

  // Neither half on its own.
  expect(
    evidenceGaps(
      "bug",
      withOutput(
        { reproduced: "regression" },
        { verifications: [record({ name: "tests" }), fixed] },
      ),
    ),
  ).toEqual([
    "no regression verification recorded with --expect fail, so the bug was never reproduced",
  ]);
  expect(
    evidenceGaps(
      "bug",
      withOutput(
        { reproduced: "regression" },
        { verifications: [record({ name: "tests" }), reproduced] },
      ),
    ),
  ).toEqual(["regression does not pass on the current tree, so the fix is not proven"]);

  // Both halves on one tree is one tree: a test that fails and passes on the same
  // fingerprint proves the test is flaky, not that a fix happened between them.
  expect(
    evidenceGaps(
      "bug",
      withOutput(
        { reproduced: "regression" },
        {
          verifications: [
            record({ name: "tests" }),
            record({ name: "regression", expect: "fail", exit: 1, result: "pass" }),
            fixed,
          ],
        },
      ),
    ),
  ).toEqual([
    "the bug was only reproduced on the tree the fix is already on, so nothing shows it failing before the fix",
  ]);

  // Both halves, and the Output naming it.
  expect(
    evidenceGaps(
      "bug",
      withOutput(
        { reproduced: "regression" },
        { verifications: [record({ name: "tests" }), reproduced, fixed] },
      ),
    ),
  ).toEqual([]);
  expect(
    evidenceGaps(
      "bug",
      collected({ verifications: [record({ name: "tests" }), reproduced, fixed] }),
    ),
  ).toEqual(["the Output does not name the verification that reproduced the bug"]);
});

/** A bug Run's `regression` failing as expected on an earlier tree, then passing. */
const regressionPair = (before: Partial<Verification>, after: Partial<Verification>) =>
  withOutput(
    { reproduced: "regression" },
    {
      verifications: [
        record({ name: "tests" }),
        record({
          name: "regression",
          expect: "fail",
          exit: 1,
          start: EARLIER,
          end: EARLIER,
          ...before,
        }),
        record({ name: "regression", ...after }),
      ],
    },
  );

/** The same, each command as `[executable, ...argv]`. */
const reproducedThenFixed = (reproducedAs: string[], fixedAs: string[]) =>
  regressionPair(
    { executable: reproducedAs[0], argv: reproducedAs.slice(1) },
    { executable: fixedAs[0], argv: fixedAs.slice(1) },
  );

test("a bug reproduced by one command and fixed by another is a gap naming both", () => {
  expect(
    checkGaps(
      "bug",
      reproducedThenFixed(["/usr/bin/false"], ["/usr/bin/bun", "test", "test/x.test.ts"]),
    ),
  ).toEqual([
    'the bug was reproduced by "/usr/bin/false" in /repo but the fix is proven by "/usr/bin/bun test test/x.test.ts" in /repo: one command has to fail before the fix and pass after it',
  ]);
});

test("a bug reproduced and fixed by commands whose words differ names them differently", () => {
  const [gap] = checkGaps(
    "bug",
    reproducedThenFixed(["/bin/echo", "a b"], ["/bin/echo", "a", "b"]),
  );
  const [, reproducedBy, provenBy] = /reproduced by (.*) but the fix is proven by (.*): one/.exec(
    gap ?? "",
  )!;
  expect(reproducedBy).not.toBe(provenBy);
});

test("a bug whose one command failed before the fix and passes after it has no reproduction gap", () => {
  const command = ["/usr/bin/bun", "test", "test/x.test.ts"];
  expect(checkGaps("bug", reproducedThenFixed(command, command))).toEqual([]);
});

const SHIM = "/home/u/.local/share/mise/shims/bun";
const INSTALLED = "/home/u/.local/share/mise/installs/bun/1.4/bin/bun";

test("a bug reproduced through a shim and fixed through the real binary, both asked as bun, is proved", () => {
  const argv = ["test", "test/x.test.ts"];
  const pair = regressionPair(
    { asked: "bun", executable: SHIM, argv },
    { asked: "bun", executable: INSTALLED, argv },
  );
  expect(checkGaps("bug", pair)).toEqual([]);
});

test("a bug asked as bun both times but with other arguments names both resolved commands", () => {
  const pair = regressionPair(
    { asked: "bun", executable: SHIM, argv: ["test", "test/x.test.ts"] },
    { asked: "bun", executable: INSTALLED, argv: ["test", "test/y.test.ts"] },
  );
  expect(checkGaps("bug", pair)).toEqual([
    `the bug was reproduced by "bun (${SHIM}) test test/x.test.ts" in /repo but the fix is proven by "bun (${INSTALLED}) test test/y.test.ts" in /repo: one command has to fail before the fix and pass after it`,
  ]);
});

test("a bug whose records do not say how bun was asked compares the paths it resolved to", () => {
  const argv = ["test", "test/x.test.ts"];
  const pair = regressionPair({ executable: SHIM, argv }, { executable: INSTALLED, argv });
  expect(checkGaps("bug", pair)).toEqual([
    `the bug was reproduced by "${SHIM} test test/x.test.ts" in /repo but the fix is proven by "${INSTALLED} test test/x.test.ts" in /repo: one command has to fail before the fix and pass after it`,
  ]);
});

test("a check's command resolved to another bun is not run by a record of bun through a shim", () => {
  const tests = { name: "tests", executable: INSTALLED, argv: ["test"], cwd: "/repo" };
  const shimmed = record({
    name: "mine",
    by: "agent",
    asked: "bun",
    executable: SHIM,
    argv: ["test"],
  });
  expect(
    evidenceGaps("unspecified", collected({ verifications: [shimmed], commands: [tests] })),
  ).toEqual(["tests was never run"]);
});

test("a refactor needs the review to say behaviour survived; a green suite is not enough", () => {
  expect(evidenceGaps("refactor", collected())).toEqual([
    "the review did not report behavior_preserved: true",
  ]);
  expect(evidenceGaps("refactor", withOutput({ behavior_preserved: true }))).toEqual([]);
});

test("an investigation is a conclusion with references that hold it up, and may have no patch", () => {
  // No approved set is demanded: nothing was changed for a command to prove.
  expect(
    evidenceGaps("investigation", collected({ approved: [], verifications: [] })),
  ).not.toContain(noCheckNamed);

  const full = {
    conclusion: "The stall is in the prompt submission, not the harness.",
    evidence: ["plan/INVESTIGATION.md", "steps/build/build.json"],
    patch: false,
    supported: true,
  };
  expect(evidenceGaps("investigation", withOutput(full))).toEqual([]);
  expect(endsWithoutPatch("investigation", withOutput(full))).toBe(true);
  expect(endsWithoutPatch("feature", withOutput(full))).toBe(false);
  expect(endsWithoutPatch("investigation", withOutput({ ...full, patch: true }))).toBe(false);

  // A reference that points outside the Run proves nothing about it.
  expect(
    evidenceGaps(
      "investigation",
      withOutput(full, { insideRun: (ref) => pipe(ref, Str.startsWith("plan/")) }),
    ),
  ).toEqual(['evidence reference "steps/build/build.json" is outside this Run']);

  expect(
    evidenceGaps("investigation", withOutput({ conclusion: "", evidence: [], patch: false })),
  ).toEqual([
    "the investigation reports no conclusion",
    "the conclusion is supported by no evidence references",
    "the review did not report supported: true for the conclusion",
  ]);
});

test("a build of another Run's plan may cite that Run's files, and nothing beside them", () => {
  const state = "/home/mk/.local/state/collie";
  const roots = evidenceRoots(`${state}/runs/run-b`, "/work/app", `${state}/runs/run-a/plan`);

  expect(refInside(roots, `${state}/runs/run-a/handoffs/investigation.md`)).toBe(true);
  expect(refInside(roots, `${state}/runs/run-c/handoffs/investigation.md`)).toBe(false);
  expect(refInside(roots, "/home/mk/notes/investigation.md")).toBe(false);
  // A plan directory that is no Run's own lends nothing beside it.
  expect(
    refInside(
      evidenceRoots(`${state}/runs/run-b`, "/work/app", "/home/mk/tasks/picker"),
      "/home/mk/tasks/notes.md",
    ),
  ).toBe(false);
});

test("documentation is proved by running what it documents", () => {
  expect(evidenceGaps("docs", withOutput({ accurate: true }))).toEqual([
    "no documented command is named, so the instructions were never run",
  ]);
  // Named but never run: exactly the failure the row exists for.
  expect(
    evidenceGaps("docs", withOutput({ documented_commands: ["docs-quickstart"], accurate: true })),
  ).toEqual(['documented command "docs-quickstart" has no passing verification on this tree']);
  expect(
    evidenceGaps(
      "docs",
      withOutput(
        { documented_commands: ["docs-quickstart"], accurate: true },
        {
          verifications: [
            record({ name: "tests" }),
            // An agent may collect this one: it is the documented command, run as written.
            record({ name: "docs-quickstart", by: "agent" }),
          ],
        },
      ),
    ),
  ).toEqual([]);
});

test("a migration proves it can go back, by either name", () => {
  const up = record({ name: "migrate-up" });
  const down = record({ name: "migrate-down" });
  const rollback = record({ name: "rollback" });
  const base = [record({ name: "tests" })];

  expect(
    evidenceGaps("migration", withOutput({ compatible: true }, { verifications: [...base, up] })),
  ).toEqual(["migrate-down has no passing verification on this tree"]);
  expect(
    evidenceGaps(
      "migration",
      withOutput({ compatible: true }, { verifications: [...base, up, down] }),
    ),
  ).toEqual([]);
  expect(
    evidenceGaps(
      "migration",
      withOutput({ compatible: true }, { verifications: [...base, up, rollback] }),
    ),
  ).toEqual([]);
  expect(evidenceGaps("migration", collected({ verifications: [...base, up, down] }))).toEqual([
    "the review did not report compatible: true",
  ]);
});

test("a plan closes on tickets and a review on a summary, and neither runs the approved set", () => {
  const bare = collected({ approved: [], verifications: [] });
  expect(evidenceGaps("plan", bare)).toEqual(["the plan wrote no tickets"]);
  expect(
    evidenceGaps(
      "plan",
      withOutput({ issues_dir: "plan/issues" }, { approved: [], verifications: [] }),
    ),
  ).toEqual([]);
  expect(evidenceGaps("review", bare)).toEqual(["the review has no summary a human can read"]);
  expect(
    evidenceGaps(
      "review",
      withOutput({ summary: "It is fine." }, { approved: [], verifications: [] }),
    ),
  ).toEqual([]);
});

test("the rendered evidence says who collected each result, and which tree it was on", () => {
  expect(renderEvidence(collected({ verifications: [] }))).toBe("(nothing was verified)");
  const rendered = renderEvidence(
    collected({
      verifications: [
        record({ name: "tests" }),
        record({ name: "regression", expect: "fail", exit: 1, end: EARLIER }),
        record({ name: "lint", by: "agent" }),
      ],
    }),
  );
  expect(rendered).toContain("- tests: pass (by collie)");
  expect(rendered).toContain(
    "- regression: pass (by collie, expected to fail) (on an earlier tree)",
  );
  expect(rendered).toContain("- lint: pass (by agent)");
});

test("a reviewer is handed the recorded checks: result, who, tree, when, and the baseline", () => {
  expect(renderRecordedChecks(collected({ verifications: [] }))).toBe(
    "(nothing is recorded for this Run)",
  );
  const rendered = renderRecordedChecks(
    collected({
      verifications: [
        record({ name: "tests", result: "fail", at: "2026-09-11T09:00:00.000Z" }),
        record({ name: "tests", at: "2026-09-11T10:00:00.000Z" }),
        record({ name: "lint", end: EARLIER, at: "2026-09-11T08:00:00.000Z" }),
        record({ name: "typecheck", by: "agent" }),
        record({
          name: "tests",
          pass: "baseline",
          result: "fail",
          start: EARLIER,
          end: EARLIER,
          at: "2026-09-11T09:30:00.000Z",
        }),
      ],
    }),
  );
  expect(Str.split(rendered, "\n")).toEqual([
    "- tests: pass (by collie), on this tree, at 2026-09-11T10:00:00.000Z; never seen failing on an earlier tree",
    "- lint: pass (by collie), on an earlier tree, at 2026-09-11T08:00:00.000Z; never seen failing on an earlier tree",
    "- typecheck: pass (by agent), on this tree, at 2026-09-11T10:00:00.000Z; never seen failing on an earlier tree",
    "- tests (baseline, where this branch leaves the default branch, abc000): fail, at 2026-09-11T09:30:00.000Z",
  ]);
});

const BUN_TEST = { executable: "/usr/bin/bun", argv: ["test", "test/x.test.ts"] };

test("a check whose same command failed on an earlier tree is shown as seen failing", () => {
  const rendered = renderRecordedChecks(
    collected({
      verifications: [
        record({ name: "x", ...BUN_TEST, expect: "fail", exit: 1, end: EARLIER }),
        record({ name: "x", ...BUN_TEST }),
      ],
    }),
  );
  expect(rendered).toBe(
    "- x: pass (by collie), on this tree, at 2026-09-11T10:00:00.000Z; seen failing on an earlier tree",
  );
});

test.each([
  {
    why: "its only failing run was another command",
    before: [
      record({ name: "x", executable: "/usr/bin/false", exit: 1, result: "fail", end: EARLIER }),
    ],
  },
  { why: "it has no failing run", before: [record({ name: "x", ...BUN_TEST, end: EARLIER })] },
])("a check is shown as never seen failing where $why", ({ before }) => {
  const rendered = renderRecordedChecks(
    collected({ verifications: [...before, record({ name: "x", ...BUN_TEST })] }),
  );
  expect(rendered).toBe(
    "- x: pass (by collie), on this tree, at 2026-09-11T10:00:00.000Z; never seen failing on an earlier tree",
  );
});

test("a check asked as bun the same way, failing through a shim before, is shown as seen failing", () => {
  const argv = ["test", "test/x.test.ts"];
  const rendered = renderRecordedChecks(
    collected({
      verifications: [
        record({
          name: "x",
          asked: "bun",
          executable: SHIM,
          argv,
          exit: 1,
          result: "fail",
          end: EARLIER,
        }),
        record({ name: "x", asked: "bun", executable: INSTALLED, argv }),
      ],
    }),
  );
  expect(rendered).toBe(
    "- x: pass (by collie), on this tree, at 2026-09-11T10:00:00.000Z; seen failing on an earlier tree",
  );
});

test("a reviewer is told a check left to CI is proved by its job, and the job's state where there is a merge request", () => {
  const nuxi = { name: "nuxi", job: "nuxi-typecheck" };
  expect(renderRecordedChecks(collected({ verifications: [] }), [{ ...nuxi, state: null }])).toBe(
    "- nuxi: left to CI (job nuxi-typecheck), do not run it. left to CI: proved by nuxi-typecheck on the merge request's head",
  );
  const rendered = renderRecordedChecks(collected({ verifications: [record({ name: "tests" })] }), [
    { ...nuxi, state: "running" },
  ]);
  expect(Str.split(rendered, "\n")).toEqual([
    "- tests: pass (by collie), on this tree, at 2026-09-11T10:00:00.000Z; never seen failing on an earlier tree",
    "- nuxi: left to CI (job nuxi-typecheck), do not run it. left to CI: proved by nuxi-typecheck on the merge request's head; its job is running now",
  ]);
});

test("every kind has a rule, so a new one cannot be added without one", () => {
  // The bare shape: nothing verified, nothing claimed. Only the kinds that genuinely
  // require no evidence may come back empty.
  const empty = collected({ approved: [], verifications: [] });
  const silent: Outcome[] = [];
  for (const kind of KINDS) {
    if (evidenceGaps(kind, empty).length === 0) silent.push(kind);
  }
  expect(silent).toEqual([]);
});

test("a judgement only a reviewer can give is not accepted from the implementer's Output", () => {
  // Every one of these is defined in workflows/review.md as the reviewer's word. Read
  // from any Output, the agent that wrote the change could sign off its own work.
  expect(
    evidenceGaps("feature", claimedByTheImplementer({ tickets_done: ["01"], scope_met: true })),
  ).toEqual(["the review did not report scope_met: true for the agreed scope"]);
  expect(evidenceGaps("refactor", claimedByTheImplementer({ behavior_preserved: true }))).toEqual([
    "the review did not report behavior_preserved: true",
  ]);
  expect(
    evidenceGaps(
      "investigation",
      claimedByTheImplementer({
        conclusion: "It is the cache.",
        evidence: ["plan/a.md"],
        patch: false,
        supported: true,
      }),
    ),
  ).toEqual(["the review did not report supported: true for the conclusion"]);
  expect(
    evidenceGaps("docs", claimedByTheImplementer({ documented_commands: [], accurate: true })).at(
      -1,
    ),
  ).toBe("the review did not report accurate: true for the instructions");
  expect(evidenceGaps("migration", claimedByTheImplementer({ compatible: true })).at(-1)).toBe(
    "the review did not report compatible: true",
  );
});

test("a promised check is proved by a pass of its command under any name, and never by an expected failure", () => {
  const tests = { name: "tests", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  const agents = (over: Partial<Verification> = {}) =>
    record({ name: "mine", by: "agent", executable: "/usr/bin/bun", argv: ["test"], ...over });
  const gaps = (verifications: Verification[]) =>
    checkGaps(
      "feature",
      collected({
        verifications,
        commands: [tests],
        tickets: [{ file: "01-a.md", checks: ["tests"] }],
      }),
    );
  expect(gaps([agents()])).toEqual([]);
  const reproduced = agents({ expect: "fail", exit: 1 });
  expect(gaps([reproduced])).toEqual([
    "tests failed",
    '01-a.md promised check "tests", which has no passing verification on this tree',
  ]);
  expect(gaps([agents(), reproduced])).toHaveLength(2);
});

const searched = (name: string, over: Partial<Verification> = {}) =>
  record({ name, by: "agent", executable: "/usr/bin/rg", argv: ["foo", "src"], ...over });
const promising = (verifications: Verification[]) =>
  collected({
    verifications: [record({ name: "tests" }), ...verifications],
    tickets: [{ file: "01-a.md", checks: ["proves-a"] }],
  });

test("a promised check whose only pass is a text search is a gap", () => {
  expect(checkGaps("feature", promising([searched("proves-a")]))).toEqual([
    '01-a.md promised check "proves-a", whose only pass on this tree is a text search, which proves nothing',
  ]);
});

test.each([
  "grep -q foo src/x.ts",
  '"/usr/bin/grep" -q foo src/x.ts',
  "'rg' foo src",
  "g\\rep -q foo src/x.ts",
  'git "grep" foo',
  "gr\\\nep -q foo src/x.ts",
  '"gr\\\nep" -q foo src/x.ts',
  "\\\n grep -q foo src/x.ts",
])("a text search run as the shell script %p is still a text search", (script) => {
  const run = searched("proves-a", { executable: "/usr/bin/bash", argv: ["-c", script] });
  expect(checkGaps("feature", promising([run]))).toEqual([
    '01-a.md promised check "proves-a", whose only pass on this tree is a text search, which proves nothing',
  ]);
});

test("a documented command whose only pass is a text search is a gap", () => {
  const got = withOutput(
    { documented_commands: ["docs-quickstart"], accurate: true },
    { verifications: [record({ name: "tests" }), searched("docs-quickstart")] },
  );
  expect(checkGaps("docs", got)).toEqual([
    'documented command "docs-quickstart", whose only pass on this tree is a text search, which proves nothing',
  ]);
});

test("a migration step whose only pass is a text search is a gap", () => {
  const got = withOutput(
    { compatible: true },
    {
      verifications: [
        record({ name: "tests" }),
        record({ name: "migrate-up" }),
        searched("rollback"),
      ],
    },
  );
  expect(checkGaps("migration", got)).toEqual([
    "rollback, whose only pass on this tree is a text search, which proves nothing",
  ]);
});

test("a regression whose only pass is a text search does not prove the fix", () => {
  const got = withOutput(
    { reproduced: "regression" },
    {
      verifications: [
        record({ name: "tests" }),
        searched("regression", { expect: "fail", exit: 1, start: EARLIER, end: EARLIER }),
        searched("regression"),
      ],
    },
  );
  expect(checkGaps("bug", got)).toEqual([
    "regression, whose only pass on this tree is a text search, which proves nothing",
  ]);
});

test("a promised check that also passed as a test is not a gap, whichever ran last", () => {
  const tested = record({
    name: "proves-a",
    by: "agent",
    executable: "/usr/bin/bun",
    argv: ["test", "test/a.test.ts"],
  });
  expect(checkGaps("feature", promising([searched("proves-a"), tested]))).toEqual([]);
  expect(checkGaps("feature", promising([tested, searched("proves-a")]))).toEqual([]);
});

const QUICK = { file: "test/one.test.ts", name: "the quick one" };
const NESTED = { file: "test/two.test.ts", name: "outer > the nested one" };
/** Collie's gate run of `tests`, failing on `failed`, and a rerun of each of `reran`. */
const gateThenReruns = (
  failed: ReadonlyArray<typeof QUICK>,
  reran: ReadonlyArray<readonly [typeof QUICK, "pass" | "fail"]>,
) => [
  record({ name: "tests", pass: "gate", result: "fail", exit: 1, failed: [...failed] }),
  ...Arr.map(reran, ([test, result], at) =>
    record({
      name: "tests",
      id: `rerun-${at}`,
      pass: "rerun",
      executable: "/usr/bin/bun",
      argv: ["test", test.file, "-t", test.name],
      test,
      result,
      exit: result === "pass" ? 0 : 1,
      at: "2026-09-11T10:05:00.000Z",
    }),
  ),
];

test("a check whose failed tests all passed their rerun on this tree is not a gap, and each is a Flake", () => {
  const got = collected({
    verifications: gateThenReruns(
      [QUICK, NESTED],
      [
        [QUICK, "pass"],
        [NESTED, "pass"],
      ],
    ),
  });
  expect(evidenceGaps("unspecified", got)).toEqual([]);
  expect(flakesOf(got)).toEqual([
    { check: "tests", ...QUICK },
    { check: "tests", ...NESTED },
  ]);
  // A ticket that promised the check is not owed a pass the Flake never was.
  expect(
    checkGaps("feature", { ...got, tickets: [{ file: "01-a.md", checks: ["tests"] }] }),
  ).toEqual([]);
});

test("a check with a test still failing after its rerun is a gap naming that test", () => {
  const got = collected({
    verifications: gateThenReruns(
      [QUICK, NESTED],
      [
        [QUICK, "pass"],
        [NESTED, "fail"],
      ],
    ),
  });
  expect(evidenceGaps("unspecified", got)).toEqual([
    "tests failed: outer > the nested one (test/two.test.ts)",
  ]);
  // A Flake is named whether or not its check is left failing on another test.
  expect(flakesOf(got)).toEqual([{ check: "tests", ...QUICK }]);
  // A rerun on another tree says nothing about this one.
  const moved = Arr.map(gateThenReruns([QUICK], [[QUICK, "pass"]]), (one, at) =>
    at === 0 ? one : { ...one, end: EARLIER },
  );
  expect(evidenceGaps("unspecified", collected({ verifications: moved }))).toEqual([
    "tests failed: the quick one (test/one.test.ts)",
  ]);
});

test("a passing rerun record never counts as the check's pass", () => {
  const rerun = gateThenReruns([], [[QUICK, "pass"]]).slice(1);
  const tests = { name: "tests", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  for (const commands of [undefined, [tests]]) {
    expect(evidenceGaps("unspecified", collected({ verifications: rerun, commands }))).toEqual([
      "tests was never run",
    ]);
    expect(
      evidenceGaps(
        "unspecified",
        collected({
          verifications: [record({ ...tests, result: "fail", exit: 1, argv: ["test"] }), ...rerun],
          commands,
        }),
      ),
    ).toEqual(["tests failed"]);
  }
  expect(renderEvidence({ verifications: rerun, final: FINAL })).toBe("(nothing was verified)");
});

const BASE = { head_sha: "base00", fingerprint: "tree-b" };
/** One test run alone where this branch leaves the default branch: `fail` only where bun said it failed. */
const atBase = (test: typeof QUICK, result: "pass" | "fail") =>
  record({
    name: "tests",
    id: `base-${test.name}`,
    pass: "baseline",
    executable: "/usr/bin/bun",
    argv: ["test", test.file, "-t", test.name],
    test,
    result,
    exit: result === "pass" ? 0 : 1,
    start: BASE,
    end: BASE,
    at: "2026-09-11T10:06:00.000Z",
  });

test("still-failing tests that all failed at the base are not a gap, and each is named with the base", () => {
  const got = collected({
    verifications: [
      ...gateThenReruns(
        [QUICK, NESTED],
        [
          [QUICK, "pass"],
          [NESTED, "fail"],
        ],
      ),
      atBase(NESTED, "fail"),
    ],
  });
  expect(evidenceGaps("unspecified", got)).toEqual([]);
  expect(
    checkGaps("feature", { ...got, tickets: [{ file: "01-a.md", checks: ["tests"] }] }),
  ).toEqual([]);
  expect(baseFailuresOf(got)).toEqual([{ check: "tests", ...NESTED, at: "base00" }]);
  expect(flakesOf(got)).toEqual([{ check: "tests", ...QUICK }]);
  // Neither a base failure nor a Flake is the check's pass.
  expect(renderEvidence(got)).toBe("- tests: fail (by collie)");
});

test("a still-failing test that passed at the base, or that the base does not have, is a gap naming only it", () => {
  const got = collected({
    verifications: [
      ...gateThenReruns(
        [QUICK, NESTED],
        [
          [QUICK, "fail"],
          [NESTED, "fail"],
        ],
      ),
      atBase(QUICK, "fail"),
      atBase(NESTED, "pass"),
    ],
  });
  expect(evidenceGaps("unspecified", got)).toEqual([
    "tests failed: outer > the nested one (test/two.test.ts)",
  ]);
  expect(flakesOf(got)).toEqual([]);
});

test("a test's failure at the base in another directory neither settles the check nor answers its baseline", () => {
  const got = collected({
    verifications: [
      ...gateThenReruns([NESTED], [[NESTED, "fail"]]),
      { ...atBase(NESTED, "fail"), cwd: "/repo/package-a" },
    ],
  });
  expect(evidenceGaps("unspecified", got)).toEqual([
    "tests failed: outer > the nested one (test/two.test.ts)",
  ]);
  expect(baselinesOwed(got)).toEqual([{ check: "tests", test: NESTED }]);
});

test("a whole run is owed by a check that failed naming no tests, or has no run of its command on this tree", () => {
  const tests = { name: "tests", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  const regranted = [{ ...tests, argv: ["test", "--regranted"] }];
  const failedWhole = [record({ ...tests, result: "fail", exit: 1 })];
  expect(wholeRunsOwed(collected({ verifications: failedWhole, commands: [tests] }))).toEqual([
    "tests",
  ]);
  expect(wholeRunsOwed(collected({ verifications: failedWhole, commands: regranted }))).toEqual([
    "tests",
  ]);
  expect(
    wholeRunsOwed(collected({ verifications: [record({ ...tests })], commands: [tests] })),
  ).toEqual([]);
  expect(wholeRunsOwed(collected({ verifications: gateThenReruns([QUICK], []) }))).toEqual([]);
});

test("a recheck is owed once on a tree, by a check that failed there naming no tests or has no run of its command there", () => {
  const tests = { name: "tests", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  const failedWhole = record({ ...tests, result: "fail", exit: 1 });
  const rechecked = { ...failedWhole, id: "tests-2", pass: "recheck" as const };
  expect(recheckOwed(collected({ verifications: [failedWhole], commands: [tests] }))).toEqual([
    "tests",
  ]);
  expect(
    recheckOwed(collected({ verifications: [failedWhole, rechecked], commands: [tests] })),
  ).toEqual([]);
  // A recheck on an earlier tree, or of a command since re-granted, does not count here.
  const earlier = { ...rechecked, start: EARLIER, end: EARLIER };
  expect(
    recheckOwed(collected({ verifications: [failedWhole, earlier], commands: [tests] })),
  ).toEqual(["tests"]);
  const regranted = [{ ...tests, argv: ["test", "--regranted"] }];
  expect(
    recheckOwed(collected({ verifications: [failedWhole, rechecked], commands: regranted })),
  ).toEqual(["tests"]);
  expect(recheckOwed(collected({ verifications: gateThenReruns([QUICK], []) }))).toEqual([]);
});

const MERGE_BASE = "merge-base-2";
/** The base tree: the merge base with the harness applied, as Git names its content. */
const BASE_TREE = { head_sha: "base-head", fingerprint: "clean", content: "content-base" };

type Verdict = Judgement["verdict"];

function measured(over: {
  readonly id?: string;
  readonly pass?: string;
  readonly candidate?: Snapshot;
  readonly base?: { readonly commit: string; readonly content: string };
  readonly primary?: Verdict;
  readonly guardrail?: { readonly verdict: Verdict; readonly held: boolean };
  readonly result?: Measurement["result"];
}): Measurement {
  const judged = (metric: string, verdict: Verdict, held: boolean): Judgement => ({
    metric,
    ratio: 0.8,
    interval: [0.75, 0.85],
    verdict,
    held,
  });
  const guardrail = over.guardrail ?? { verdict: "no-change", held: true };
  const tree = { cwd: "/repo", lockfiles: {} };
  return {
    id: over.id ?? "r1-measurement-1",
    run: "r1",
    pass: over.pass ?? "final",
    machine: "m1",
    plan: {
      harness: { commits: ["h1"], paths: ["bench"] },
      prepare: null,
      commands: [{ name: "bench", executable: "sh", argv: ["bench/run.sh"] }],
      metrics: [
        { name: "bench.wall_ms", direction: "lower", role: "primary" },
        { name: "bench.peak_kb", direction: "lower", role: "guardrail" },
      ],
      warmup: 1,
      samples: 10,
      limit: 600,
      threshold: 5,
      tolerance: 2,
    },
    plan_digest: "d1",
    plan_reason: null,
    base: {
      ...tree,
      ...BASE_TREE,
      commit: over.base?.commit ?? MERGE_BASE,
      content: over.base?.content ?? BASE_TREE.content,
    },
    candidate: { ...tree, ...(over.candidate ?? FINAL), content: "content-candidate" },
    environment: {},
    waited: { memory: false, machine: [] },
    prepare: [],
    samples: [],
    result: over.result ?? {
      _tag: "Judged",
      verdicts: [
        judged("bench.wall_ms", over.primary ?? "gain", true),
        judged("bench.peak_kb", guardrail.verdict, guardrail.held),
      ],
    },
    started: "2026-10-28T10:00:00.000Z",
    at: "2026-10-28T10:05:00.000Z",
  };
}

/** A performance Run with every piece of its proof in place, each of which a test takes away. */
const performing = (
  over: {
    readonly measurements?: ReadonlyArray<Measurement>;
    readonly fields?: Record<string, YamlValue>;
    /** The tree the review was of; null where none is recorded for it. */
    readonly reviewedAt?: Snapshot | null;
  } & Partial<Collected> = {},
) => {
  const { measurements, fields, reviewedAt = FINAL, ...rest } = over;
  return withOutput(fields ?? { behavior_preserved: true, measurement_valid: true }, {
    measurements: measurements ?? [measured({})],
    mergeBase: MERGE_BASE,
    content: "content-candidate",
    reviewedOn: new Map(reviewedAt === null ? [] : [["review", reviewedAt]]),
    ...rest,
  });
};

test("performance closes on a final gain on this tree against the merge base, held guardrails, its checks and a review of this tree", () => {
  expect(evidenceGaps("performance", performing())).toEqual([]);
  expect(REQUESTABLE).not.toContain("performance");
});

test("each piece of a performance Run's proof, taken away alone, is a gap naming it", () => {
  const alone = (got: Collected) => {
    const gaps = evidenceGaps("performance", got);
    expect(gaps).toHaveLength(1);
    return gaps[0];
  };
  const cycleGain = measured({ pass: "cycle 1" });
  expect(alone(performing({ measurements: [cycleGain] }))).toContain("no `final` Measurement");
  expect(alone(performing({ measurements: [measured({ candidate: EARLIER })] }))).toContain(
    "on an earlier tree",
  );
  const elsewhere = alone(
    performing({ measurements: [measured({ base: { commit: "merge-base-1", content: "c" } })] }),
  );
  expect(elsewhere).toContain("merge-base-1");
  expect(elsewhere).toContain(MERGE_BASE);
  expect(alone(performing({ measurements: [measured({ primary: "no-change" })] }))).toContain(
    "bench.wall_ms no-change",
  );
  expect(alone(performing({ measurements: [measured({ primary: "inconclusive" })] }))).toContain(
    "bench.wall_ms inconclusive",
  );
  expect(
    alone(
      performing({
        measurements: [measured({ guardrail: { verdict: "regression", held: false } })],
      }),
    ),
  ).toContain("guardrail bench.peak_kb");
  // Within tolerance on its worse bound, and still not shown safe.
  expect(
    alone(
      performing({
        measurements: [measured({ guardrail: { verdict: "inconclusive", held: true } })],
      }),
    ),
  ).toContain("guardrail bench.peak_kb");
  expect(alone(performing({ verifications: [] }))).toBe("tests was never run");
  expect(alone(performing({ fields: { measurement_valid: true } }))).toContain(
    "behavior_preserved",
  );
  expect(
    alone(
      performing({
        outputs: new Map<string, YamlValue>([
          ["build", { measurement_valid: true }],
          ["review", { behavior_preserved: true }],
        ]),
      }),
    ),
  ).toContain("measurement_valid");
  // Of an earlier tree, or of none recorded: each verdict is a gap of its own.
  for (const reviewedAt of [EARLIER, null]) {
    const gaps = evidenceGaps("performance", performing({ reviewedAt }));
    expect(gaps).toEqual([
      expect.stringContaining("behavior_preserved"),
      expect.stringContaining("measurement_valid"),
    ]);
    for (const gap of gaps) expect(gap).toContain("not of this tree");
  }
  expect(
    alone(
      performing({
        measurements: [
          measured({
            result: { _tag: "TimedOut", tree: "base", stage: "sample", command: "bench" },
          }),
        ],
      }),
    ),
  ).toContain("no verdict");
});

test("a later final Measurement on this tree against the merge base is the one that counts", () => {
  const before = measured({ id: "m1", candidate: EARLIER });
  const now = measured({ id: "m2" });
  expect(evidenceGaps("performance", performing({ measurements: [before, now] }))).toEqual([]);
  expect(
    evidenceGaps(
      "performance",
      performing({ measurements: [now, measured({ id: "m3", primary: "no-change" })] }),
    ),
  ).toEqual([expect.stringContaining("m3")]);
});

test("a performance gap is a fresh review's to close only where it is a reviewer's verdict", () => {
  const unmeasured = performing({ measurements: [] });
  expect(checkGaps("performance", unmeasured)).toEqual([]);
  expect(reviewGaps("performance", unmeasured)).toEqual([]);
  expect(reviewGaps("performance", performing({ reviewedAt: EARLIER }))).toHaveLength(2);
  expect(checkGaps("performance", performing({ verifications: [] }))).toEqual([
    "tests was never run",
  ]);
});

test("a performance Run back at its latest base tree ends without a patch, read from the trees and not its Output", () => {
  const cycleGain = measured({
    id: "m1",
    pass: "cycle 1",
    base: { commit: "mb-1", content: "c1" },
  });
  const reverted = measured({
    id: "m2",
    pass: "cycle 2",
    primary: "no-change",
    base: { commit: "mb-1", content: "c2" },
  });
  const back = (content: string, fields: Record<string, YamlValue> = {}) =>
    performing({
      measurements: [cycleGain, reverted],
      content,
      final: { head_sha: "reset", fingerprint: BASE_TREE.fingerprint },
      fields,
    });
  expect(endsWithoutPatch("performance", back("c2"))).toBe(true);
  // An earlier base tree is not where the Run stands now.
  expect(endsWithoutPatch("performance", back("c1"))).toBe(false);
  expect(endsWithoutPatch("performance", back("c3", { patch: false }))).toBe(false);
  // Uncommitted changes on the base's content are a change.
  expect(
    endsWithoutPatch(
      "performance",
      performing({
        measurements: [cycleGain, reverted],
        content: "c2",
        final: { head_sha: "reset", fingerprint: "dirty" },
      }),
    ),
  ).toBe(false);
  expect(endsWithoutPatch("performance", performing({ measurements: [], content: "c2" }))).toBe(
    false,
  );
});

test("the evidence a merge request is written from names the latest final Measurement and its verdicts", () => {
  const rendered = renderEvidence({
    verifications: [record({ name: "tests" })],
    final: FINAL,
    measurements: [
      measured({ id: "m1", pass: "cycle 1", primary: "regression" }),
      measured({ id: "m2" }),
    ],
  });
  expect(rendered).toContain("- tests: pass");
  expect(rendered).toContain("final Measurement m2: bench.wall_ms gain (ratio 0.800)");
  expect(rendered).not.toContain("m1");
  expect(
    renderEvidence({ verifications: [], final: FINAL, measurements: [measured({ id: "m3" })] }),
  ).toBe(
    "- final Measurement m3: bench.wall_ms gain (ratio 0.800), bench.peak_kb no-change (ratio 0.800)",
  );
});
