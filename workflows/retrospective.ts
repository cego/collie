// What `self-improve` decides, as pure functions its module and its tests share.

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
  [...body.matchAll(MARKER)].map((match) => match[1] ?? "");

/** The open issue a finding is about: the one it names, else the one carrying its key. */
export const targetOf = (finding: Finding, open: ReadonlyArray<OpenIssue>): OpenIssue | null =>
  open.find((one) => one.number === finding.issue) ??
  open.find((one) => one.keys.includes(finding.key)) ??
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
    const runs = new Set(finding.runs.filter((run) => window.has(run)));
    if (kept.some((one) => one.key === finding.key))
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
  improvements
    .filter(
      ({ keys }) => keys.length > 0 && keys.every((key) => outcomes.get(key)?.kind === "filed"),
    )
    .slice(0, bound);

export const goalOf = (
  issues: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly body: string;
    readonly url: string;
  }>,
) =>
  [
    "Fix these issues in Collie, which a self-improve Run filed:",
    ...issues.map(({ number, title, url, body }) => `## #${number} ${title}\n\n${url}\n\n${body}`),
    `The merge request must say ${issues.map(({ number }) => `\`Closes #${number}\``).join(", ")}, one per issue, so merging it closes them.`,
    "Quote nothing from anywhere else: no Run's goal, no person's words, no transcript and no other repository.",
  ].join("\n\n");

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
  for (const { created, ended } of earlier.toSorted((a, b) => at(a.created) - at(b.created)))
    for (const { name, issues, ended: how } of ended) {
      const same = `${name} ${issues.toSorted((a, b) => a - b).join(",")}`;
      if (!how.startsWith(FAILED_TO_START) || seen.has(same)) continue;
      seen.add(same);
      const taken = since.some(
        (run) =>
          at(run.created) > at(created) && run.closes.some((number) => issues.includes(number)),
      );
      if (
        !taken &&
        issues.every((number) => open.some((one) => one.number === number)) &&
        !restarts.some((one) => one.name === name)
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
  const categories = [...new Set(options.acted.map(({ finding }) => finding.category))];
  const line = ({ finding, outcome }: (typeof options.acted)[number]) =>
    outcome.kind === "refused"
      ? `- ${finding.title} (${finding.severity}): refused, ${outcome.reason}`
      : `- ${finding.title} (${finding.severity}): ${outcome.kind} #${outcome.number} ${outcome.url}`;
  return [
    `# self-improve ${options.runId}`,
    `Runs since ${options.since}.`,
    "## Issues",
    ...(categories.length === 0
      ? ["None."]
      : categories.flatMap((category) => [
          `### ${category}`,
          options.acted
            .filter(({ finding }) => finding.category === category)
            .map(line)
            .join("\n"),
        ])),
    "## Improvements",
    options.improvements.length === 0
      ? "None."
      : options.improvements
          .map(({ name, runId, ended }) => `- ${name}: ${runId ?? "not started"}, ${ended}`)
          .join("\n"),
    "## Left out",
    options.leftOut.length === 0
      ? "None."
      : options.leftOut.map(({ what, why }) => `- ${what}: ${why}`).join("\n"),
    "",
  ].join("\n\n");
};
