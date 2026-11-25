import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  blockingKeys,
  findingKey,
  formatFindings,
  isBlocking,
  offered,
  offeredDisputes,
  parseFixOutput,
  parseReviewOutput,
  parseSynthesis,
  renderPublicReview,
  renderReview,
  settleRound,
  settleFinalFix,
  splitDisputed,
  substantiated,
  unsubstantiated,
} from "../src/output";
import type { Finding, FixOutput, Synthesis } from "../src/output";
import type { YamlMap } from "../src/yaml";
import type { Verification } from "../src/verify";
import review522 from "./fixtures/public-text/mr-522-synthesis.json";
import { leaksIn } from "../src/public-text";
import { stringifyJson } from "../src/json";

// WARNING: whether a check passed is read from the journal on this tree, never from the fix's Output.
const FINAL = { head_sha: "abc123", fingerprint: "tree-1" };
const EARLIER = { head_sha: "abc000", fingerprint: "tree-0" };
function record(over: Partial<Verification> & { name: string }) {
  const returned: Verification = {
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
  return returned;
}
const PASSED = { verifications: [record({ name: "bun test" })], final: FINAL };

test("carrying a maintained dispute counts the finding once", () => {
  const dispute: Finding = { severity: "major", title: "keep the behavior" };
  const split = splitDisputed([dispute], [dispute]);
  expect(
    settleRound({ live: split.live, disputed: [dispute, ...split.settled], at: 2 }),
  ).toMatchObject({
    go: "halt",
    reason: "1 disputed blocking finding(s) stand unanswered — your call, not the loop's",
    outstanding: [dispute],
  });
});

test("a dispute survives a rename by id and counts once across ledger versions", () => {
  const before: Finding = { id: "F1", file: "src/old.ts", title: "guard input", severity: "major" };
  const renamed: Finding = { ...before, file: "src/new.ts", title: "guard renamed input" };
  const split = splitDisputed([renamed], [before]);
  expect(split.live).toEqual([]);
  expect(split.settled).toEqual([renamed]);
  expect(
    settleRound({ live: split.live, disputed: [before, ...split.settled], at: 2 }),
  ).toMatchObject({
    reason: "1 disputed blocking finding(s) stand unanswered — your call, not the loop's",
    outstanding: [before],
  });
  expect(splitDisputed([{ ...renamed, id: "F2" }], [renamed]).live).toHaveLength(1);
  const legacy = { file: renamed.file, title: renamed.title, severity: "major" };
  expect(splitDisputed([renamed], [legacy]).settled).toEqual([renamed]);
});

const GUARD: Finding = {
  file: "src/guard.ts",
  severity: "blocker",
  title: "guard the input",
  reason: "the caller already validates it",
};
const GUARD_LATEST: Finding = {
  ...GUARD,
  detail: "the CLI path does not validate it",
};

test("a disputed blocker is the person's call even when the review also raised a live one", () => {
  expect(settleRound({ live: [LIST], disputed: [GUARD], at: 2 })).toMatchObject({
    go: "halt",
    halt: "dispute_unresolved",
    outstanding: [GUARD, LIST],
  });
});

test("a person is offered the fixer's finding with the reviewer's latest detail", () => {
  const repeatedAsMinor = { ...GUARD_LATEST, severity: "minor" as const };
  expect(offered([GUARD, repeatedAsMinor])).toEqual([
    {
      ...GUARD,
      detail: "the CLI path does not validate it",
    },
  ]);
  expect(settleRound({ live: [LIST], disputed: [GUARD, repeatedAsMinor], at: 2 })).toMatchObject({
    halt: "dispute_unresolved",
    outstanding: [GUARD_LATEST, LIST],
  });
});

test("a blocker resolved beside a repeated one is progress, not no progress", () => {
  const guardAgain: Finding = { ...GUARD_LATEST, status: undefined };
  const keys = keysOf([LIST, GUARD_LATEST]);
  expect(
    settleRound({
      live: [LIST, guardAgain],
      disputed: [],
      at: 2,
      seen: { at: 1, keys, handed: keys },
    }),
  ).toMatchObject({ go: "halt", halt: "no_progress" });
  expect(
    settleRound({
      live: [guardAgain],
      disputed: [],
      at: 3,
      seen: { at: 2, keys, handed: keys },
    }),
  ).toMatchObject({ go: "fix" });
});

test("resolved ledger findings leave the rally clean and a dispute remains the human's call", () => {
  const fixed: Finding = { id: "F1", status: "fixed", severity: "major", title: "guard the input" };
  const obsolete: Finding = {
    id: "F2",
    status: "obsolete",
    severity: "blocker",
    title: "removed handler",
  };
  const dispute: Finding = {
    id: "F3",
    status: "disputed",
    severity: "major",
    title: "keep the behavior",
  };
  const split = splitDisputed([fixed, obsolete, dispute], []);
  expect(split.live).toEqual([]);
  expect(split.settled).toEqual([dispute]);
  expect(settleRound({ live: [fixed, obsolete], disputed: [], at: 2 })).toEqual({
    go: "clean",
    remaining: [],
  });
  expect(settleRound({ live: [], disputed: [dispute], at: 2 })).toMatchObject({
    go: "halt",
    halt: "dispute_unresolved",
  });
  expect(isBlocking(fixed)).toBe(false);
  expect(isBlocking(obsolete)).toBe(false);
});

const LIST: Finding = {
  file: "src/list.ts",
  severity: "blocker",
  title: "empty list",
  detail: "it throws on an empty list",
};
const LIST_AGAIN: Finding = { ...LIST, detail: "it throws on a null list too" };
const CLAIMED_LIST = [{ file: "src/list.ts", title: "empty list" }];

const keysOf = (findings: ReadonlyArray<Finding>) => blockingKeys(findings);

test("a fix the review after it rejects goes back to the fixer once, marked rejected, and halts on the next repeat", () => {
  expect(settleRound({ live: [LIST], disputed: [], at: 1 })).toMatchObject({ go: "fix" });
  expect(
    settleRound({
      live: [LIST_AGAIN],
      disputed: [],
      at: 2,
      seen: { at: 1, keys: keysOf([LIST]), claimed: CLAIMED_LIST },
    }),
  ).toMatchObject({
    go: "fix",
    handedBack: [{ finding: LIST_AGAIN, rejected: true }],
  });
  expect(
    settleRound({
      live: [LIST_AGAIN],
      disputed: [],
      at: 3,
      seen: {
        at: 2,
        keys: keysOf([LIST_AGAIN]),
        claimed: CLAIMED_LIST,
        handed: [findingKey(LIST)],
      },
    }),
  ).toMatchObject({ go: "halt", halt: "no_progress" });
});

test("a blocker raised again that no fix claimed fixed goes back once, unmarked, and halts on the next repeat", () => {
  expect(
    settleRound({
      live: [LIST_AGAIN],
      disputed: [],
      at: 2,
      seen: { at: 1, keys: keysOf([LIST]), claimed: [] },
    }),
  ).toMatchObject({ go: "fix", handedBack: [{ finding: LIST_AGAIN, rejected: false }] });
  expect(
    settleRound({
      live: [LIST_AGAIN],
      disputed: [],
      at: 3,
      seen: { at: 2, keys: keysOf([LIST_AGAIN]), claimed: [], handed: [findingKey(LIST_AGAIN)] },
    }),
  ).toMatchObject({ go: "halt", halt: "no_progress" });
});

test("a handed-back finding that is then met leaves a later blocker its own hand-back", () => {
  const retry: Finding = {
    file: "src/job.ts",
    severity: "major",
    title: "unbounded retry",
    detail: "it retries forever",
  };
  const retryAgain: Finding = { ...retry, detail: "it retries forever on a failed job" };
  const third = settleRound({
    live: [retry],
    disputed: [],
    at: 3,
    seen: { at: 2, keys: keysOf([LIST_AGAIN]), claimed: [], handed: [findingKey(LIST)] },
  });
  expect(third).toMatchObject({ go: "fix", handedBack: [] });
  expect(
    settleRound({
      live: [retryAgain],
      disputed: [],
      at: 4,
      seen: {
        at: 3,
        keys: keysOf([retry]),
        claimed: [],
        handed: [findingKey(LIST)],
      },
    }),
  ).toMatchObject({ go: "fix", handedBack: [{ finding: retryAgain, rejected: false }] });
});

const ok = (text: string) => {
  const r = parseReviewOutput(text, "review.json");
  if (!r.ok) {
    throw new Error(r.error);
  }
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
  if (!r.ok) {
    throw new Error(r.error);
  }
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
    Arr.join(
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
      ],
      "\n",
    ),
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

test("the public rendering of the !522 review keeps the repository comment rule and hides process findings", () => {
  const synthesis = synth(stringifyJson(review522));
  const rendered = renderPublicReview(synthesis);
  expect(rendered).toStartWith(review522.public_summary);
  expect(rendered).toContain("**Minor**");
  expect(rendered).toContain("Remove redundant comments");
  expect(rendered).toContain("ai-instructions/company-instructions/workflow/workflow.md");
  expect(rendered).not.toContain("Record failing-first evidence");
  expect(rendered).not.toContain("**Major**");
  expect(leaksIn(rendered)).toEqual([]);
  expect(renderReview(synthesis)).toContain("Record failing-first evidence");
  expect(renderReview(synthesis)).toStartWith(review522.summary);
});

test("a review with only internal findings posts a nothing-to-change note", () => {
  const synthesis = synth(
    stringifyJson({
      ...review522,
      public_summary: "Updates profile verification. No runtime regression was found.",
      findings: [review522.findings[0]],
    }),
  );
  expect(renderPublicReview(synthesis)).toBe(
    "Updates profile verification. No runtime regression was found.\n\nNothing to fix.\n",
  );
  expect(leaksIn(renderPublicReview(synthesis))).toEqual([]);
});

test("fixed process findings stay in the complete review instead of returning in the public note", () => {
  const synthesis = synth(
    stringifyJson({
      verdict: "clean",
      summary: "The failing-first evidence is now recorded.",
      public_summary: "Updates profile verification. No runtime regression was found.",
      fixed: [
        { title: "Record failing-first evidence", note: "collie verify recorded the failure." },
      ],
    }),
  );
  const rendered = renderPublicReview(synthesis);
  expect(rendered).not.toContain("Fixed since last review");
  expect(leaksIn(rendered)).toEqual([]);
  expect(renderReview(synthesis)).toContain("Record failing-first evidence");
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

  expect(Arr.map(split.live, (f) => f.title)).toEqual(["no engines field", "brand new problem"]);
  expect(Arr.map(split.settled, (f) => f.title)).toEqual(["--version wins everywhere"]);
  expect(Arr.map(split.rebutted, (f) => f.title)).toEqual(["no engines field"]);
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

  const rendered = renderReview(parsed);
  expect(rendered).toContain("**Fixed since last review**");
  expect(rendered).toContain("`cli.js` — exit code");
  expect(rendered).toContain("now exits 2");
  expect(rendered).toContain("Nothing to fix.");
  expect(renderReview({ ...parsed, fixed: [] })).not.toContain("Fixed since");
});

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
const fixJson = (extra: YamlMap) => ({
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
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  expect(parsed.value.fixed).toEqual([
    { file: "cli.js", title: "no exit code", note: "process.exit(1)" },
  ]);
  expect(Arr.map(parsed.value.disputed, (f) => f.title)).toEqual(["loose equality"]);
  expect(parsed.value.checks).toEqual([{ name: "bun test", note: "12 pass" }]);
  expect(findingKey(parsed.value.fixed[0]!)).toBe(findingKey(BLOCKER));
});

test("a fix Output in the legacy shape or with an unusable check does not parse", () => {
  const legacy = parseFixOutput(fixJson({ fixed: ["added process.exit"] }), "fix.json");
  expect(legacy.ok).toBe(false);
  const noName = parseFixOutput(fixJson({ checks: [{ passed: true }] }), "fix.json");
  expect(noName.ok ? "(no error)" : noName.error).toContain("checks[0]: name is required");
  const bare = parseFixOutput(fixJson({}), "fix.json");
  expect(bare.ok && bare.value).toEqual({
    verdict: "clean",
    findings: [],
    fixed: [],
    disputed: [],
    checks: [],
  });
  const open = parseFixOutput(fixJson({ verdict: "findings", findings: [BLOCKER] }), "fix.json");
  expect(open.ok && open.value.findings).toEqual([BLOCKER]);
  expect(parseFixOutput(fixJson({ verdict: "findings" }), "fix.json").ok).toBe(false);
});

test("a person at a last-fix halt is offered the fix's disputes, not the findings it reported fixed", () => {
  const fixedOne: Finding = {
    file: "src/b.ts",
    severity: "blocker",
    title: "the retry loop stops",
  };
  const newOne: Finding = {
    file: "src/a.ts",
    severity: "blocker",
    title: "the guard is on the wrong side",
    reason: "the caller already validates it",
  };
  const minorOne: Finding = { file: "cli.js", severity: "minor", title: "long argument list" };
  const fix = {
    verdict: "findings" as const,
    findings: [],
    fixed: [{ file: fixedOne.file, title: fixedOne.title }],
    disputed: [newOne, minorOne],
    checks: [{ name: "bun test" }],
  };
  expect(offeredDisputes(fix, [])).toEqual([newOne]);
  expect(offeredDisputes(fix, [newOne])).toEqual([]);
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
  expect(both.ok ? "(ok)" : `${both.halt}: ${Arr.join(both.reasons, "; ")}`).toBe(
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
  const open = settleFinalFix(
    [BLOCKER],
    { ...good, verdict: "findings", findings: [MAJOR_NEW] },
    PASSED,
  );
  expect(open.ok).toBe(false);
  if (open.ok) {
    throw new Error("expected halt");
  }
  expect(open.halt).toBe("fix_unverified");
  expect(open.reasons).toEqual([
    "the fix reports 1 blocking finding(s) of its own: [major] Rejection unhandled (cli.js)",
  ]);
  expect(open.outstanding).toEqual([BLOCKER, MAJOR_NEW]);
  const listed = settleFinalFix([BLOCKER], { ...good, findings: [MAJOR_NEW] }, PASSED);
  expect(listed.ok ? "(ok)" : listed.reasons).toEqual([
    "the fix reports 1 blocking finding(s) of its own: [major] Rejection unhandled (cli.js)",
  ]);
});

test("a last fix whose own findings are all minor settles and carries them as outstanding", () => {
  const nit = { file: "cli.js", severity: "minor", title: "Message could be shorter" };
  const settled = settleFinalFix(
    [BLOCKER],
    {
      verdict: "findings",
      findings: [nit],
      fixed: [{ file: "cli.js", title: "no exit code" }],
      disputed: [],
      checks: [{ name: "bun test" }],
    },
    PASSED,
  );
  if (!settled.ok) {
    throw new Error(`expected ok: ${Arr.join(settled.reasons, "; ")}`);
  }
  expect(settled.outstanding).toEqual([nit]);
  expect(settled.attestation).toContain("[minor] Message could be shorter (cli.js)");
});

test("a last fix that reports a major finding of its own halts and names it", () => {
  const settled = settleFinalFix(
    [BLOCKER],
    {
      verdict: "clean",
      findings: [MAJOR_NEW],
      fixed: [{ file: "cli.js", title: "no exit code" }],
      disputed: [],
      checks: [{ name: "bun test" }],
    },
    PASSED,
  );
  expect(settled.ok ? "(ok)" : `${settled.halt}: ${Arr.join(settled.reasons, "; ")}`).toBe(
    "fix_unverified: the fix reports 1 blocking finding(s) of its own: [major] Rejection unhandled (cli.js)",
  );
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
  if (!settled.ok) {
    throw new Error("expected ok");
  }
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
    return r.ok ? "(ok)" : `${r.halt}: ${Arr.join(r.reasons, "; ")}`;
  };
  expect(halt({ ...good, fixed: [] })).toBe(
    "fix_unverified: no disposition for [blocker] No exit code (cli.js)",
  );
  expect(halt({ ...good, fixed: [{ file: "cli.js", title: "missing exit code" }] })).toContain(
    "no disposition for [blocker] No exit code",
  );
  expect(halt({ ...good, checks: [] })).toBe("fix_unverified: no checks reported");
  // WARNING: the Output's own word on a check is never read; the journal is.
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
  ).toBe("(ok)");
  expect(
    halt(claimed, {
      verifications: [record({ name: "bun test", result: "unstable", end: EARLIER })],
      final: FINAL,
    }),
  ).toBe('fix_unverified: check "bun test" ran on a tree that moved under it (all green)');
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
  expect(
    halt({
      ...good,
      fixed: [],
      disputed: [{ ...BLOCKER, detail: "out of scope" }],
    }),
  ).toBe("dispute_unresolved: disputed blocking finding: [blocker] No exit code (cli.js)");
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
  if (both.ok) {
    throw new Error("expected halt");
  }
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
  expect(settled.ok ? "(ok)" : `${settled.halt}: ${Arr.join(settled.reasons, "; ")}`).toBe(
    "dispute_unresolved: disputed blocking finding: [blocker] No exit code (cli.js)",
  );
  if (settled.ok) {
    throw new Error("expected halt");
  }
  expect(settled.outstanding).toEqual([MAJOR_NEW, { ...BLOCKER, detail: "out of scope" }]);
  const minor = settleFinalFix(
    [MAJOR_NEW],
    { ...fix, disputed: [{ ...MINOR, detail: "fine" }] },
    PASSED,
  );
  expect(minor.ok).toBe(true);
});

