import { expect, test } from "bun:test";
import { formatFindings, parseReviewOutput, splitDisputed, unionFindings } from "../src/output";

const ok = (text: string) => {
  const r = parseReviewOutput(text, "review.json");
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const err = (text: string) => {
  const r = parseReviewOutput(text, "review.json");
  return r.ok ? "(no error)" : r.error;
};

test("a clean verdict needs no findings", () => {
  expect(ok(`{"verdict": "clean"}`)).toEqual({ verdict: "clean", findings: [], disputed: [] });
});

test("findings keep file, line, severity, title and detail", () => {
  expect(
    ok(`{"verdict": "findings", "findings": [{"file": "a.ts", "line": 3, "severity": "major", "title": "leak", "detail": "d"}]}`),
  ).toEqual({
    verdict: "findings",
    findings: [{ file: "a.ts", line: 3, severity: "major", title: "leak", detail: "d" }],
    disputed: [],
  });
});

test("the schema rejects what a gate could not read", () => {
  expect(err("nope")).toContain("review.json: not valid JSON");
  expect(err("[]")).toBe("review.json: expected a JSON object");
  expect(err(`{"verdict": "ok"}`)).toBe('review.json: verdict must be "clean" or "findings", got "ok"');
  expect(err(`{"verdict": "findings", "findings": []}`)).toBe(
    'review.json: verdict "findings" with an empty findings list',
  );
  expect(err(`{"verdict": "clean", "findings": {}}`)).toBe("review.json: findings: expected an array");
  expect(err(`{"verdict": "clean", "findings": [{"severity": "major"}]}`)).toBe(
    "review.json: findings[0]: title is required",
  );
  expect(err(`{"verdict": "clean", "findings": [{"title": "t"}]}`)).toBe(
    "review.json: findings[0]: severity is required",
  );
  expect(err(`{"verdict": "clean", "disputed": [{"title": "t"}]}`)).toBe(
    "review.json: disputed[0]: severity is required",
  );
});

test("fan-in unions findings and drops duplicates", () => {
  const a = ok(`{"verdict": "findings", "findings": [{"file": "a.ts", "line": 1, "severity": "major", "title": "x"}]}`);
  const b = ok(
    `{"verdict": "findings", "findings": [{"file": "a.ts", "line": 1, "severity": "minor", "title": "x"}, {"file": "b.ts", "severity": "blocker", "title": "y"}]}`,
  );

  expect(unionFindings([a, b]).map((f) => f.title)).toEqual(["x", "y"]);
});

test("findings format as a readable list for the fix prompt", () => {
  expect(formatFindings([])).toBe("(none)");
  expect(
    formatFindings([
      { file: "a.ts", line: 3, severity: "major", title: "leak", detail: "closes late" },
      { severity: "minor", title: "typo" },
    ]),
  ).toBe("- [major] leak (a.ts:3)\n  closes late\n- [minor] typo");
});

test("a rebuttal is kept, and it prints under the finding it answers", () => {
  expect(
    ok(`{"verdict": "findings", "findings": [{"severity": "major", "title": "x", "rebuttal": "the reason misreads the spec"}]}`)
      .findings[0],
  ).toEqual({ severity: "major", title: "x", rebuttal: "the reason misreads the spec" });

  expect(
    formatFindings([{ file: "a.ts", severity: "major", title: "leak", detail: "d", rebuttal: "you tested the wrong path" }]),
  ).toBe("- [major] leak (a.ts)\n  d\n  answers your dispute: you tested the wrong path");
});

test("a finding the implementer already disputed is settled, unless a reviewer answers it", () => {
  const disputed = [
    { file: "cli.js", line: 6, severity: "minor", title: "--version wins everywhere", detail: "the spec says so" },
    { file: "pkg.json", severity: "minor", title: "no engines field", detail: "packaging is out of scope" },
  ];
  const raised = [
    // Same finding, re-raised verbatim except for a line that moved.
    { file: "cli.js", line: 9, severity: "minor", title: "--version wins everywhere" },
    { file: "pkg.json", severity: "minor", title: "no engines field", rebuttal: "node:test needs >=18" },
    { file: "cli.js", severity: "major", title: "brand new problem" },
  ];

  const split = splitDisputed(raised, disputed);

  expect(split.live.map((f) => f.title)).toEqual(["no engines field", "brand new problem"]);
  expect(split.settled.map((f) => f.title)).toEqual(["--version wins everywhere"]);
  expect(split.rebutted.map((f) => f.title)).toEqual(["no engines field"]);
  expect(splitDisputed(raised, []).live).toHaveLength(3);
});
