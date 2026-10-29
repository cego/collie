// Make a repository measurably faster, proved by the host's Measurement rather than by an
// agent's timings (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement). What only
// another repository could change is put to the human and never counts toward the outcome.

import {
  Agents,
  FindingSchema,
  FixOutputSchema,
  Host,
  IntegrationSchema,
  MeasurementSchema,
  Run,
  SynthesisSchema,
  WorkflowError,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  endsWithoutPatchOf,
  evidenceGapsOf,
  owedLocally,
  redact,
  renderApproved,
  renderEvidence,
  step,
  type Integration,
  type Measurement,
  type SynthesisReport,
} from "collie";
import { Array as Arr, Clock, Duration, Effect, FileSystem, Hash, Option, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./tune-up.md" with { type: "text" };
import { IMPLEMENTER, REVIEWER, ROUNDS, rally, reviewPass, reviewRound } from "./reviewing.ts";
import { Tree, deliver, gate, mergeRequest } from "./delivering.ts";

const content = contentOf(markdown);
const text = Schema.String;

const DEFAULTS = { cycles: 5, threshold: 5, tolerance: 2, samples: 10, external: "ask" } as const;

/** A whole number, as a front door's words or as JSON. */
const Whole = Schema.Union([Schema.Int, Schema.NumberFromString.check(Schema.isInt())]);
const Percent = Schema.Union([
  Schema.Finite,
  Schema.NumberFromString.check(Schema.isFinite()),
]).check(Schema.isGreaterThan(0));
const isDuration = Schema.makeFilter(
  (said: string) =>
    said === "" ||
    Option.isSome(Schema.decodeUnknownOption(Schema.DurationFromString)(said)) ||
    "a duration, such as 2 hours",
);

const Told = {
  inputs: Schema.Struct({ focus: text }),
  run: Schema.Struct({ dir: text, id: text }),
};

/** What every prompt from the final proof on is told, as delivery tells its own. */
const Delivering = {
  inputs: Schema.Struct({ focus: text, outcome: text }),
  run: Told.run,
  verify: text,
  body: text,
};

const prompts = {
  discover: content.template("discover", Told),
  harness: content.template("harness", {
    ...Told,
    discovered: text,
    budget: Schema.Struct({ samples: text, threshold: text, tolerance: text }),
  }),
  cycle: content.template("cycle", {
    ...Told,
    cycle: Schema.Struct({ n: text, of: text, start: text }),
    opportunities: text,
    earlier: text,
    metrics: text,
  }),
  revert: content.template("revert", {
    ...Told,
    cycle: Schema.Struct({ n: text, start: text, end: text, commits: text }),
    why: text,
  }),
  merge: content.template("merge", { ...Told, conflict: text }),
  externalSearch: content.template("external-search", {
    ...Told,
    finding: text,
    marker: text,
    repository: text,
    team: text,
  }),
  externalCreate: content.template("external-create", {
    ...Told,
    finding: text,
    marker: text,
    team: text,
  }),
  drop: content.template("drop", {
    ...Told,
    base: Schema.Struct({ merge: text, tree: text }),
    head: text,
    commits: text,
    why: text,
  }),
  fix: content.template("fix", {
    ...Delivering,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  ciFix: content.template("ci-fix", {
    ...Delivering,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  mr: content.template("mr", {
    ...Delivering,
    evidence: text,
    unreviewed: text,
    unsettled: text,
    mr: Schema.Struct({
      forge: text,
      noun: text,
      assignee: text,
      template: text,
      issues: text,
      existing: text,
      create: text,
      comment: text,
    }),
    target_repo: text,
  }),
};

/** What a reviewer of a Tune-up judges, beside what every review is told. */
const REVIEWING = content.sections.get("review") ?? "";

const Research = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["documentation", "prior-work"]),
    title: text,
    link: text,
    opportunity: text,
    effect: Schema.Literals(["raised", "lowered", "ruled out"]),
  }),
  Schema.Struct({ kind: Schema.Literal("nothing-found"), searched: text }),
]);

const Telemetry = Schema.Union([
  Schema.Struct({
    source: text,
    status: Schema.Literal("used"),
    release: text,
    window: text,
    sample: text,
    link: text,
  }),
  Schema.Struct({ source: text, status: Schema.Literal("unavailable"), reason: text }),
]);

const Opportunity = Schema.Struct({
  title: text,
  evidence: Schema.Literals(["measured", "telemetry", "hypothesis"]),
  cites: Schema.NonEmptyArray(text).annotate({
    description: "the research links, telemetry sources or Measurement ids it rests on",
  }),
});

/** An improvement only another repository can make, handed on and never assumed done. */
const External = Schema.Struct({
  title: text,
  repository: text.annotate({ description: "the repository that would change" }),
  team: Schema.optionalKey(text.annotate({ description: "the team that owns it, where known" })),
  links: Schema.Array(text).annotate({
    description: "evidence links, with any credential or personal data taken out",
  }),
  journey: text,
  change: text.annotate({ description: "the dependency or API change it needs" }),
  estimated_impact: text.annotate({
    description: "what you estimate it would gain; nothing external is measured",
  }),
  criteria: Schema.NonEmptyArray(text).annotate({ description: "its acceptance criteria" }),
  relation: text.annotate({ description: "how it relates to this Run's local change" }),
  existing: Schema.optionalKey(
    text.annotate({ description: "the URL of an issue already asking for it, where one is" }),
  ),
});
type External = typeof External.Type;
const Handed = {
  external: Schema.optionalKey(
    Schema.Array(External).annotate({
      description: "improvements only another repository could make",
    }),
  ),
};

/** What Discover is held to: nothing ranked without a source behind it. */
const Discovered = Schema.Struct({
  stack: Schema.NonEmptyArray(text),
  skills: Schema.Array(text).annotate({ description: "the installed skills you loaded, by name" }),
  journeys: Schema.NonEmptyArray(
    Schema.Struct({
      name: text,
      objectives: Schema.NonEmptyArray(
        Schema.Struct({ metric: text, target: Schema.optionalKey(text), why: text }),
      ),
    }),
  ),
  telemetry: Schema.NonEmptyArray(Telemetry).annotate({
    description: "one entry per telemetry source you tried",
  }),
  research: Schema.NonEmptyArray(Research),
  opportunities: Schema.Array(Opportunity).annotate({ description: "ranked, best first" }),
  external: Schema.Array(External),
});
type Discovered = typeof Discovered.Type;

const Command = Schema.Struct({ executable: text, argv: Schema.Array(text) });
const Direction = Schema.Literals(["lower", "higher"]);
const Metric = Schema.Struct({
  name: text,
  direction: Direction,
  role: Schema.Literals(["primary", "guardrail"]),
});
const Harness = Schema.Struct({
  commits: Schema.NonEmptyArray(text),
  paths: Schema.NonEmptyArray(text),
});

