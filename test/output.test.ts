import { expect, test } from "bun:test";
import {
  findingKey,
  formatFindings,
  isBlocking,
  parseFixOutput,
  parseReviewOutput,
  parseSynthesis,
  renderReview,
  settleFinalFix,
  splitDisputed,
  substantiated,
  unsubstantiated,
  type Finding,
  type FixOutput,
  type Synthesis,
} from "../src/output";
import type { YamlMap } from "../src/yaml";
import type { Verification } from "../src/verify";

// The tree the last fix is judged on, and what the journal says about it. A check is a
// verification name; whether it passed is read from here, never from the fix's Output.
const FINAL = { head_sha: "abc123", fingerprint: "tree-1" };
const EARLIER = { head_sha: "abc000", fingerprint: "tree-0" };
function record(over: Partial<Verification> & { name: string }): Verification {
  return {
    id: `${over.name}-1`,
    run: "r1",
    executable: "/usr/bin/bun",
    argv: ["test"],
    cwd: "/repo",
    start: FINAL,
    end: FINAL,
    exit: 0,
    seconds: 1,
    tail: { stdout: "", stderr: "" },
    expect: "pass",
    result: "pass",
    at: "2026-09-11T10:00:00.000Z",
    by: "agent",
    ...over,
  };
}
const PASSED = { verifications: [record({ name: "bun test" })], final: FINAL };

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
  expect(ok(`{"verdict": "clean"}`)).toEqual({
    verdict: "clean",
    findings: [],
    disputed: [],
  });
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
      {
        severity: "minor",
        title: "x",
        reason: "one reviewer only, and I cannot defend it",
      },
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
      {
        file: "a.ts",
        line: 3,
        severity: "major",
        title: "leak",
        detail: "closes late",
      },
      { severity: "minor", title: "typo" },
    ]),
  ).toBe("- [major] leak (a.ts:3)\n  closes late\n- [minor] typo");
});

