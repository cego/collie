// One row of the evidence table per test. The point of each is what it refuses: an
// outcome nobody can close with a claim, and one that is not asked for evidence it never
// promised.

import { expect, test } from "bun:test";
import {
  evidenceGaps,
  endsWithoutPatch,
  isOutcome,
  KINDS,
  nothingApproved,
  renderEvidence,
} from "../src/outcome";
import type { Collected, Outcome } from "../src/outcome";
import type { Verification } from "../src/verify";
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
]);

/** A Run whose implementer and reviewer each wrote the fields that are theirs to write. */
const withOutput = (fields: Record<string, YamlValue>, over: Partial<Collected> = {}) => {
  const build: Record<string, YamlValue> = {};
  const review: Record<string, YamlValue> = {};
  for (const [key, value] of Object.entries(fields)) {
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
  expect(evidenceGaps("unspecified", collected()).join(" ")).not.toContain("ticket");
});

test("a Run with nothing approved is told so and how to repair it, rather than passing on an empty set", () => {
  const gaps = evidenceGaps("unspecified", collected({ approved: [], verifications: [] }));
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toContain("collie run intent verification");
  expect(gaps[0]).toContain(".herdr/verify.json");
  expect(gaps[0]).toContain("only when it starts");
});

test("the approved set has to pass here, now, and by Collie", () => {
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
  // An agent may run anything; only Collie's own run of an approved spec closes this.
  expect(
    evidenceGaps(
      "unspecified",
      collected({ verifications: [record({ name: "tests", by: "agent" })] }),
    ),
  ).toEqual(["tests last passed on a different tree"]);
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
  ).not.toContain(nothingApproved());

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
      withOutput(full, { insideRun: (ref) => ref.startsWith("plan/") }),
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