/** The plan Harness writes, before the Run's own budget is put on it. */
const Harnessed = Schema.Struct({
  journeys: Schema.NonEmptyArray(text),
  cases: Schema.Array(text),
  commands: Schema.NonEmptyArray(Schema.Struct({ name: text, ...Command.fields })),
  prepare: Schema.NullOr(Command),
  metrics: Schema.NonEmptyArray(
    Schema.Struct({
      ...Metric.fields,
      counter: Schema.optionalKey(
        Schema.Struct({ name: text, direction: Direction }).annotate({
          description: "a low-variance count of the same work, to judge this metric by instead",
        }),
      ),
    }),
  ),
  warmup: Schema.Int,
  harness: Harness,
});

/** A benchmark plan as the host measures by it, and why it is the plan now. */
const Planned = Schema.Struct({
  plan: Schema.Struct({
    harness: Harness,
    prepare: Schema.NullOr(Command),
    commands: Harnessed.fields.commands,
    metrics: Schema.NonEmptyArray(Metric),
    warmup: Schema.Int,
    samples: Schema.Int,
    threshold: Schema.Finite,
    tolerance: Schema.Finite,
  }),
  reason: text,
});
type Plan = typeof Planned.Type.plan;

/** What a Cycle's tuner did: one change, or why it made none. */
const Tried = Schema.Union([
  Schema.Struct({
    result: Schema.Literal("changed"),
    opportunity: text,
    change: text,
    commits: Schema.NonEmptyArray(text),
    ...Handed,
  }),
  Schema.Struct({
    result: Schema.Literal("exhausted"),
    why: text.annotate({ description: "why no measured opportunity is left" }),
    ...Handed,
  }),
  Schema.Struct({
    result: Schema.Literal("unsafe"),
    tradeoff: text.annotate({ description: "what every change left would give up for speed" }),
    ...Handed,
  }),
]);

/** What a search of Linear for an external finding found. */
const Searched = Schema.Struct({
  marked: Schema.NullOr(text).annotate({
    description: "the issue carrying the marker, by URL, or null",
  }),
  matching: Schema.Array(text).annotate({
    description: "open issues asking for the same change, by URL",
  }),
});
type Searched = typeof Searched.Type;

const Filed = Schema.Struct({
  url: Schema.NullOr(text).annotate({
    description: "the issue you filed, or null where Linear refused",
  }),
  refused: Schema.optionalKey(
    text.annotate({ description: "Linear's own words, where it refused" }),
  ),
});

interface Cycled {
  readonly n: number;
  readonly opportunity: string | null;
  readonly tried: string;
  readonly kept: boolean;
  readonly why: string;
  readonly measurement: string | null;
}

const Opened = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  mr_url: Schema.optionalKey(Schema.NullOr(text)),
  pushed: Schema.Boolean,
});

const Snapshot = Schema.Struct({ head_sha: text, fingerprint: text });

const TUNER = "tune";
const MERGE_TRIES = 2;
const IGNORE = "Ignore";
const POST = "Post";

const discover = step({
  id: "discover",
  title: "Discover",
  description:
    "The tuner reads the stack, journeys, telemetry and prior work, and ranks what to try.",
  kind: "agent",
  role: "tuner",
  produces: "evidence",
});
const harness = step({
  id: "harness",
  title: "Harness",
  description: "The tuner commits a benchmark harness and writes the plan it is measured by.",
  kind: "agent",
  role: "tuner",
});
const calibrate = step({
  id: "calibrate",
  title: "Calibrate",
  description: "The host measures the base against itself, to learn this Machine's noise floor.",
  kind: "check",
  produces: "evidence",
});
const cycles = step({
  id: "cycles",
  title: "Cycles",
  description: "One hypothesis a Cycle, kept only where the host measures a gain.",
  kind: "agent",
  role: "tuner",
});
const integrate = step({
  id: "integrate",
  title: "Integrate",
  description: "The default branch merged in, and the final tree measured against the merge base.",
  kind: "check",
  produces: "evidence",
});
const externalReport = step({
  id: "external-report",
  title: "External report",
  description: "What only another repository could change, each put to the human.",
  kind: "question",
});

type Judged = Extract<Measurement["result"], { readonly _tag: "Judged" }>;
type Unjudged = Exclude<Measurement["result"], Judged>;

/** Why calibration rules out proof for each metric it does. */
const unprovable = (plan: Plan, verdicts: Judged["verdicts"]) =>
  plan.metrics.flatMap((metric) => {
    const judged = verdicts.find((one) => one.metric === metric.name);
    if (judged === undefined) return [];
    if (metric.role === "primary" && judged.verdict === "inconclusive")
      return [{ metric: metric.name, why: `${metric.name} is inconclusive against itself` }];
    if (metric.role === "guardrail" && !judged.held)
      return [{ metric: metric.name, why: `guardrail ${metric.name} is not held against itself` }];
    return [];
  });

/** How a Measurement ended without a verdict, naming the tree it ended on. */
const unjudged = (measured: Measurement, result: Unjudged) => {
  const tree = (side: "base" | "candidate") =>
    side === "base"
      ? `the base tree at ${measured.base.commit}`
      : `the candidate tree at ${measured.candidate.head_sha}`;
  switch (result._tag) {
    case "Failed":
      return result.stage === "prepare"
        ? `${tree(result.tree)} could not be built: \`${result.command}\` exited ${result.exit}: ${result.output.trim()}`
        : `\`${result.command}\` failed on ${tree(result.tree)} with exit ${result.exit}: ${result.output.trim()}`;
    case "TimedOut":
      return `\`${result.command}\` outlived the plan's time limit in ${result.stage} on ${tree(result.tree)}`;
    case "Unjudged":
      return `it was not judged: ${result.reason}`;
  }
};

/** Why a Cycle is not kept, or null: its checks pass, its primary gains and every guardrail holds. */
const notKept = (plan: Plan, failed: ReadonlyArray<string>, measured: Measurement) => {
  const whys = failed.length === 0 ? [] : [`checks failed: ${failed.join(", ")}`];
  if (measured.result._tag !== "Judged")
    return [...whys, unjudged(measured, measured.result)].join("; ");
  const { verdicts } = measured.result;
  for (const metric of plan.metrics) {
    const judged = verdicts.find((one) => one.metric === metric.name);
    const verdict = judged?.verdict ?? "no verdict";
    if (metric.role === "primary") {
      if (verdict !== "gain") whys.push(`${metric.name} ${verdict}, not a gain`);
    } else if (judged === undefined || !judged.held || verdict === "inconclusive")
      whys.push(`guardrail ${metric.name} ${verdict}, not held`);
  }
  return whys.length === 0 ? null : whys.join("; ");
};

/** What stopped an integration, as the tuner is told it. */
const stoppedBy = (merged: Integration) =>
  merged.status === "conflicted"
    ? `Collie merged ${merged.ref} (${merged.sha}) into this branch, and the merge stopped on conflicts in: ${merged.files.join(", ")}.`
    : `Collie could not merge ${merged.ref} (${merged.sha}) into this branch: ${merged.reason}.`;

const cycleLine = (one: Cycled) =>
  `Cycle ${one.n}, ${one.tried}: ${one.kept ? "kept" : "not kept"}: ${one.why}${
    one.measurement === null ? "" : ` (${one.measurement})`
  }`;

const telemetryLine = (one: Discovered["telemetry"][number]) =>
  one.status === "used"
    ? `telemetry ${one.source}: used: release ${one.release}, ${one.window}, ${one.sample}, ${one.link}`
    : `telemetry ${one.source}: unavailable: ${one.reason}`;

