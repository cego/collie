// The shared Output schemas and the parsers beside them, case for case.
//
// An author declaring a review step gets `ReviewOutputSchema` through the SDK; the engine
// still reads `review.json` with `parseReviewOutput`, which writes the messages a repair
// round is given. Two readings of one file is a bug waiting to be found in production, so
// every case the parsers are held to is run through the schema here as well — including
// the optional judgement fields and the free-text severity, which are exactly what a
// schema is tempted to narrow.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Schema, flow, Result } from "effect";
import {
  CriterionSchema,
  FixOutputSchema,
  MrOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  SynthesisSchema,
  afterMergeAnswers,
  parseFixOutput,
  parseReviewOutput,
  parseSynthesis,
  unmetCriteria,
  type Parsed,
} from "../src/output";
import { YamlValueJsonSchema } from "../src/yaml";
import { jsonSchemaFor } from "../src/sdk";

type Readable = Schema.Codec<unknown, unknown, never, never>;

const accepts = (schema: Readable, text: string): boolean =>
  Schema.decodeExit(schema)(flow(Schema.decodeResult(YamlValueJsonSchema), Result.getOrThrow)(text))
    ._tag === "Success";

/** Both readings of one document agree on whether it is one. */
const agree = <T>(
  schema: Readable,
  parse: (text: string) => Parsed<T>,
  cases: ReadonlyArray<string>,
) => {
  for (const text of cases) {
    expect([text, accepts(schema, text)]).toEqual([text, parse(text).ok]);
  }
};

const REVIEWS = [
  `{"verdict": "clean"}`,
  `{"verdict": "clean", "findings": [], "disputed": []}`,
  `{"verdict": "clean", "findings": null, "disputed": null}`,
  `{"verdict": "findings", "findings": [{"file": "a.ts", "line": 3, "severity": "major", "title": "leak", "detail": "d"}]}`,
  // A fork's own severity is a judgement, not an error.
  `{"verdict": "findings", "findings": [{"severity": "nit", "title": "vocabulary"}]}`,
  `{"verdict": "findings", "findings": [{"severity": "major", "title": "t", "rebuttal": "answered"}]}`,
  `{"verdict": "clean", "disputed": [{"severity": "minor", "title": "t", "reason": "why"}]}`,
  // A review may say more than a gate reads.
  `{"verdict": "clean", "summary": "extra keys are not an error"}`,
  `{"verdict": "ok"}`,
  `{"verdict": "findings", "findings": []}`,
  `{"verdict": "clean", "findings": {}}`,
  `{"verdict": "clean", "findings": [{"severity": "major"}]}`,
  `{"verdict": "clean", "findings": [{"title": "t"}]}`,
  `{"verdict": "clean", "findings": [{"title": "  ", "severity": "major"}]}`,
  `{"verdict": "clean", "disputed": [{"title": "t"}]}`,
  `[]`,
];

const SYNTHESES = [
  `{"verdict": "clean", "summary": "s"}`,
  `{"verdict": "findings", "summary": "Adds a flag. It exits wrong.",
    "findings": [{"file": "cli.js", "line": 4, "severity": "blocker", "title": "exit code"}],
    "dropped": [{"file": "pkg.json", "severity": "minor", "title": "no engines field",
                 "reason": "packaging is out of scope"}]}`,
  `{"verdict": "clean", "summary": "s", "fixed": [{"title": "t", "file": "a.ts", "note": "n"}]}`,
  `{"verdict": "ok", "summary": "s"}`,
  `{"verdict": "clean"}`,
  `{"verdict": "clean", "summary": "  "}`,
  `{"verdict": "clean", "summary": "s", "dropped": [{"title": "t"}]}`,
  `{"verdict": "clean", "summary": "s", "dropped": [{"title": "t", "severity": "minor"}]}`,
  `{"verdict": "clean", "summary": "s", "fixed": [{"note": "n"}]}`,
];

const FIXES = [
  `{"verdict": "clean"}`,
  `{"verdict": "clean", "fixed": [{"title": "t"}], "checks": [{"name": "bun test"}]}`,
  `{"verdict": "clean", "checks": [{"name": "bun test", "note": "on the branch"}]}`,
  `{"verdict": "findings", "findings": [{"severity": "major", "title": "t"}]}`,
  `{"verdict": "findings", "findings": []}`,
  `{"verdict": "clean", "checks": [{}]}`,
  `{"verdict": "clean", "checks": [{"name": "  "}]}`,
];

test("a review reads the same through the shared schema and the parser", () => {
  agree(ReviewOutputSchema, (text) => parseReviewOutput(text, "review.json"), REVIEWS);
});

test("a synthesis reads the same through the shared schema and the parser", () => {
  agree(SynthesisSchema, (text) => parseSynthesis(text, "synthesized.json"), SYNTHESES);
});

test("a fix report reads the same through the shared schema and the parser", () => {
  agree(
    FixOutputSchema,
    (text) =>
      parseFixOutput(
        flow(Schema.decodeResult(YamlValueJsonSchema), Result.getOrThrow)(text),
        "fix.json",
      ),
    FIXES,
  );
});

test("a fixer is told its verdict counts only what it left unresolved; a reviewer is not", () => {
  expect(jsonSchemaFor(FixOutputSchema).document).toMatchObject({
    properties: {
      verdict: {
        description: expect.stringMatching(/unresolved.*"fixed".*"disputed".*"clean"/),
      },
    },
  });
  expect(jsonSchemaFor(ReviewOutputSchema).document).not.toHaveProperty([
    "properties",
    "verdict",
    "description",
  ]);
});

