import { expect, test } from "bun:test";
import {
  formatFindings,
  parseReviewOutput,
  parseSynthesis,
  renderReview,
  splitDisputed,
  type Synthesis,
} from "../src/output";

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
    ok(
      `{"verdict": "findings", "findings": [{"file": "a.ts", "line": 3, "severity": "major", "title": "leak", "detail": "d"}]}`,
    ),
  ).toEqual({
    verdict: "findings",
    findings: [{ file: "a.ts", line: 3, severity: "major", title: "leak", detail: "d" }],
    disputed: [],
  });
});

test("the schema rejects what a gate could not read", () => {
  expect(err("nope")).toContain("review.json: not valid JSON");
  expect(err("[]")).toBe("review.json: expected a JSON object");
  expect(err(`{"verdict": "ok"}`)).toBe(
    'review.json: verdict must be "clean" or "findings", got "ok"',
  );
  expect(err(`{"verdict": "findings", "findings": []}`)).toBe(
    'review.json: verdict "findings" with an empty findings list',
  );
  expect(err(`{"verdict": "clean", "findings": {}}`)).toBe(
    "review.json: findings: expected an array",
  );
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

const synth = (text: string) => {
  const r = parseSynthesis(text, "synthesized.json");
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const synthErr = (text: string) => {
  const r = parseSynthesis(text, "synthesized.json");
  return r.ok ? "(no error)" : r.error;
};

test("a synthesis is a review plus the summary and what it decided not to carry", () => {
  expect(
    synth(
      `{"verdict": "findings", "summary": "Adds a flag. It exits wrong.",
        "findings": [{"file": "cli.js", "line": 4, "severity": "blocker", "title": "exit code"}],
        "dropped": [{"file": "pkg.json", "severity": "minor", "title": "no engines field",
                     "reason": "packaging is out of scope"}]}`,
    ),
  ).toEqual({
    verdict: "findings",
    summary: "Adds a flag. It exits wrong.",
    findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "exit code" }],
    dropped: [
      {
        file: "pkg.json",
        severity: "minor",
        title: "no engines field",
        reason: "packaging is out of scope",
      },
    ],
    disputed: [],
    fixed: [],
  });
});

test("a synthesis must summarise, and may not drop a finding without saying why", () => {
  // Everything the review schema rejects, a synthesis rejects too.
  expect(synthErr(`{"verdict": "ok"}`)).toBe(
    'synthesized.json: verdict must be "clean" or "findings", got "ok"',
  );
  expect(synthErr(`{"verdict": "clean"}`)).toBe("synthesized.json: summary is required");
  expect(synthErr(`{"verdict": "clean", "summary": "  "}`)).toBe(
    "synthesized.json: summary is required",
  );
  expect(synthErr(`{"verdict": "clean", "summary": "s", "dropped": [{"title": "t"}]}`)).toBe(
    "synthesized.json: dropped[0]: severity is required",
  );
  // A finding dropped without a reason is a finding lost, not one resolved.
  expect(
    synthErr(
      `{"verdict": "clean", "summary": "s", "dropped": [{"title": "t", "severity": "minor"}]}`,
    ),
  ).toBe("synthesized.json: dropped[0]: reason is required");
});

test("the rendered review is the summary and the findings, worst first, and nothing else", () => {
  const synthesis: Synthesis = {
    verdict: "findings",
    summary: "Adds a --version flag. One blocker.",
    disputed: [],
    dropped: [{ severity: "minor", title: "dropped one", reason: "cannot defend it" }],
    fixed: [],
    findings: [
      { severity: "minor", title: "Loose equality", file: "cli.js", line: 9 },
      { severity: "nit", title: "A vocabulary this repo does not use" },
      {
        severity: "blocker",
        title: "Exits 1 on success",
        file: "cli.js",
        line: 4,
        detail: "A caller\ncannot tell.",
      },
      {
        severity: "minor",
        title: "No test for the flag",
        rebuttal: "the reason misreads the spec",
      },
    ],
  };

  expect(renderReview(synthesis)).toBe(
    [
      "Adds a --version flag. One blocker.",
      "",
      "**Blocker**",
      "",
      "- `cli.js:4` — Exits 1 on success",
      "  A caller cannot tell.",
      "",
      "**Minor**",
      "",
      "- `cli.js:9` — Loose equality",
      "- No test for the flag",
      "",
      "**Nit**",
      "",
      "- A vocabulary this repo does not use",
      "",
    ].join("\n"),
  );
});

test("a clean review says so in one line, and never mentions the process", () => {
  const rendered = renderReview({
    verdict: "clean",
    summary: "A one-file change to the CLI. Nothing wrong with it.",
    findings: [],
    disputed: [],
    dropped: [
      { severity: "minor", title: "x", reason: "one reviewer only, and I cannot defend it" },
    ],
    fixed: [],
  });

  expect(rendered).toBe(
    "A one-file change to the CLI. Nothing wrong with it.\n\nNothing to fix.\n",
  );
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
    ok(
      `{"verdict": "findings", "findings": [{"severity": "major", "title": "x", "rebuttal": "the reason misreads the spec"}]}`,
    ).findings[0],
  ).toEqual({ severity: "major", title: "x", rebuttal: "the reason misreads the spec" });

  expect(
    formatFindings([
      {
        file: "a.ts",
        severity: "major",
        title: "leak",
        detail: "d",
        rebuttal: "you tested the wrong path",
      },
    ]),
  ).toBe("- [major] leak (a.ts)\n  d\n  answers your dispute: you tested the wrong path");
});