const researchLine = (one: Discovered["research"][number]) =>
  one.kind === "nothing-found"
    ? `research: nothing found; searched ${one.searched}`
    : `research ${one.link} ${one.effect} ${one.opportunity}`;

const verdictsLine = (measured: Measurement) =>
  measured.result._tag === "Judged"
    ? measured.result.verdicts
        .map((one) => `${one.metric} ${one.verdict}${one.held ? ", held" : ", not held"}`)
        .join("; ")
    : unjudged(measured, measured.result);

/** The findings as the human reads them, every statement marked by what it rests on. */
const reportOf = (options: {
  readonly runId: string;
  readonly ending: string;
  readonly found: Discovered;
  readonly calibrations: ReadonlyArray<Measurement>;
  readonly cycles: ReadonlyArray<Cycled>;
}) => {
  const { found } = options;
  const sourced = (title: string) =>
    found.research.flatMap((one) =>
      one.kind !== "nothing-found" && one.opportunity === title
        ? [`  - ${one.effect} by [${one.title}](${one.link})`]
        : [],
    );
  const ranked = new Set(found.opportunities.map((one) => one.title));
  const ruledOut = [
    ...new Set(
      found.research.flatMap((one) =>
        one.kind !== "nothing-found" && !ranked.has(one.opportunity) ? [one.opportunity] : [],
      ),
    ),
  ];
  const searched = found.research.flatMap((one) =>
    one.kind === "nothing-found" ? [`- Searched, nothing found: ${one.searched}`] : [],
  );
  return [
    `# Tune-up findings: ${options.runId}`,
    "",
    options.ending,
    "",
    "## Stack",
    "",
    `- ${found.stack.join(", ")}`,
    `- Skills loaded: ${found.skills.join(", ") || "none"}`,
    "",
    "## Journeys",
    "",
    ...found.journeys.flatMap((journey) =>
      journey.objectives.map(
        (one) =>
          `- ${journey.name}: ${one.metric}${one.target === undefined ? "" : ` (${one.target})`}, because ${one.why}`,
      ),
    ),
    "",
    "## Telemetry",
    "",
    ...found.telemetry.map((one) => `- ${telemetryLine(one).replace(/^telemetry /, "")}`),
    "",
    "## Opportunities",
    "",
    ...found.opportunities.flatMap((one, at) => [
      `${at + 1}. ${one.title} (${one.evidence}; cites ${one.cites.join(", ")})`,
      ...sourced(one.title),
    ]),
    ...ruledOut.flatMap((title) => [`- Not ranked: ${title}`, ...sourced(title)]),
    ...searched,
    "",
    "## Calibration (measured)",
    "",
    ...options.calibrations.map((one) => `- ${one.id}: ${verdictsLine(one)}`),
    ...(options.cycles.length === 0
      ? []
      : ["", "## Cycles (measured)", "", ...options.cycles.map((one) => `- ${cycleLine(one)}`)]),
    "",
  ].join("\n");
};

/** Stable across Runs, so a later Run's search finds the issue an earlier one filed. */
const keyOf = (one: External) =>
  `external-${(Hash.string(`${one.repository}\n${one.change}`) >>> 0).toString(16).padStart(8, "0")}`;
const markerOf = (key: string) => `collie:${key}`;

/** One external finding as the human reads it, in the report and in its question. */
const previewOf = (one: External, key: string) =>
  redact(
    [
      `### ${one.title}`,
      "",
      `- Repository: ${one.repository}`,
      `- Team: ${one.team ?? "unknown"}`,
      `- Journey: ${one.journey}`,
      `- Change needed: ${one.change}`,
      `- Estimated impact, not measured: ${one.estimated_impact}`,
      `- How it relates to the local change: ${one.relation}`,
      `- Evidence: ${one.links.join(", ") || "none"}`,
      ...(one.existing === undefined ? [] : [`- Existing issue: ${one.existing}`]),
      "- Acceptance criteria:",
      ...one.criteria.map((criterion) => `  - ${criterion}`),
      `- Key: ${key}, carried by its issue as ${markerOf(key)}`,
    ].join("\n"),
  );

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One side's judged samples of one metric, in the order they were taken. */
const readingsOf = (measured: Measurement, metric: string, side: "base" | "candidate") =>
  measured.samples.flatMap((one) => {
    const value = one.readings[metric];
    return one.tree !== side || one.warmup || value === undefined ? [] : [value];
  });

const commandLine = (command: {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
}) => [command.executable, ...command.argv].join(" ");

const tableOf = (measured: Measurement) => [
  "| Metric | Role | Base | Candidate | Ratio | 95% interval | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...measured.plan.metrics.map((metric) => {
    const judged =
      measured.result._tag === "Judged"
        ? measured.result.verdicts.find((one) => one.metric === metric.name)
        : undefined;
    const sides = (["base", "candidate"] as const).map((side) =>
      String(median(readingsOf(measured, metric.name, side))),
    );
    return judged === undefined
      ? `| ${metric.name} | ${metric.role} | ${sides.join(" | ")} | | | ${verdictsLine(measured)} |`
      : `| ${metric.name} | ${metric.role} | ${sides.join(" | ")} | ${judged.ratio.toFixed(3)} | [${judged.interval.map((bound) => bound.toFixed(3)).join(", ")}] | ${judged.verdict}${judged.held ? "" : ", not held"} |`;
  }),
];

/**
 * The merge request's description, written from the host's Measurements rather than from
 * an agent's numbers, with every credential-shaped value taken out.
 */
