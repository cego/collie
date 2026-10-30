// What `self-improve` decides, as pure functions its module and its tests share.

import * as Num from "effect/Number";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { DateTime, Schema } from "effect";

export const CATEGORIES = [
  "navigation",
  "automated-checks",
  "coding-standards",
  "agents-md",
  "tool-economy",
  "no-ops",
  "information-access",
  "defect",
] as const;

export const MAX_FINDINGS = 10;

const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

export const Finding = Schema.Struct({
  key: Key.annotate({ description: "kebab-case; the same problem keeps the same key every day" }),
  category: Schema.Literals(CATEGORIES),
  title: Schema.String,
  body: Schema.String,
  severity: Schema.Literals(["high", "medium", "low"]),
  runs: Schema.Array(Schema.String).annotate({ description: "the window's Run ids that show it" }),
  records: Schema.Array(Schema.String).annotate({
    description: "the record files that show it, as paths",
  }),
  issue: Schema.NullOr(Schema.Int).annotate({
    description: "the number of the open issue it matches, or null",
  }),
  rule: Schema.optionalKey(Schema.Literals(["mechanical", "judgement"])).annotate({
    description: "coding-standards only: a deterministic check, or the reviewer's standards",
  }),
});
export type Finding = typeof Finding.Type;

export const Improvement = Schema.Struct({
  name: Key.annotate({ description: "kebab-case; names the plan it starts" }),
  keys: Schema.Array(Key).annotate({ description: "the new findings it fixes together" }),
  why: Schema.String.annotate({ description: "why one change should fix them together" }),
});
export type Improvement = typeof Improvement.Type;

export const LeftOut = Schema.Struct({ what: Schema.String, why: Schema.String });
export type LeftOut = typeof LeftOut.Type;

export const Triage = Schema.Struct({
  findings: Schema.Array(Finding)
    .check(Schema.isMaxLength(MAX_FINDINGS))
    .annotate({ description: `at most ${MAX_FINDINGS}, most severe first` }),
  improvements: Schema.Array(Improvement),
  left_out: Schema.Array(LeftOut),
});
export type Triage = typeof Triage.Type;

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly keys: ReadonlyArray<string>;
}

const MARKER = /<!-- collie-finding: ([a-z0-9-]+) -->/g;

export const markerOf = (key: string) => `<!-- collie-finding: ${key} -->`;

export const keysIn = (body: string): ReadonlyArray<string> =>
  Arr.map([...pipe(body, Str.matchAll(MARKER))], (match) => match[1] ?? "");

/** The open issue a finding is about: the one it names, else the one carrying its key. */
export const targetOf = (finding: Finding, open: ReadonlyArray<OpenIssue>): OpenIssue | null =>
  Option.getOrUndefined(Arr.findFirst(open, (one) => one.number === finding.issue)) ??
  Option.getOrUndefined(Arr.findFirst(open, (one) => one.keys.includes(finding.key))) ??
  null;

/**
 * The findings worth acting on. Recurring means two of the window's Runs, or an issue
 * already open; a `defect` needs only one Run, and is filed only where `defects` allows.
 */
export const sortOut = (
  findings: ReadonlyArray<Finding>,
  window: ReadonlySet<string>,
  open: ReadonlyArray<OpenIssue>,
  defects: boolean,
) => {
  const kept: Finding[] = [];
  const leftOut: LeftOut[] = [];
  for (const finding of findings) {
    const runs = new Set(Arr.filter(finding.runs, (run) => window.has(run)));
    if (Arr.some(kept, (one) => one.key === finding.key))
      leftOut.push({ what: finding.title, why: `the same key as another finding, ${finding.key}` });
    else if (runs.size === 0) leftOut.push({ what: finding.title, why: "no Run of the window" });
    else if (finding.category === "defect" && !defects)
      leftOut.push({ what: finding.title, why: "about Collie" });
    else if (finding.category !== "defect" && runs.size < 2 && targetOf(finding, open) === null)
      leftOut.push({ what: finding.title, why: "seen once" });
    else kept.push({ ...finding, runs: [...runs] });
  }
  return { kept, leftOut };
};

export type Outcome =
  | { readonly kind: "filed"; readonly number: number; readonly url: string }
  | { readonly kind: "commented"; readonly number: number; readonly url: string }
  | { readonly kind: "refused"; readonly reason: string };

/** The Improvements to start: only those whose findings were all filed new, up to `bound`. */
export const chosen = (
  improvements: ReadonlyArray<Improvement>,
  outcomes: ReadonlyMap<string, Outcome>,
  bound: number,
): ReadonlyArray<Improvement> =>
  Arr.filter(
    improvements,
    ({ keys }) => keys.length > 0 && Arr.every(keys, (key) => outcomes.get(key)?.kind === "filed"),
  ).slice(0, bound);

