// The shared Output schemas and the parsers beside them, case for case.
//
// An author declaring a review step gets `ReviewOutputSchema` through the SDK; the engine
// still reads `review.json` with `parseReviewOutput`, which writes the messages a repair
// round is given. Two readings of one file is a bug waiting to be found in production, so
// every case the parsers are held to is run through the schema here as well — including
// the optional judgement fields and the free-text severity, which are exactly what a
// schema is tempted to narrow.

import { expect, test } from "bun:test";
import { Schema } from "effect";
import {
  FixOutputSchema,
  MrOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  SynthesisSchema,
  parseFixOutput,
  parseReviewOutput,
  parseSynthesis,
  type Parsed,
} from "../src/output";
import { YamlValueJsonSchema } from "../src/yaml";

type Readable = Schema.Codec<unknown, unknown, never, never>;

const accepts = (schema: Readable, text: string): boolean =>
  Schema.decodeUnknownExit(schema)(Schema.decodeUnknownSync(YamlValueJsonSchema)(text))._tag ===
  "Success";

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
    (text) => parseFixOutput(Schema.decodeUnknownSync(YamlValueJsonSchema)(text), "fix.json"),
    FIXES,
  );
});

test("the optional judgement fields survive the schema, and the values come back whole", () => {
  const decoded = Schema.decodeUnknownSync(ReviewOutputSchema)({
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
    Schema.decodeUnknownSync(MrOutputSchema)({ pushed: false, note: "auto-merge is on" }),
  ).toEqual({ pushed: false, note: "auto-merge is on" });
  expect(
    Schema.decodeUnknownSync(MrOutputSchema)({ pushed: true, mr_url: "https://example/mr/1" }),
  ).toEqual({ pushed: true, mr_url: "https://example/mr/1" });
  // `pushed` is the one thing that is never absent: a step that says nothing about it has
  // not reported whether somebody else's pipeline was started.
  expect(Schema.decodeUnknownExit(MrOutputSchema)({ mr_url: "u" })._tag).toBe("Failure");

  expect(Schema.decodeUnknownSync(PlanOutputSchema)({ issues_dir: "plan/issues" })).toEqual({
    issues_dir: "plan/issues",
  });
  expect(Schema.decodeUnknownExit(PlanOutputSchema)({ issues_dir: " " })._tag).toBe("Failure");
});