const bodyOf = (got: {
  readonly runId: string;
  readonly final: Measurement;
  readonly original: Measurement | null;
  readonly finals: ReadonlyArray<Measurement>;
  readonly plans: ReadonlyArray<string>;
  readonly planFile: string;
  readonly written: typeof Harnessed.Type;
  readonly found: Discovered;
  readonly cycles: ReadonlyArray<Cycled>;
  readonly evidence: string;
  readonly review: SynthesisReport;
}) => {
  const { final, found } = got;
  const plan = final.plan;
  const primary = plan.metrics.find((one) => one.role === "primary")?.name ?? "";
  const guardrails = plan.metrics.filter((one) => one.role === "guardrail");
  const verdictOf = (metric: string) =>
    final.result._tag === "Judged"
      ? final.result.verdicts.find((one) => one.metric === metric)
      : undefined;
  const kept = new Set(
    got.cycles.flatMap((one) => (one.kept && one.opportunity !== null ? [one.opportunity] : [])),
  );
  const left = found.opportunities.filter((one) => !kept.has(one.title));
  const said = (field: "behavior_preserved" | "measurement_valid") =>
    `${field}: ${got.review[field] === true}`;
  return redact(
    [
      `## Tune-up: ${primary} ${verdictOf(primary)?.verdict ?? "unjudged"} against the merge base`,
      "",
      `The host's \`final\` Measurement ${final.id}, on ${final.machine}, compares ${final.base.commit} with the harness applied against this branch at ${final.candidate.head_sha}.`,
      "",
      ...tableOf(final),
      ...(got.original === null
        ? []
        : [
            "",
            `Against the base the Run started from, ${got.original.base.commit} (\`final\` Measurement ${got.original.id}):`,
            "",
            ...tableOf(got.original),
          ]),
      "",
      "### Commands and harness",
      "",
      ...plan.commands.map((one) => `- ${one.name}: \`${commandLine(one)}\``),
      ...(plan.prepare === null
        ? []
        : [`- Prepared once per tree: \`${commandLine(plan.prepare)}\``]),
      `- Harness commits ${plan.harness.commits.join(", ")}, touching only ${plan.harness.paths.join(", ")}`,
      "",
      "### Regressions and tradeoffs",
      "",
      ...guardrails.map((one) => {
        const judged = verdictOf(one.name);
        return `- Guardrail ${one.name}: ${judged === undefined ? "unjudged" : `${judged.verdict}, ${judged.held ? "held" : "not held"}, worse bound ${judged.interval[one.direction === "lower" ? 1 : 0].toFixed(3)}`}`;
      }),
      ...got.cycles.filter((one) => !one.kept).map((one) => `- Not kept: ${cycleLine(one)}`),
      "",
      "### Tests and review",
      "",
      got.evidence,
      `- Review: ${said("behavior_preserved")}, ${said("measurement_valid")}. ${got.review.summary}`,
      "",
      "### Opportunities left",
      "",
      ...(left.length === 0
        ? ["- None ranked."]
        : left.map((one) => `- ${one.title} (${one.evidence})`)),
      "",
      "### What to monitor after deploying",
      "",
      ...found.journeys.flatMap((journey) =>
        journey.objectives.map(
          (one) =>
            `- ${journey.name}: ${one.metric}${one.target === undefined ? "" : ` (${one.target})`}, because ${one.why}`,
        ),
      ),
      "",
      "<details>",
      "<summary>Evidence to audit and reproduce</summary>",
      "",
      `#### Samples of \`final\` Measurement ${final.id}`,
      "",
      ...plan.metrics.flatMap((metric) =>
        (["base", "candidate"] as const).map(
          (side) => `- ${metric.name}, ${side}: ${readingsOf(final, metric.name, side).join(", ")}`,
        ),
      ),
      "",
      "#### The frozen plan",
      "",
      `- Journeys ${got.written.journeys.join(", ")}; cases ${got.written.cases.join(", ") || "none"}`,
      ...plan.commands.map((one) => `- Command ${one.name}: \`${commandLine(one)}\``),
      `- Warmup ${plan.warmup}, ${plan.samples} samples per side, threshold ${plan.threshold}%, tolerance ${plan.tolerance}%`,
      ...Object.entries(final.environment).map(
        ([command, environment]) => `- Environment of ${command}: ${environment ?? "unread"}`,
      ),
      ...(["base", "candidate"] as const).map((side) => {
        const lockfiles = Object.entries(final[side].lockfiles);
        return `- Lockfiles of the ${side}: ${lockfiles.map(([file, digest]) => `${file} ${digest}`).join(", ") || "none"}`;
      }),
      `- Harness commits ${plan.harness.commits.join(", ")}, under ${plan.harness.paths.join(", ")}`,
      `- Base: ${final.base.commit}, with the harness at ${final.base.head_sha}`,
      `- Candidate: ${final.candidate.head_sha}`,
      "",
      "#### Every plan and every `final` Measurement",
      "",
      ...got.plans.map((reason, at) => `- Plan ${at + 1}: ${reason}`),
      ...got.finals.map(
        (one) =>
          `- ${one.id}: ${one.base.commit} against ${one.candidate.head_sha}: ${verdictsLine(one)}`,
      ),
      "",
      "#### Reproduce",
      "",
      "```sh",
      `git checkout ${final.candidate.head_sha}`,
      `collie measure --run ${got.runId} --base ${final.base.commit} --plan ${got.planFile} --pass final`,
      "```",
      "",
      `The full record is kept with Run ${got.runId}.`,
      "",
      "</details>",
      "",
    ].join("\n"),
  );
};