test("the optional judgement fields survive the schema, and the values come back whole", () => {
  const decoded = flow(
    Schema.decodeResult(ReviewOutputSchema),
    Result.getOrThrow,
  )({
    verdict: "findings",
    findings: [
      { file: "a.ts", line: 3, severity: "major", title: "leak", detail: "d", rebuttal: "r" },
      { severity: "nit", title: "no file, no line, no detail" },
    ],
  });
  expect(decoded).toEqual({
    verdict: "findings",
    findings: [
      { file: "a.ts", line: 3, severity: "major", title: "leak", detail: "d", rebuttal: "r" },
      { severity: "nit", title: "no file, no line, no detail" },
    ],
    disputed: [],
  });
});

test("the merge request and plan steps carry what a card reads, and no more", () => {
  expect(
    flow(
      Schema.decodeResult(MrOutputSchema),
      Result.getOrThrow,
    )({ pushed: false, note: "auto-merge is on" }),
  ).toEqual({ pushed: false, note: "auto-merge is on" });
  expect(
    flow(
      Schema.decodeResult(MrOutputSchema),
      Result.getOrThrow,
    )({ pushed: true, mr_url: "https://example/mr/1" }),
  ).toEqual({ pushed: true, mr_url: "https://example/mr/1" });
  // `pushed` is the one thing that is never absent: a step that says nothing about it has
  // not reported whether somebody else's pipeline was started.
  expect(Schema.decodeUnknownExit(MrOutputSchema)({ mr_url: "u" })._tag).toBe("Failure");

  expect(
    flow(Schema.decodeResult(PlanOutputSchema), Result.getOrThrow)({ issues_dir: "plan/issues" }),
  ).toEqual({
    issues_dir: "plan/issues",
  });
  expect(Schema.decodeExit(PlanOutputSchema)({ issues_dir: " " })._tag).toBe("Failure");
});

test("each criterion is answered with how it is met, and one unanswered or unmet blocks", () => {
  const Built = Schema.Struct({ criteria: Schema.optionalKey(Schema.Array(CriterionSchema)) });
  expect(flow(Schema.decodeResult(Built), Result.getOrThrow)({})).toEqual({});
  expect(
    flow(
      Schema.decodeResult(Built),
      Result.getOrThrow,
    )({
      criteria: [{ criterion: "**A.** it does a", met: "test/a.test.ts" }],
    }),
  ).toEqual({ criteria: [{ criterion: "**A.** it does a", met: "test/a.test.ts" }] });
  expect(Schema.decodeExit(Built)({ criteria: [{ criterion: "a", met: " " }] })._tag).toBe(
    "Failure",
  );

  const criteria = [
    "**A.** It does `a`, with one entry per thing.",
    "**B.** It does b.",
    "**C.** It does c.",
  ];
  const unmet = unmetCriteria("05-x.md", criteria, [
    // Copied with its formatting dropped, it is still the same criterion.
    { criterion: "A. It does a, with one entry per thing", met: "test/a.test.ts" },
    { criterion: "**B.** It does b.", met: "Not met: b needs a service nobody has" },
  ]);
  expect(unmet).toEqual([
    {
      file: "05-x.md",
      severity: "blocker",
      title: "acceptance criterion not met: **B.** It does b.",
      detail: "Not met: b needs a service nobody has",
    },
    {
      file: "05-x.md",
      severity: "blocker",
      title: "acceptance criterion not answered: **C.** It does c.",
      detail: "The builder's Output says nothing of how this criterion is met.",
    },
  ]);
  expect(unmetCriteria("05-x.md", [], [])).toEqual([]);
  expect(
    Arr.map(
      unmetCriteria("05-x.md", criteria.slice(0, 1), [{ criterion: "A.", met: "t" }]),
      (one) => one.title,
    ),
  ).toEqual(["acceptance criterion not answered: **A.** It does `a`, with one entry per thing."]);
});

test("an answer to a criterion's earlier wording does not answer it once amended", () => {
  const answers = [{ criterion: "All six tests pass.", met: "one run of test/flake.test.ts" }];
  expect(unmetCriteria("01.md", ["All six tests pass."], answers)).toEqual([]);
  expect(
    Arr.map(
      unmetCriteria(
        "01.md",
        ["**All six tests pass.** Each passes twenty consecutive runs."],
        answers,
      ),
      (one) => one.title,
    ),
  ).toEqual([
    "acceptance criterion not answered: **All six tests pass.** Each passes twenty consecutive runs.",
  ]);
});

test("a criterion only a deploy can show is answered after merge, and neither blocks nor is lost", () => {
  const criteria = ["**A.** It does a.", "**B.** It does b.", "**C.** It does c."];
  const answers = [
    { criterion: "**A.** It does a.", met: "After merge: only the deploy shows it" },
    { criterion: "**B.** It does b.", met: "not met: b needs a service nobody has" },
  ];
  expect(Arr.map(unmetCriteria("05-x.md", criteria, answers), (one) => one.title)).toEqual([
    "acceptance criterion not met: **B.** It does b.",
    "acceptance criterion not answered: **C.** It does c.",
  ]);
  expect(afterMergeAnswers(criteria, answers)).toEqual([
    { criterion: "**A.** It does a.", met: "After merge: only the deploy shows it" },
  ]);
});