export const goalOf = (
  issues: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
  }>,
) =>
  Arr.join(
    [
      "Fix these issues in Collie, which a self-improve Run filed:",
      ...Arr.map(
        issues,
        ({ number, title, url, body }) => `## #${number} ${title}\n\n${url}\n\n${body}`,
      ),
      `The merge request must say ${Arr.join(
        Arr.map(issues, ({ number }) => `\`Closes #${number}\``),
        ", ",
      )}, one per issue, so merging it closes them.`,
      "Quote nothing from anywhere else: no Run's goal, no person's words, no transcript and no other repository.",
    ],
    "\n\n",
  );

export const Ended = Schema.Struct({
  name: Schema.String,
  issues: Schema.Array(Schema.Int),
  runId: Schema.NullOr(Schema.String),
  ended: Schema.String,
});
export type Ended = typeof Ended.Type;

export const FAILED_TO_START = "failed to start";

/** An Improvement to start, by the issues it fixes. */
export interface Starting {
  readonly name: string;
  readonly issues: ReadonlyArray<number>;
}

/**
 * The Improvements earlier Runs failed to start, each once, whose issues are all still open
 * and which no Run started since the first of those Runs closes; one per name, the earliest.
 */
export const restartsOf = (
  earlier: ReadonlyArray<{ readonly created: string; readonly ended: ReadonlyArray<Ended> }>,
  since: ReadonlyArray<{ readonly created: string; readonly closes: ReadonlyArray<number> }>,
  open: ReadonlyArray<{ readonly number: number }>,
): ReadonlyArray<Starting> => {
  const at = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
  const seen = new Set<string>();
  const restarts: Starting[] = [];
  for (const { created, ended } of Arr.sortWith(
    earlier,
    (value) => value,
    (a, b) => Num.sign(at(a.created) - at(b.created)),
  ))
    for (const { name, issues, ended: how } of ended) {
      const same = `${name} ${Arr.join(
        Arr.map(
          Arr.sortWith(
            issues,
            (value) => value,
            (a, b) => Num.sign(a - b),
          ),
          (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
        ),
        ",",
      )}`;
      if (!pipe(how, Str.startsWith(FAILED_TO_START)) || seen.has(same)) continue;
      seen.add(same);
      const taken = Arr.some(
        since,
        (run) =>
          at(run.created) > at(created) &&
          Arr.some(run.closes, (number) => issues.includes(number)),
      );
      if (
        !taken &&
        Arr.every(issues, (number) => Arr.some(open, (one) => one.number === number)) &&
        !Arr.some(restarts, (one) => one.name === name)
      )
        restarts.push({ name, issues });
    }
  return restarts;
};

export const summaryOf = (options: {
  readonly runId: string;
  readonly since: string;
  readonly acted: ReadonlyArray<{ readonly finding: Finding; readonly outcome: Outcome }>;
  readonly improvements: ReadonlyArray<Ended>;
  readonly leftOut: ReadonlyArray<LeftOut>;
}) => {
  const categories = [...new Set(Arr.map(options.acted, ({ finding }) => finding.category))];
  const line = ({ finding, outcome }: (typeof options.acted)[number]) =>
    outcome.kind === "refused"
      ? `- ${finding.title} (${finding.severity}): refused, ${outcome.reason}`
      : `- ${finding.title} (${finding.severity}): ${outcome.kind} #${outcome.number} ${outcome.url}`;
  return Arr.join(
    [
      `# self-improve ${options.runId}`,
      `Runs since ${options.since}.`,
      "## Issues",
      ...(categories.length === 0
        ? ["None."]
        : Arr.flatMap(categories, (category) => [
            `### ${category}`,
            Arr.join(
              Arr.map(
                Arr.filter(options.acted, ({ finding }) => finding.category === category),
                line,
              ),
              "\n",
            ),
          ])),
      "## Improvements",
      options.improvements.length === 0
        ? "None."
        : Arr.join(
            Arr.map(
              options.improvements,
              ({ name, runId, ended }) => `- ${name}: ${runId ?? "not started"}, ${ended}`,
            ),
            "\n",
          ),
      "## Left out",
      options.leftOut.length === 0
        ? "None."
        : Arr.join(
            Arr.map(options.leftOut, ({ what, why }) => `- ${what}: ${why}`),
            "\n",
          ),
      "",
    ],
    "\n\n",
  );
};