export default defineWorkflow({
  id: "tune-up",
  title: "tune-up — make a repository measurably faster",
  description:
    "Reads a repository and its telemetry, commits a benchmark harness, and keeps only the changes the host measures as a gain with no guardrail regression. It ends in a merge request only where the final tree proves the gain against its merge base, and otherwise with its findings.",
  input: Schema.Struct({
    repository: Schema.optionalKey(
      text.annotate({
        description:
          "The checkout to tune: the one the Run is started in. From Home, a URL places it in the local checkout that URL names; a tune-up never clones.",
        default: "",
      }),
    ),
    focus: Schema.optionalKey(
      text.annotate({
        description: "A journey, endpoint or page to spend the Cycles on; empty is the whole",
        default: "",
      }),
    ),
    cycles: Schema.optionalKey(
      Whole.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
        description: "How many Cycles at most, from 1 to 20; a reverted one counts",
        default: DEFAULTS.cycles,
      }),
    ),
    threshold: Schema.optionalKey(
      Percent.annotate({
        description: "The smallest gain, in percent, that counts",
        default: DEFAULTS.threshold,
      }),
    ),
    tolerance: Schema.optionalKey(
      Percent.annotate({
        description: "How far, in percent, a guardrail may worsen and still hold",
        default: DEFAULTS.tolerance,
      }),
    ),
    samples: Schema.optionalKey(
      Whole.check(Schema.isGreaterThanOrEqualTo(2)).annotate({
        description: "Samples per side of each Measurement",
        default: DEFAULTS.samples,
      }),
    ),
    wall_time: Schema.optionalKey(
      text
        .annotate({
          description: "A duration after which no new Cycle starts; empty is none",
          default: "",
        })
        .check(isDuration),
    ),
    external: Schema.optionalKey(
      Schema.Literals(["ask", "report", "off"]).annotate({
        description:
          "ask puts each external finding to the human, report only writes them, off collects none",
        default: DEFAULTS.external,
      }),
    ),
  }),
  output: Schema.String,
  agents: { roles: { tuner: IMPLEMENTER, reviewer: REVIEWER } },
  hints: { repository: "repository" },
  path: [
    discover,
    harness,
    calibrate,
    cycles,
    integrate,
    reviewRound,
    gate,
    mergeRequest,
    externalReport,
  ],
  checkout: "branch",
  outcome: { fixed: "performance" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const started = yield* Activity.make({
        name: "started",
        success: Schema.Number,
        execute: Clock.currentTimeMillis,
      });
      const place = yield* host.place(runId);
      const cwd = place.cwd;
      const budget = {
        cycles: input.cycles ?? DEFAULTS.cycles,
        threshold: input.threshold ?? DEFAULTS.threshold,
        tolerance: input.tolerance ?? DEFAULTS.tolerance,
        samples: input.samples ?? DEFAULTS.samples,
        wall_time: input.wall_time ?? "",
        external: input.external ?? DEFAULTS.external,
      };
      yield* host.record(
        runId,
        `budget: cycles ${budget.cycles}, threshold ${budget.threshold}%, tolerance ${budget.tolerance}%, samples ${budget.samples}, wall time ${budget.wall_time || "none"}, external ${budget.external}`,
      );
      const told = { inputs: { focus: input.focus ?? "" }, run: { dir: place.dir, id: runId } };

      const found = yield* discover(
        agentWork({
          operation: "discover",
          agent: TUNER,
          role: "tuner",
          instructions: prompts.discover,
          input: told,
          output: Discovered,
        }),
      );
      for (const one of found.telemetry) yield* host.record(runId, telemetryLine(one));
      for (const one of found.research) yield* host.record(runId, researchLine(one));

      const written = yield* harness(
        agentWork({
          operation: "harness",
          agent: TUNER,
          role: "tuner",
          instructions: prompts.harness,
          input: {
            ...told,
            discovered: [
              ...found.journeys.map((one) => `- journey: ${one.name}`),
              ...found.opportunities.map((one, at) => `${at + 1}. ${one.title} (${one.evidence})`),
            ].join("\n"),
            budget: {
              samples: String(budget.samples),
              threshold: String(budget.threshold),
              tolerance: String(budget.tolerance),
            },
          },
          output: Harnessed,
        }),
      );

      let plans = 0;
      const reasons: string[] = [];
      const recordPlan = (plan: Plan, reason: string) =>
        Effect.gen(function* () {
          plans += 1;
          reasons.push(reason);
          const planned = yield* Activity.make({
            name: `plan.${plans}`,
            success: Planned,
            execute: Effect.succeed({ plan, reason }),
          });
          yield* host.record(runId, `benchmark plan ${plans}: ${reason}`);
          return planned.plan;
        });
      let plan = yield* recordPlan(
        {
          harness: written.harness,
          prepare: written.prepare,
          commands: written.commands,
          metrics: Arr.map(written.metrics, ({ name, direction, role }) => ({
            name,
            direction,
            role,
          })),
          warmup: written.warmup,
          samples: budget.samples,
          threshold: budget.threshold,
          tolerance: budget.tolerance,
        },
        "written by Harness",
      );

      const base = yield* Activity.make({
        name: "base",
        success: Schema.NullOr(text),
        execute: Effect.map(host.evidence(runId, cwd), (got) => got.mergeBase ?? null),
      });
      if (base === null)
        return yield* new WorkflowError({
          reason: `${cwd} has no merge base with its default branch to measure against`,
        });

      const calibrations: Measurement[] = [];
      let ending: string | null = null;
      let calibrated = false;
      for (;;) {
        const measured = yield* calibrate(
          Activity.make({
            name: `calibration.${calibrations.length + 1}`,
            success: MeasurementSchema,
            error: WorkflowError,
            execute: Effect.map(
              host.measure({ runId, base, cwd, plan, reason: reasons.at(-1), pass: "calibration" }),
              (answered) => answered.measurement,
            ),
          }),
        );
        calibrations.push(measured);
        if (measured.result._tag !== "Judged")
          return yield* new WorkflowError({
            reason: `calibration ${measured.id} ended without a verdict: ${unjudged(measured, measured.result)}`,
          });
        if (measured.base.content !== measured.candidate.content)
          return yield* new WorkflowError({
            reason: `calibration ${measured.id} did not measure the base against itself: ${cwd} at ${measured.candidate.head_sha} holds more than the harness commits ${plan.harness.commits.join(", ")}`,
          });
        const lost = unprovable(plan, measured.result.verdicts);
        if (lost.length === 0) {
          const primary = plan.metrics.find((one) => one.role === "primary")?.name ?? "";
          ending = `calibrated on ${primary} (calibration ${measured.id})`;
          calibrated = true;
          break;
        }
        const counters = lost.map((one) => ({
          ...one,
          counter: written.metrics.find((metric) => metric.name === one.metric)?.counter,
        }));
        if (counters.some((one) => one.counter === undefined)) {
          ending = `proof unavailable: ${lost.map((one) => one.why).join("; ")} (calibration ${measured.id})`;
          break;
        }
        const switched = counters.map(
          (one) => `switched ${one.metric} to its counter ${one.counter?.name}: ${one.why}`,
        );
        plan = yield* recordPlan(
          {
            ...plan,
            metrics: Arr.map(plan.metrics, (metric) => {
              const counter = counters.find((one) => one.metric === metric.name)?.counter;
              return counter === undefined ? metric : { ...counter, role: metric.role };
            }),
          },
          switched.join("; "),
        );
      }
      yield* host.record(runId, ending);

      const cycled: Cycled[] = [];
      const keptCommits: Array<string> = [];
      const findings = (name: string, ending: string) =>
        Activity.make({
          name,
          success: text,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const file = `${place.dir}/handoffs/tune-up-findings.md`;
            yield* fs.makeDirectory(`${place.dir}/handoffs`, { recursive: true });
            yield* fs.writeFileString(
              file,
              reportOf({ runId, ending, found, calibrations, cycles: cycled }),
            );
            return file;
          }).pipe(
            Effect.mapError(
              (cause) =>
                new WorkflowError({
                  reason: `the findings could not be written: ${cause.message}`,
                }),
            ),
          ),
        });
      const handed: External[] = [...found.external];
      const recorded = (name: string, line: string) =>
        Activity.make({ name, success: Schema.Void, execute: host.record(runId, line) });
      /** One finding settled: recorded as existing, ignored, or posted once to Linear. */
      const settle = (key: string, one: External) =>
        Effect.gen(function* () {
          const decided = `${key}.decided`;
          if (one.existing !== undefined)
            return yield* recorded(decided, `external ${key}: existing ${one.existing}`);
          const finding = previewOf(one, key);
          const team =
            one.team ??
            (yield* ask({
              name: `${key}-team`,
              prompt: `${finding}\n\nWhich Linear team owns ${one.repository}?`,
            }));
          const posting = { ...told, finding, marker: markerOf(key), team };
          const search = (operation: string) =>
            agentWork({
              operation,
              agent: TUNER,
              role: "tuner",
              instructions: prompts.externalSearch,
              input: { ...posting, repository: one.repository },
              output: Searched,
            });
          const foundIn = (searched: Searched, filedHere: boolean) =>
            searched.marked !== null
              ? `external ${key}: ${filedHere ? "posted" : "existing"} ${searched.marked}`
              : searched.matching.length > 0
                ? `external ${key}: existing ${searched.matching.join(", ")}`
                : null;
          const launches = `${place.dir}/external`;
          const marked = (operation: string, state: string) =>
            Activity.make({
              name: `${operation}.${state}`,
              success: Schema.Void,
              error: WorkflowError,
              execute: Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                yield* fs.makeDirectory(launches, { recursive: true });
                yield* fs.writeFileString(`${launches}/${operation}`, state);
              }).pipe(Effect.mapError((cause) => new WorkflowError({ reason: cause.message }))),
            });
          let again = false;
          for (let n = 1; ; n++) {
            const named = (base: string) => (n === 1 ? base : `${base}-${n}`);
            const chosen = yield* ask({
              name: named(key),
              prompt: again
                ? `An earlier Post of this finding may have filed it: a search found no issue carrying ${markerOf(key)}, so Post files one now.\n\n${finding}`
                : finding,
              options: [IGNORE, POST],
            });
            if (chosen !== POST) return yield* recorded(decided, `external ${key}: ignored`);
            const known = foundIn(yield* search(named(`${key}-search`)), false);
            if (known !== null) return yield* recorded(decided, known);
            const creating = named(`${key}-create`);
            // Read on every replay: a create launched whose Output was never collected is
            // never collected now, since a new agent given its prompt could file twice.
            const state = yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.readFileString(`${launches}/${creating}`)),
              Effect.orElseSucceed(() => ""),
            );
            if (state !== "launched") {
              yield* marked(creating, "launched");
              const filed = yield* agentWork({
                operation: creating,
                agent: TUNER,
                role: "tuner",
                instructions: prompts.externalCreate,
                input: posting,
                output: Filed,
              });
              yield* marked(creating, "collected");
              return yield* recorded(
                decided,
                filed.url === null
                  ? `external ${key}: not filed: ${filed.refused ?? "Linear refused it"}`
                  : `external ${key}: posted ${filed.url}`,
              );
            }
            const refound = foundIn(yield* search(named(`${key}-recheck`)), true);
            if (refound !== null) return yield* recorded(decided, refound);
            again = true;
          }
        });
      /** The Run's end, after what only another repository could change is handed on. */
      const handOn = (ending: string) =>
        Effect.gen(function* () {
          const keyed = Arr.dedupeWith(
            handed.map((one) => ({ key: keyOf(one), one })),
            (one, other) => one.key === other.key,
          );
          if (budget.external === "off" || keyed.length === 0) return ending;
          yield* externalReport(
            Effect.gen(function* () {
              const file = `${place.dir}/handoffs/tune-up-external.md`;
              yield* Activity.make({
                name: "external.report",
                success: Schema.Void,
                error: WorkflowError,
                execute: Effect.gen(function* () {
                  const fs = yield* FileSystem.FileSystem;
                  yield* fs.makeDirectory(`${place.dir}/handoffs`, { recursive: true });
                  yield* fs.writeFileString(
                    file,
                    [
                      `# Tune-up external findings: ${runId}`,
                      "",
                      "Improvements only another repository can make. None is assumed done: no Measurement, outcome or merge readiness counts on any of them.",
                      "",
                      ...keyed.flatMap(({ key, one }) => [previewOf(one, key), ""]),
                    ].join("\n"),
                  );
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new WorkflowError({
                        reason: `the external report could not be written: ${cause.message}`,
                      }),
                  ),
                ),
              });
              if (budget.external === "report")
                return yield* recorded("external.unasked", `${file}: written, nothing asked`);
              const linear = yield* Activity.make({
                name: "external.linear",
                success: Schema.Struct({ reachable: Schema.Boolean, detail: text }),
                execute: host.linear(cwd),
              });
              if (!linear.reachable)
                return yield* recorded("external.unasked", `${file} not asked: ${linear.detail}`);
              for (const { key, one } of keyed) yield* settle(key, one);
            }),
          );
          return ending;
        });
      if (!calibrated) {
        const report = yield* findings("findings", ending);
        return yield* handOn(`${report}: ${ending}`);
      }

      const wall =
        budget.wall_time === ""
          ? null
          : Duration.toMillis(
              Schema.decodeUnknownSync(Schema.DurationFromString)(budget.wall_time),
            );
      const opportunities =
        found.opportunities
          .map(
            (one, at) => `${at + 1}. ${one.title} (${one.evidence}; cites ${one.cites.join(", ")})`,
          )
          .join("\n") || "None ranked.";
      const metrics = plan.metrics
        .map((one) => `${one.name}, ${one.role}, ${one.direction} is better`)
        .join("; ");
      const sameTree = (one: typeof Tree.Type, other: typeof Tree.Type) =>
        one.head === other.head && one.fingerprint === other.fingerprint;
      const treeNow = Effect.map(host.evidence(runId, cwd), ({ final }) => ({
        head: final.head_sha,
        fingerprint: final.fingerprint,
      }));
      // Checks left to CI are proved by its pipeline, not here.
      const failingChecks = (name: string) =>
        Activity.make({
          name,
          success: Schema.Array(text),
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const failing: string[] = [];
            for (const spec of owedLocally(yield* host.approved(runId))) {
              const ran = yield* host.verify({ runId, name: spec.name, cwd, pass: "gate" });
              if (ran.result !== "pass") failing.push(spec.name);
            }
            return failing;
          }),
        });
      const judging = (n: number, base: string) =>
        Effect.gen(function* () {
          const failed = yield* failingChecks(`cycle-${n}.checks`);
          const measured = yield* cycles(
            Activity.make({
              name: `cycle-${n}.measure`,
              success: MeasurementSchema,
              error: WorkflowError,
              execute: Effect.map(
                host.measure({
                  runId,
                  base,
                  cwd,
                  plan,
                  reason: reasons.at(-1),
                  pass: `cycle ${n}`,
                }),
                (answered) => answered.measurement,
              ),
            }),
          );
          return { why: notKept(plan, failed, measured), measurement: measured.id };
        });
      let stopped: string | null = null;
      let unkept = 0;
      for (let n = 1; n <= budget.cycles && stopped === null; n++) {
        const begun = yield* Activity.make({
          name: `cycle-${n}.start`,
          success: Schema.Struct({ spent: Schema.NullOr(text), tree: Tree }),
          execute: Effect.gen(function* () {
            const tree = yield* treeNow;
            if (wall !== null && (yield* Clock.currentTimeMillis) - started >= wall)
              return {
                spent: `wall time ${budget.wall_time} spent ${n === 1 ? "before Cycle 1" : `after Cycle ${n - 1}`}`,
                tree,
              };
            yield* host.record(runId, `cycle ${n} started on ${tree.head} ${tree.fingerprint}`);
            return { spent: null, tree };
          }),
        });
        if (begun.spent !== null) {
          stopped = begun.spent;
          break;
        }
        const start = begun.tree;
        const tried = yield* cycles(
          agentWork({
            operation: `cycle-${n}`,
            agent: TUNER,
            role: "tuner",
            instructions: prompts.cycle,
            input: {
              ...told,
              cycle: { n: String(n), of: String(budget.cycles), start: start.head },
              opportunities,
              earlier: cycled.map((one) => `- ${cycleLine(one)}`).join("\n") || "None yet.",
              metrics,
            },
            output: Tried,
          }),
        );
        handed.push(...(tried.external ?? []));
        if (tried.result !== "changed")
          stopped =
            tried.result === "exhausted"
              ? `no measured opportunity is left: ${tried.why}`
              : `an unsafe tradeoff was named: ${tried.tradeoff}`;
        const judged =
          tried.result === "changed"
            ? yield* judging(n, start.head)
            : { why: stopped, measurement: null };
        const kept = judged.why === null;
        if (kept && tried.result === "changed") keptCommits.push(...tried.commits);
        if (!kept) {
          const why = judged.why ?? "";
          const movedTo = yield* Activity.make({
            name: `cycle-${n}.moved`,
            success: Schema.NullOr(text),
            execute: Effect.map(treeNow, (now) => (sameTree(now, start) ? null : now.head)),
          });
          if (movedTo !== null)
            yield* cycles(
              agentWork({
                operation: `cycle-${n}-revert`,
                agent: TUNER,
                role: "tuner",
                instructions: prompts.revert,
                input: {
                  ...told,
                  cycle: {
                    n: String(n),
                    start: start.head,
                    end: movedTo,
                    commits: tried.result === "changed" ? tried.commits.join(", ") : "none",
                  },
                  why,
                },
              }),
            );
          yield* Activity.make({
            name: `cycle-${n}.reverted`,
            success: Schema.Void,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const now = yield* treeNow;
              if (!sameTree(now, start))
                return yield* new WorkflowError({
                  reason: `cycle ${n} was reverted to ${now.head} (${now.fingerprint}), not the tree it started on, ${start.head} (${start.fingerprint})`,
                });
              yield* host.record(
                runId,
                `cycle ${n} reverted to ${now.head} ${now.fingerprint}: ${why}`,
              );
            }),
          });
        }
        const done: Cycled = {
          n,
          opportunity: tried.result === "changed" ? tried.opportunity : null,
          tried:
            tried.result === "changed" ? `${tried.opportunity}: ${tried.change}` : tried.result,
          kept,
          why: judged.why ?? "every guardrail held, and the primary gained",
          measurement: judged.measurement,
        };
        cycled.push(done);
        unkept = kept ? 0 : unkept + 1;
        yield* findings(`cycle-${n}.findings`, cycleLine(done));
        if (stopped === null && unkept >= 2) stopped = "two consecutive Cycles were not kept";
      }
      const stop = stopped ?? `cycles spent: ${budget.cycles} of ${budget.cycles}`;
      const kept = cycled.filter((one) => one.kept).map((one) => `Cycle ${one.n}`);
      yield* host.record(runId, `stopped: ${stop}`);
      if (kept.length === 0) {
        const done = `${stop}; no Cycle was kept, so the Run is back on its base tree`;
        const report = yield* findings("findings", done);
        return yield* handOn(`${report}: ${done}`);
      }
      const findingsOf = (name: string, ending: string) =>
        Effect.map(findings(name, ending), (report) => `${report}: ${ending}`);

      const agents = yield* Agents;
      const checksNow = Effect.map(host.approved(runId), renderApproved);
      const report = `${place.dir}/handoffs/tune-up-findings.md`;
      const delivering = {
        inputs: { focus: told.inputs.focus, outcome: "performance" },
        run: told.run,
        verify: yield* checksNow,
        body: `${place.dir}/handoffs/tune-up-merge-request.md`,
      };
      let finals = 0;
      const measureFinal = Effect.suspend(() => {
        finals += 1;
        return Activity.make({
          name: `final.${finals}`,
          success: MeasurementSchema,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const { mergeBase } = yield* host.evidence(runId, cwd);
            if (mergeBase === null || mergeBase === undefined)
              return yield* new WorkflowError({
                reason: `${cwd} has no merge base with its default branch to measure against`,
              });
            const { measurement, ran } = yield* host.measure({
              runId,
              base: mergeBase,
              cwd,
              plan,
              reason: reasons.at(-1),
              pass: "final",
            });
            if (ran)
              yield* host.record(
                runId,
                `final Measurement ${measurement.id} of ${measurement.candidate.head_sha} against ${mergeBase}: ${verdictsLine(measurement)}`,
              );
            return measurement;
          }),
        });
      });
      let integrations = 0;
      let reviewBase = "";
      const integrated = (operation: string) =>
        Effect.gen(function* () {
          const integrateNow = Effect.suspend(() => {
            integrations += 1;
            return Activity.make({
              name: `integrate.${integrations}`,
              success: IntegrationSchema,
              execute: host.integrate(runId, cwd),
            });
          });
          const settled = (done: Integration) =>
            done.status === "unchanged" || done.status === "merged";
          let merged = yield* integrateNow;
          for (
            let tries = 1;
            tries <= MERGE_TRIES && merged.status !== "unavailable" && !settled(merged);
            tries++
          ) {
            yield* agentWork({
              operation: tries === 1 ? operation : `${operation}-${tries}`,
              agent: TUNER,
              role: "tuner",
              instructions: prompts.merge,
              input: { ...told, conflict: stoppedBy(merged) },
            });
            merged = yield* integrateNow;
          }
          if (!settled(merged))
            return yield* new WorkflowError({
              reason: `${merged.ref || merged.branch || "the default branch"} is not integrated, so the Run stops: ${stoppedBy(merged)}`,
            });
          if (merged.sha !== "") reviewBase = merged.sha;
          return { ...merged, base: reviewBase };
        });
      let reviewed = 0;
      const reviewedTree = Effect.suspend(() => {
        reviewed += 1;
        return Activity.make({
          name: `reviewed-on.${reviewed}`,
          success: Snapshot,
          execute: Effect.map(host.evidence(runId, cwd), ({ final }) => final),
        });
      });
      const reviewOf = (prefix: string, answered: string) =>
        Effect.gen(function* () {
          yield* measureFinal;
          const on = yield* reviewedTree;
          const synthesis = yield* reviewPass({
            target: "",
            plan: report,
            proves: "performance",
            previous: `${place.dir}/review.md`,
            answered,
            risks: "",
            criteria: "",
            base: reviewBase,
            at: 1,
            of: 1,
            disputed: [],
            prefix,
            obstacle: REVIEWING,
          });
          return { reviewed: synthesis, on };
        });
      const lost = (measured: Measurement) => notKept(plan, [], measured);
      const dropped = (measured: Measurement, why: string) =>
        Effect.gen(function* () {
          const movedTo = yield* Activity.make({
            name: "drop.moved",
            success: Schema.NullOr(text),
            execute: Effect.map(host.evidence(runId, cwd), (got) =>
              got.content === measured.base.content ? null : got.final.head_sha,
            ),
          });
          if (movedTo !== null)
            yield* integrate(
              agentWork({
                operation: "drop",
                agent: TUNER,
                role: "tuner",
                instructions: prompts.drop,
                input: {
                  ...told,
                  base: { merge: measured.base.commit, tree: measured.base.head_sha },
                  head: movedTo,
                  commits: [...plan.harness.commits, ...keptCommits].join(", "),
                  why,
                },
              }),
            );
          yield* Activity.make({
            name: "dropped",
            success: Schema.Void,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const evidence = yield* host.evidence(runId, cwd);
              const back = endsWithoutPatchOf({
                kind: "performance",
                evidence,
                approved: yield* host.approved(runId),
                outputs: {},
                reviewed: [],
                roots: [place.dir],
                tickets: [],
              });
              if (!back)
                return yield* new WorkflowError({
                  reason: `the change was dropped to ${evidence.final.head_sha} (${evidence.content ?? "no tree"}), not the base tree ${measured.base.head_sha} (${measured.base.content})`,
                });
              yield* host.record(
                runId,
                `dropped back to the base tree ${measured.base.head_sha}: ${why}`,
              );
            }),
          });
          return yield* findingsOf(
            "findings",
            `the final Measurement ${measured.id} against ${measured.base.commit}: ${why}; the change was dropped back to the base tree, so no merge request is opened`,
          );
        });

      const proved = yield* integrate(
        Effect.gen(function* () {
          yield* integrated("merge");
          const measured = yield* measureFinal;
          const why = lost(measured);
          if (why !== null) return { measured, why, original: null };
          const original =
            measured.base.commit === base
              ? null
              : yield* Activity.make({
                  name: "final.original",
                  success: MeasurementSchema,
                  error: WorkflowError,
                  execute: Effect.map(
                    host.measure({ runId, base, cwd, plan, reason: reasons.at(-1), pass: "final" }),
                    (answered) => answered.measurement,
                  ),
                });
          return { measured, why, original };
        }),
      );
      if (proved.why !== null) return yield* handOn(yield* dropped(proved.measured, proved.why));
      yield* findings("findings.integrated", `${stop}; kept ${kept.join(", ")}`);

      const reviewedOn: Array<typeof Snapshot.Type> = [];
      const rallied = yield* rally({
        rounds: { n: 0 },
        cwd,
        plan: report,
        proves: Effect.succeed("performance"),
        risks: "",
        criteria: "",
        prefix: "",
        obstacle: REVIEWING,
        integrate: (operation) =>
          Effect.gen(function* () {
            const merged = yield* integrated(operation);
            yield* measureFinal;
            reviewedOn.push(yield* reviewedTree);
            return merged;
          }),
        fix: ({ operation, at, findings }) =>
          agentWork({
            operation,
            agent: TUNER,
            role: "tuner",
            instructions: prompts.fix,
            input: {
              ...delivering,
              iteration: String(at),
              max_iterations: String(ROUNDS),
              findings,
            },
            output: FixOutputSchema,
          }),
      });
      const on = reviewedOn.at(-1);
      if (rallied.halted !== null || on === undefined)
        return yield* new WorkflowError({ reason: rallied.halted ?? "the rally reviewed nothing" });
      let latest = { reviewed: rallied.reviewed, on };
      const last = yield* measureFinal;
      const gone = lost(last);
      if (gone !== null) return yield* handOn(yield* dropped(last, gone));

      const bodyNow = Effect.gen(function* () {
        const evidence = yield* host.evidence(runId, cwd);
        const taken = (evidence.measurements ?? []).filter((one) => one.pass === "final");
        const final = taken.findLast((one) => one.base.commit === evidence.mergeBase);
        if (final === undefined)
          return yield* new WorkflowError({
            reason: "no `final` Measurement against the merge base to write the merge request from",
          });
        const fs = yield* FileSystem.FileSystem;
        const planFile = `${place.dir}/handoffs/tune-up-plan.json`;
        yield* fs.writeFileString(
          planFile,
          Schema.encodeSync(Schema.fromJsonString(Planned.fields.plan))(plan),
        );
        const body = bodyOf({
          runId,
          final,
          original: proved.original,
          finals: taken,
          plans: reasons,
          planFile,
          written,
          found,
          cycles: cycled,
          evidence: renderEvidence(evidence),
          review: latest.reviewed,
        });
        yield* fs.writeFileString(delivering.body, body);
        return body;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowError({
              reason: `the merge request body could not be written: ${cause.message}`,
            }),
        ),
      );
      let bodies = 0;
      const writeBody = Effect.suspend(() => {
        bodies += 1;
        return Activity.make({
          name: `merge-request-body.${bodies}`,
          success: text,
          error: WorkflowError,
          execute: bodyNow,
        });
      });
      yield* writeBody;

      // Taken inside delivery's proof Activity, which a replay skips, so it is kept to be read back.
      const proofReview = `${place.dir}/proof-review.json`;
      const ProofReview = Schema.fromJsonString(
        Schema.Struct({ reviewed: SynthesisSchema, on: Snapshot }),
      );
      let ciMoved = false;

      const delivered = yield* deliver({
        cwd,
        source: { value: told.inputs.focus, kind: "text" },
        agent: TUNER,
        role: "tuner",
        input: delivering,
        checksNow,
        prompts: { fix: prompts.fix, ciFix: prompts.ciFix, mr: prompts.mr },
        opened: Opened,
        outcome: Effect.succeed("performance"),
        outcomeJournaled: Effect.succeed("performance"),
        outputs: () => ({}),
        tickets: [],
        roots: [place.dir, cwd],
        rallied: { ...rallied, on: latest.on },
        unsettled: [],
        integrate: integrated,
        review: Effect.succeed((answered: string) =>
          Effect.gen(function* () {
            latest = yield* reviewOf("proof.", answered);
            yield* FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) =>
                fs.writeFileString(proofReview, Schema.encodeSync(ProofReview)(latest)),
              ),
              Effect.orDie,
            );
            yield* bodyNow;
            return latest.reviewed;
          }),
        ),
        moved: ({ pass, round }) =>
          Effect.gen(function* () {
            const fix = `${pass}-fix-${round}`;
            if (pass === "ci") ciMoved = true;
            // The gate runs its own checks again after its fix; a CI fix's tree has none yet.
            if (pass === "ci") yield* failingChecks(`${fix}.checks`);
            // A gate fix's review is already the gate's work; a CI fix's is a review round of its own.
            const again = reviewOf(`${fix}.`, agents.outputFor(runId, fix));
            latest = yield* pass === "ci" ? reviewRound(again) : again;
            const body = yield* writeBody;
            if (pass === "ci")
              yield* Activity.make({
                name: `${fix}.noted`,
                success: Schema.Void,
                execute: Effect.asVoid(
                  host.note({
                    runId,
                    cwd,
                    body: `${fix} moved the head; measured again:\n\n${body}`,
                  }),
                ),
              });
            return latest;
          }),
      });
      if (delivered.nothing !== undefined) return yield* handOn(delivered.nothing);
      if (!ciMoved) {
        const kept = yield* FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.readFileString(proofReview)),
          Effect.flatMap(Schema.decodeUnknownEffect(ProofReview)),
          Effect.option,
        );
        if (Option.isSome(kept)) latest = kept.value;
      }
      const gaps = yield* Activity.make({
        name: "outcome",
        success: Schema.Struct({ head: text, gaps: Schema.Array(text) }),
        execute: Effect.gen(function* () {
          const evidence = yield* host.evidence(runId, cwd);
          return {
            head: evidence.final.head_sha,
            gaps: evidenceGapsOf({
              kind: "performance",
              evidence,
              approved: yield* host.approved(runId),
              outputs: { synthesize: { ...latest.reviewed } },
              reviewed: ["synthesize"],
              reviewedOn: { synthesize: latest.on },
              roots: [place.dir, cwd],
              tickets: [],
            }),
          };
        }),
      });
      if (gaps.gaps.length > 0) {
        const why = `${delivered.mr} is not ready: ${gaps.gaps.join("; ")}`;
        yield* Activity.make({
          name: "not-ready",
          success: Schema.Void,
          execute: Effect.andThen(
            host.record(runId, why),
            Effect.asVoid(host.note({ runId, cwd, body: redact(why) })),
          ),
        });
        yield* handOn(why);
        return yield* new WorkflowError({ reason: `Outcome unproved on ${gaps.head}: ${why}` });
      }
      yield* findings("findings.delivered", `performance proved on ${gaps.head}; ${delivered.mr}`);
      yield* Activity.make({
        name: "proved",
        success: Schema.Void,
        execute: host.record(runId, `performance proved on ${gaps.head}: ${delivered.mr}`),
      });
      return yield* handOn(delivered.mr);
    }),
});