test("a rebuttal is kept, and it prints under the finding it answers", () => {
  expect(
    ok(
      `{"verdict": "findings", "findings": [{"severity": "major", "title": "x", "rebuttal": "the reason misreads the spec"}]}`,
    ).findings[0],
  ).toEqual({
    severity: "major",
    title: "x",
    rebuttal: "the reason misreads the spec",
  });

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
    {
      file: "cli.js",
      line: 9,
      severity: "minor",
      title: "--version wins everywhere",
    },
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
  const disputed = [
    {
      file: "cli.js",
      severity: "major",
      title: "x",
      detail: "the spec says so",
    },
  ];

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

// --- convergence: what the fix step reports, and what decides the last fix ---

const BLOCKER = {
  file: "cli.js",
  line: 4,
  severity: "blocker",
  title: "No exit code",
};
const MINOR = {
  file: "cli.js",
  line: 2,
  severity: "minor",
  title: "loose equality",
};
const MAJOR_NEW = {
  file: "cli.js",
  severity: "major",
  title: "Rejection unhandled",
};
const fixJson = (extra: YamlMap): YamlMap => ({
  verdict: "clean",
  findings: [],
  ...extra,
});

test("a fix Output carries what it fixed, disputed and checked, keyed like findings", () => {
  const parsed = parseFixOutput(
    fixJson({
      fixed: [{ file: "cli.js", title: "no exit code ", note: "process.exit(1)" }],
      disputed: [{ ...MINOR, detail: "== is fine here" }],
      checks: [{ name: "bun test", passed: true, note: "12 pass" }],
    }),
    "fix.json",
  );
  // `passed` is a claim, and is not kept: the journal says whether it passed.
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.fixed).toEqual([
    { file: "cli.js", title: "no exit code", note: "process.exit(1)" },
  ]);
  expect(parsed.value.disputed.map((f) => f.title)).toEqual(["loose equality"]);
  expect(parsed.value.checks).toEqual([{ name: "bun test", note: "12 pass" }]);
  // The line is not part of the key, and neither is the title's case.
  expect(findingKey(parsed.value.fixed[0]!)).toBe(findingKey(BLOCKER));
});

test("a fix Output in the legacy shape or with an unusable check does not parse", () => {
  const legacy = parseFixOutput(fixJson({ fixed: ["added process.exit"] }), "fix.json");
  expect(legacy.ok).toBe(false);
  const noName = parseFixOutput(fixJson({ checks: [{ passed: true }] }), "fix.json");
  expect(noName.ok ? "(no error)" : noName.error).toContain("checks[0]: name is required");
  // Nothing reported is a valid Output; whether it is enough is the policy's call.
  const bare = parseFixOutput(fixJson({}), "fix.json");
  expect(bare.ok && bare.value).toEqual({
    verdict: "clean",
    findings: [],
    fixed: [],
    disputed: [],
    checks: [],
  });
  // What the fix itself still reports open is read too, so the gate can count it.
  const open = parseFixOutput(fixJson({ verdict: "findings", findings: [BLOCKER] }), "fix.json");
  expect(open.ok && open.value.findings).toEqual([BLOCKER]);
  expect(parseFixOutput(fixJson({ verdict: "findings" }), "fix.json").ok).toBe(false);
});

test("the last fix cannot both fix and dispute a finding, and what it still reports open counts against it", () => {
  const good = {
    verdict: "clean" as const,
    findings: [],
    fixed: [{ file: "cli.js", title: "no exit code" }],
    disputed: [],
    checks: [{ name: "bun test" }],
  };
  const both = settleFinalFix(
    [BLOCKER],
    {
      ...good,
      disputed: [{ ...BLOCKER, detail: "also no" }],
    },
    PASSED,
  );
  expect(both.ok ? "(ok)" : `${both.halt}: ${both.reasons.join("; ")}`).toBe(
    "fix_unverified: both fixed and disputed: [blocker] No exit code (cli.js)",
  );
  const twice = settleFinalFix(
    [BLOCKER],
    { ...good, fixed: [...good.fixed, ...good.fixed] },
    PASSED,
  );
  expect(twice.ok ? "(ok)" : twice.reasons).toEqual([
    "duplicate disposition: cli.js::no exit code",
  ]);
  // A fix that reports its own findings has not finished, whatever it says it fixed.
  const open = settleFinalFix(
    [BLOCKER],
    { ...good, verdict: "findings", findings: [MAJOR_NEW] },
    PASSED,
  );
  expect(open.ok).toBe(false);
  if (open.ok) throw new Error("expected halt");
  expect(open.halt).toBe("fix_unverified");
  expect(open.reasons).toEqual([
    'the fix reports verdict "findings"',
    "the fix reports 1 finding(s) of its own: [major] Rejection unhandled (cli.js)",
  ]);
  expect(open.outstanding).toEqual([BLOCKER, MAJOR_NEW]);
  // Even under a clean verdict, a finding it lists is a finding it left.
  const listed = settleFinalFix([BLOCKER], { ...good, findings: [MAJOR_NEW] }, PASSED);
  expect(listed.ok ? "(ok)" : listed.reasons).toEqual([
    "the fix reports 1 finding(s) of its own: [major] Rejection unhandled (cli.js)",
  ]);
});

test("minor is the only severity that does not block; anything unknown fails closed", () => {
  expect(isBlocking(MINOR)).toBe(false);
  expect(isBlocking(BLOCKER)).toBe(true);
  expect(isBlocking({ severity: "major", title: "x" })).toBe(true);
  expect(isBlocking({ severity: "nit", title: "x" })).toBe(true);
  expect(isBlocking({ severity: "", title: "x" })).toBe(true);
});

test("the last fix settles the review when every blocking finding is fixed and the checks passed", () => {
  const fix = {
    verdict: "clean" as const,
    findings: [],
    fixed: [{ file: "cli.js", title: "no exit code" }],
    disputed: [],
    checks: [{ name: "bun test" }],
  };
  const settled = settleFinalFix([BLOCKER, MINOR], fix, PASSED);
  expect(settled.ok).toBe(true);
  if (!settled.ok) throw new Error("expected ok");
  // The minor it did not touch stays visible; the blocker it fixed does not.
  expect(settled.outstanding).toEqual([MINOR]);
  expect(settled.attestation).toContain("1 blocking finding(s) reported fixed");
  expect(settled.attestation).toContain("1 check(s) verified on this tree");
  expect(settled.attestation).toContain("not re-reviewed");
});

test("the last fix is not enough with a missing disposition, a reworded title, a failed or missing check", () => {
  const good = {
    verdict: "clean" as const,
    findings: [],
    fixed: [{ file: "cli.js", title: "no exit code" }],
    disputed: [],
    checks: [{ name: "bun test" }],
  };
  const halt = (fix: FixOutput, evidence = PASSED) => {
    const r = settleFinalFix([BLOCKER, MINOR], fix, evidence);
    return r.ok ? "(ok)" : `${r.halt}: ${r.reasons.join("; ")}`;
  };
  expect(halt({ ...good, fixed: [] })).toBe(
    "fix_unverified: no disposition for [blocker] No exit code (cli.js)",
  );
  expect(halt({ ...good, fixed: [{ file: "cli.js", title: "missing exit code" }] })).toContain(
    "no disposition for [blocker] No exit code",
  );
  expect(halt({ ...good, checks: [] })).toBe("fix_unverified: no checks reported");
  // The Output's own word on a check is not read at all: the journal is.
  const claimed = {
    ...good,
    checks: [{ name: "bun test", note: "all green" }],
  };
  expect(halt(claimed, { verifications: [], final: FINAL })).toBe(
    'fix_unverified: check "bun test" has no verification record — run it through collie verify (all green)',
  );
  expect(
    halt(claimed, {
      verifications: [record({ name: "bun test", result: "fail", exit: 1 })],
      final: FINAL,
    }),
  ).toBe("fix_unverified: check failed: bun test (all green)");
  expect(
    halt(claimed, {
      verifications: [record({ name: "bun test", end: EARLIER })],
      final: FINAL,
    }),
  ).toBe('fix_unverified: check "bun test" last passed on an earlier tree (all green)');
  expect(
    halt(claimed, {
      verifications: [record({ name: "bun test", result: "unstable", end: EARLIER })],
      final: FINAL,
    }),
  ).toBe('fix_unverified: check "bun test" ran on a tree that moved under it (all green)');
  // A later pass on this tree settles an earlier failure; the order of records is time.
  expect(
    halt(claimed, {
      verifications: [
        record({ name: "bun test", result: "fail", exit: 1, end: EARLIER }),
        record({ name: "bun test" }),
      ],
      final: FINAL,
    }),
  ).toBe("(ok)");
  expect(halt({ ...good, verdict: "findings" })).toBe(
    'fix_unverified: the fix reports verdict "findings"',
  );
  // A serious finding disputed at the last fix is the human's, not the loop's, and not the merge request's.
  expect(
    halt({
      ...good,
      fixed: [],
      disputed: [{ ...BLOCKER, detail: "out of scope" }],
    }),
  ).toBe("dispute_unresolved: disputed blocking finding: [blocker] No exit code (cli.js)");
  // Everything wrong is listed, and a dispute plus a missing check is unverified first.
  const both = settleFinalFix(
    [BLOCKER, MINOR],
    {
      ...good,
      fixed: [],
      disputed: [{ ...BLOCKER, detail: "no" }],
      checks: [],
    },
    PASSED,
  );
  expect(both.ok).toBe(false);
  if (both.ok) throw new Error("expected halt");
  expect(both.halt).toBe("fix_unverified");
  expect(both.reasons).toHaveLength(2);
  expect(both.outstanding).toEqual([BLOCKER, MINOR]);
});

test("a serious dispute the latest review left out still blocks the last fix", () => {
  const fix = {
    verdict: "clean" as const,
    findings: [],
    fixed: [{ file: "cli.js", title: "Rejection unhandled" }],
    disputed: [{ ...BLOCKER, detail: "out of scope" }],
    checks: [{ name: "bun test" }],
  };
  const settled = settleFinalFix([MAJOR_NEW], fix, PASSED);
  expect(settled.ok ? "(ok)" : `${settled.halt}: ${settled.reasons.join("; ")}`).toBe(
    "dispute_unresolved: disputed blocking finding: [blocker] No exit code (cli.js)",
  );
  if (settled.ok) throw new Error("expected halt");
  expect(settled.outstanding).toEqual([MAJOR_NEW, { ...BLOCKER, detail: "out of scope" }]);
  // A minor dispute outside the review is the implementer's call, as ever.
  const minor = settleFinalFix(
    [MAJOR_NEW],
    { ...fix, disputed: [{ ...MINOR, detail: "fine" }] },
    PASSED,
  );
  expect(minor.ok).toBe(true);
});

test("substantiation asks a blocker where and why, and nothing of a minor", () => {
  const blocker = (over: Partial<Finding> = {}): Finding => ({
    severity: "blocker",
    title: "something",
    file: "src/a.ts",
    detail: "it throws",
    ...over,
  });

  expect(substantiated(blocker())).toBe(true);
  expect(substantiated(blocker({ file: undefined }))).toBe(false);
  expect(substantiated(blocker({ detail: undefined }))).toBe(false);
  expect(substantiated(blocker({ file: "   " }))).toBe(false);
  expect(substantiated(blocker({ detail: " " }))).toBe(false);
  // Anything unrecognised blocks, so it is held to a blocker's standard too.
  expect(substantiated(blocker({ severity: "critical", file: undefined }))).toBe(false);
  // A minor drives no loop and costs no round, so it is exempt.
  expect(substantiated(blocker({ severity: "minor", file: undefined, detail: undefined }))).toBe(
    true,
  );

  // A file the change never touched is substantiated: an unchanged caller this change
  // breaks is exactly the blocker worth raising.
  expect(substantiated(blocker({ file: "src/never-touched.ts" }))).toBe(true);
});

test("the message names the findings that cannot be acted on, and says nothing when all can", () => {
  expect(unsubstantiated([])).toBeNull();
  expect(
    unsubstantiated([
      { severity: "blocker", title: "fine", file: "a.ts", detail: "because" },
      { severity: "minor", title: "bare" },
    ]),
  ).toBeNull();

  const said = unsubstantiated([
    { severity: "blocker", title: "vague one" },
    { severity: "major", title: "vague two", file: "a.ts" },
  ]);
  expect(said).toContain("2 blocking finding(s)");
  expect(said).toContain('"vague one"');
  expect(said).toContain('"vague two"');
  expect(said).toContain("need not be one the change touched");
});