test("substantiation asks a blocker where and why, and nothing of a minor", () => {
  const blocker = (over: Partial<Finding> = {}) => ({
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
  expect(substantiated(blocker({ severity: "critical", file: undefined }))).toBe(false);
  expect(substantiated(blocker({ severity: "minor", file: undefined, detail: undefined }))).toBe(
    true,
  );

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

test("the last fix's check is proved by the latest record of the check's command on this tree, under any name, and never by an expected failure", () => {
  const unit = { name: "unit", executable: "/usr/bin/bun", argv: ["test"], cwd: "/repo" };
  const fix = {
    verdict: "clean" as const,
    findings: [],
    fixed: [{ file: "cli.js", title: "no exit code" }],
    disputed: [],
    checks: [{ name: "unit" }],
  };
  const settled = (verifications: Array<Verification>) =>
    settleFinalFix([BLOCKER], fix, { verifications, final: FINAL, commands: [unit] }).ok;
  expect(settled([record({ name: "mine" })])).toBe(true);
  expect(settled([record({ name: "mine", expect: "fail", exit: 1 })])).toBe(false);
  expect(
    settled([record({ name: "mine" }), record({ name: "unit", result: "fail", exit: 1 })]),
  ).toBe(false);
  expect(settled([record({ name: "mine" }), record({ name: "x", expect: "fail", exit: 1 })])).toBe(
    false,
  );
});

test("a last fix naming one of the Run's Checks with no record on the tree stands, and leaves it to the gate", () => {
  const check = { name: "check", executable: "/usr/bin/bun", argv: ["run", "check"], cwd: "/repo" };
  const settle = (checks: ReadonlyArray<{ name: string }>) =>
    settleFinalFix(
      [],
      { verdict: "clean", findings: [], fixed: [], disputed: [], checks },
      { verifications: [], final: FINAL, commands: [check] },
    );
  const settled = settle([{ name: "check" }]);
  expect(settled.ok ? settled.attestation : settled.reasons).toBe(
    "last fix: 0 blocking finding(s) reported fixed, 0 check(s) verified on this tree, 1 left to the gate on the final tree (check) — implementer-reported, not re-reviewed",
  );
  const other = settle([{ name: "check" }, { name: "lint" }]);
  expect(other.ok ? other.attestation : other.reasons).toEqual([
    'check "lint" has no verification record — run it through collie verify',
  ]);
});

test("an attestation counts as verified on this tree only the checks that passed on it", () => {
  const settled = settleFinalFix(
    [],
    {
      verdict: "clean",
      findings: [],
      fixed: [],
      disputed: [],
      checks: [{ name: "bun test" }, { name: "lint" }],
    },
    {
      verifications: [record({ name: "bun test" }), record({ name: "lint", end: EARLIER })],
      final: FINAL,
    },
  );
  expect(settled.ok ? settled.attestation : settled.reasons).toContain(
    "1 check(s) verified on this tree, 1 left to the gate on the final tree (lint)",
  );
});