test("a finding the implementer already disputed is settled, unless a reviewer answers it", () => {
  const disputed = [
    {
      file: "cli.js",
      line: 6,
      severity: "minor",
      title: "--version wins everywhere",
      detail: "the spec says so",
    },
    {
      file: "pkg.json",
      severity: "minor",
      title: "no engines field",
      detail: "packaging is out of scope",
    },
  ];
  const raised = [
    // Same finding, re-raised verbatim except for a line that moved.
    { file: "cli.js", line: 9, severity: "minor", title: "--version wins everywhere" },
    {
      file: "pkg.json",
      severity: "minor",
      title: "no engines field",
      rebuttal: "node:test needs >=18",
    },
    { file: "cli.js", severity: "major", title: "brand new problem" },
  ];

  const split = splitDisputed(raised, disputed);

  expect(split.live.map((f) => f.title)).toEqual(["no engines field", "brand new problem"]);
  expect(split.settled.map((f) => f.title)).toEqual(["--version wins everywhere"]);
  expect(split.rebutted.map((f) => f.title)).toEqual(["no engines field"]);
  expect(splitDisputed(raised, []).live).toHaveLength(3);
});

test("a rebuttal the synthesis carried still reopens the dispute", () => {
  const synthesized = synth(
    `{"verdict": "findings", "summary": "s. s.",
      "findings": [{"file": "cli.js", "line": 9, "severity": "major", "title": "x",
                    "rebuttal": "the reason misreads the spec"}]}`,
  );
  const disputed = [{ file: "cli.js", severity: "major", title: "x", detail: "the spec says so" }];

  const split = splitDisputed(synthesized.findings, disputed);

  expect(split.rebutted).toHaveLength(1);
  expect(split.live).toHaveLength(1);
  expect(split.settled).toHaveLength(0);
});

test("what the last review raised and this one cannot find is read first", () => {
  const parsed = synth(
    `{"verdict": "clean", "summary": "The blocker is gone. Nothing else came back.",
      "findings": [],
      "fixed": [{"file": "cli.js", "title": "exit code", "note": "now exits 2"}]}`,
  );
  expect(parsed).toMatchObject({
    verdict: "clean",
    fixed: [{ file: "cli.js", title: "exit code", note: "now exits 2" }],
  });

  // A clean verdict with things fixed is the good ending, and reads as one.
  const rendered = renderReview(parsed);
  expect(rendered).toContain("**Fixed since last review**");
  expect(rendered).toContain("`cli.js` — exit code");
  expect(rendered).toContain("now exits 2");
  expect(rendered).toContain("Nothing to fix.");
  // The section is absent when there is no previous review to have fixed anything.
  expect(renderReview({ ...parsed, fixed: [] })).not.toContain("Fixed since");
});
