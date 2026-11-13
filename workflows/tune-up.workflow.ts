// Make a repository measurably faster, proved by the host's Measurement rather than by an
// agent's timings (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement). What only
// another repository could change is put to the human and never counts toward the outcome.

import * as Num from "effect/Number";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Struct from "effect/Struct";
import {
  Agents,
  BenchmarkPlan,
  ConnectionReading,
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
  calibrationOf,
  contentOf,
  defineWorkflow,
  endsWithoutPatchOf,
  harnessLacking,
  evidenceGapsOf,
  limitsOf,
  owedLocally,
  redact,
  renderApproved,
  renderEvidence,
  step,
  stepFailed,
  type Integration,
  type Measurement,
  type SynthesisReport,
} from "collie";
import {
  Array as Arr,
  Clock,
  Duration,
  Effect,
  FileSystem,
  Hash,
  Option,
  Path,
  Schema,
  flow,
  Result,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Activity from "effect/workflow/Activity";
import * as Workflow from "effect/workflow/Workflow";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
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
    Option.isSome(Schema.decodeOption(Schema.DurationFromString)(said)) ||
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
  repair: content.template("repair", {
    ...Told,
    repair: Schema.Struct({ n: text, of: text, class: text, why: text, measurement: text }),
    noise: text,
    plan: text,
    samples: text,
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
  cleanup: content.template("cleanup", {
    ...Told,
    harness: Schema.Struct({ commits: text, paths: text }),
    archive: text,
  }),
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
      threshold: Schema.optionalKey(
        Schema.Finite.annotate({ description: "the primary's own threshold, in percent" }),
      ),
      tolerance: Schema.optionalKey(
        Schema.Finite.annotate({ description: "this guardrail's own tolerance, in percent" }),
      ),
      absolute: Schema.optionalKey(
        Schema.Finite.annotate({
          description: "a difference in the metric's own units too small to count",
        }),
      ),
      exact: Schema.optionalKey(
        Schema.Boolean.annotate({
          description: "a deterministic count, such as mismatches, judged by its value",
        }),
      ),
      why: Schema.optionalKey(
        text.annotate({ description: "why its own limits are these; needed with any of them" }),
      ),
      counter: Schema.optionalKey(
        Schema.Struct({ name: text, direction: Direction }).annotate({
          description: "a low-variance count of the same work, to judge this metric by instead",
        }),
      ),
    }),
  ),
  warmup: Schema.Int,
  samples: Schema.optionalKey(
    Schema.Int.annotate({
      description: "samples per side, where the Run's own are too few to prove this plan",
    }),
  ),
  harness: Harness,
});
type Harnessed = typeof Harnessed.Type;

const Repaired = Schema.Struct({
  ...Harnessed.fields,
  reason: text.annotate({
    description: "what you changed, and why it makes the plan provable on this Machine",
  }),
});

/** A benchmark plan as the host measures by it, and why it is the plan now. */
const Planned = Schema.Struct({
  // measure judges the plan, so warmup stays as Harness wrote it.
  plan: BenchmarkPlan.mapFields(
    flow(Struct.omit(["limit"]), (fields) => ({ ...fields, harness: Harness, warmup: Schema.Int })),
  ),
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
  /** Each metric's verdict, ratio and interval, as the host judged them. */
  readonly measured: string | null;
}

/** What the tuner took off the branch once the human was happy with the progress. */
const Cleaned = Schema.Struct({
  removed: Schema.Array(text).annotate({
    description: "the harness, instrumentation, counters and run-specific setup you removed",
  }),
  commits: Schema.Array(text),
});

const Opened = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  mr_url: Schema.optionalKey(Schema.NullOr(text)),
  pushed: Schema.Boolean,
});

const Snapshot = Schema.Struct({ head_sha: text, fingerprint: text });

const TUNER = "tune";
const ANSWER = /^\s*(yes|no)\b[\s\p{P}]*(.*)$/isu;
const LABEL = /^(?:prepare for release|keep improving)\b[\s\p{P}]*/iu;
const ANSWERS = Arr.join(
  [
    "Start your answer with Yes or No, and add any words of your own.",
    "",
    "- **Yes, prepare for release**: the benchmark material is archived in this Run, the harness is taken off the branch, and the `final` Measurement is taken of what ships, with the harness applied in a scratch tree. Words after Yes are recorded as a tradeoff you accept; they never turn a guardrail the host did not hold into a pass.",
    "- **No, keep improving**: the work and the harness stay, one more Cycle runs, past the `cycles` and `wall_time` budgets if they are spent, and this question comes back.",
  ],
  "\n",
);

/** Yes or No, and the words after it; null where the answer starts with neither. */
const readAnswer = (said: string) => {
  const read = ANSWER.exec(said);
  if (read === null) return null;
  const words = Str.trim(pipe(read[2] ?? "", Str.replace(LABEL, "")));
  return { yes: Str.toLowerCase(read[1] ?? "") === "yes", words: words === "" ? null : words };
};
const MERGE_TRIES = 2;
const REPAIRS = 2;
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
const repair = step({
  id: "repair",
  title: "Repair",
  description:
    "Where calibration finds the harness broken or proof unavailable, the tuner repairs the harness or plan, a bounded number of times.",
  kind: "agent",
  role: "tuner",
});
const cycles = step({
  id: "cycles",
  title: "Cycles",
  description: "One hypothesis a Cycle, kept only where the host measures a gain.",
  kind: "agent",
  role: "tuner",
});
const progress = step({
  id: "progress",
  title: "Progress",
  description:
    "The progress so far put to the human: prepare for release, or keep improving with one more Cycle.",
  kind: "question",
});
const cleanup = step({
  id: "cleanup",
  title: "Cleanup",
  description: "The benchmark material archived in the Run, and the harness taken off the branch.",
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

/** How a Measurement ended without a verdict, naming the tree it ended on. */
const unjudged = (measured: Measurement, result: Unjudged) => {
  const tree = (side: "base" | "candidate") =>
    side === "base"
      ? `the base tree at ${measured.base.commit}`
      : `the candidate tree at ${measured.candidate.head_sha}`;
  switch (result._tag) {
    case "Failed":
      return result.stage === "prepare"
        ? `${tree(result.tree)} could not be built: \`${result.command}\` exited ${result.exit}: ${Str.trim(result.output)}`
        : `\`${result.command}\` failed on ${tree(result.tree)} with exit ${result.exit}: ${Str.trim(result.output)}`;
    case "TimedOut":
      return `\`${result.command}\` outlived the plan's time limit in ${result.stage} on ${tree(result.tree)}`;
    case "Unjudged":
      return `it was not judged: ${result.reason}`;
  }
};

/** Why a Cycle is not kept, or null: its checks pass, its primary gains and every guardrail holds. */
const notKept = (
  plan: { readonly metrics: ReadonlyArray<Plan["metrics"][number]> },
  failed: ReadonlyArray<string>,
  measured: Measurement,
) => {
  const whys = failed.length === 0 ? [] : [`checks failed: ${Arr.join(failed, ", ")}`];
  if (measured.result._tag !== "Judged")
    return Arr.join([...whys, unjudged(measured, measured.result)], "; ");
  const { verdicts } = measured.result;
  for (const metric of plan.metrics) {
    const judged = Option.getOrUndefined(
      Arr.findFirst(verdicts, (one) => one.metric === metric.name),
    );
    const verdict = judged?.verdict ?? "no verdict";
    if (metric.role === "primary") {
      if (verdict !== "gain") whys.push(`${metric.name} ${verdict}, not a gain`);
    } else if (judged === undefined || !judged.held || verdict === "inconclusive")
      whys.push(`guardrail ${metric.name} ${verdict}, not held`);
  }
  return whys.length === 0 ? null : Arr.join(whys, "; ");
};

/** What stopped an integration, as the tuner is told it. */
const stoppedBy = (merged: Integration) =>
  merged.status === "conflicted"
    ? `Collie merged ${merged.ref} (${merged.sha}) into this branch, and the merge stopped on conflicts in: ${Arr.join(merged.files, ", ")}.`
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

/** Each metric's verdict with its ratio and 95% interval, or how the Measurement ended without one. */
const intervalsLine = (measured: Measurement) =>
  measured.result._tag === "Judged"
    ? Arr.join(
        Arr.map(
          measured.result.verdicts,
          (one) =>
            `${one.metric} ${one.verdict}${one.held ? "" : ", not held"} (ratio ${one.ratio.toFixed(3)}, 95% interval [${Arr.join(
              Arr.map(one.interval, (bound) => bound.toFixed(3)),
              ", ",
            )}])`,
        ),
        "; ",
      )
    : unjudged(measured, measured.result);

const verdictsLine = (measured: Measurement) =>
  measured.result._tag === "Judged"
    ? Arr.join(
        Arr.map(
          measured.result.verdicts,
          (one) => `${one.metric} ${one.verdict}${one.held ? ", held" : ", not held"}`,
        ),
        "; ",
      )
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
    Arr.flatMap(found.research, (one) =>
      one.kind !== "nothing-found" && one.opportunity === title
        ? [`  - ${one.effect} by [${one.title}](${one.link})`]
        : [],
    );
  const ranked = new Set(Arr.map(found.opportunities, (one) => one.title));
  const ruledOut = [
    ...new Set(
      Arr.flatMap(found.research, (one) =>
        one.kind !== "nothing-found" && !ranked.has(one.opportunity) ? [one.opportunity] : [],
      ),
    ),
  ];
  const searched = Arr.flatMap(found.research, (one) =>
    one.kind === "nothing-found" ? [`- Searched, nothing found: ${one.searched}`] : [],
  );
  return Arr.join(
    [
      `# Tune-up findings: ${options.runId}`,
      "",
      options.ending,
      "",
      "## Stack",
      "",
      `- ${Arr.join(found.stack, ", ")}`,
      `- Skills loaded: ${Arr.join(found.skills, ", ") || "none"}`,
      "",
      "## Journeys",
      "",
      ...Arr.flatMap(found.journeys, (journey) =>
        Arr.map(
          journey.objectives,
          (one) =>
            `- ${journey.name}: ${one.metric}${one.target === undefined ? "" : ` (${one.target})`}, because ${one.why}`,
        ),
      ),
      "",
      "## Telemetry",
      "",
      ...Arr.map(
        found.telemetry,
        (one) => `- ${pipe(telemetryLine(one), Str.replace(/^telemetry /, ""))}`,
      ),
      "",
      "## Opportunities",
      "",
      ...Arr.flatMap(found.opportunities, (one, at) => [
        `${at + 1}. ${one.title} (${one.evidence}; cites ${Arr.join(one.cites, ", ")})`,
        ...sourced(one.title),
      ]),
      ...Arr.flatMap(ruledOut, (title) => [`- Not ranked: ${title}`, ...sourced(title)]),
      ...searched,
      "",
      "## Calibration (measured)",
      "",
      ...Arr.map(options.calibrations, (one) => `- ${one.id}: ${verdictsLine(one)}`),
      ...(options.cycles.length === 0
        ? []
        : [
            "",
            "## Cycles (measured)",
            "",
            ...Arr.map(options.cycles, (one) => `- ${cycleLine(one)}`),
          ]),
      "",
    ],
    "\n",
  );
};

/** Stable across Runs, so a later Run's search finds the issue an earlier one filed. */
const keyOf = (one: External) =>
  `external-${pipe((Hash.string(`${one.repository}\n${one.change}`) >>> 0).toString(16), Str.padStart(8, "0"))}`;
const markerOf = (key: string) => `collie:${key}`;

/** One external finding as the human reads it, in the report and in its question. */
const previewOf = (one: External) =>
  redact(
    Arr.join(
      [
        `### ${one.title}`,
        "",
        `- Repository: ${one.repository}`,
        `- Team: ${one.team ?? "unknown"}`,
        `- Journey: ${one.journey}`,
        `- Change needed: ${one.change}`,
        `- Estimated impact, not measured: ${one.estimated_impact}`,
        `- How it relates to the local change: ${one.relation}`,
        `- Evidence: ${Arr.join(one.links, ", ") || "none"}`,
        ...(one.existing === undefined ? [] : [`- Existing issue: ${one.existing}`]),
        "- Acceptance criteria:",
        ...Arr.map(one.criteria, (criterion) => `  - ${criterion}`),
      ],
      "\n",
    ),
  );

const median = (values: ReadonlyArray<number>) => {
  const sorted = Arr.sortWith(
    values,
    (value) => value,
    (a, b) => Num.sign(a - b),
  );
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** One side's judged samples of one metric, in the order they were taken. */
const readingsOf = (measured: Measurement, metric: string, side: "base" | "candidate") =>
  Arr.flatMap(measured.samples, (one) => {
    const value = one.readings[metric];
    return one.tree !== side || one.warmup || value === undefined ? [] : [value];
  });

const commandLine = (command: {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
}) => Arr.join([command.executable, ...command.argv], " ");

const tableOf = (measured: Measurement) => [
  "| Metric | Role | Base | Candidate | Ratio | 95% interval | Verdict |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...Arr.map(measured.plan.metrics, (metric) => {
    const judged =
      measured.result._tag === "Judged"
        ? Option.getOrUndefined(
            Arr.findFirst(measured.result.verdicts, (one) => one.metric === metric.name),
          )
        : undefined;
    const sides = Arr.map(["base", "candidate"] as const, (side) =>
      String(median(readingsOf(measured, metric.name, side))),
    );
    return judged === undefined
      ? `| ${metric.name} | ${metric.role} | ${Arr.join(sides, " | ")} | | | ${verdictsLine(measured)} |`
      : `| ${metric.name} | ${metric.role} | ${Arr.join(sides, " | ")} | ${judged.ratio.toFixed(3)} | [${Arr.join(
          Arr.map(judged.interval, (bound) => bound.toFixed(3)),
          ", ",
        )}] | ${judged.verdict}${judged.held ? "" : ", not held"} |`;
  }),
];

/**
 * The merge request's description, written from the host's Measurements rather than from
 * an agent's numbers, with every credential-shaped value taken out.
 */
const bodyOf = (got: {
  readonly final: Measurement;
  readonly original: Measurement | null;
  readonly finals: ReadonlyArray<Measurement>;
  readonly plans: ReadonlyArray<string>;
  readonly written: Harnessed;
  readonly found: Discovered;
  readonly cycles: ReadonlyArray<Cycled>;
  readonly evidence: string;
  readonly review: SynthesisReport;
  readonly tradeoff: string | null;
}) => {
  const { final, found } = got;
  const plan = final.plan;
  const primary =
    Option.getOrUndefined(Arr.findFirst(plan.metrics, (one) => one.role === "primary"))?.name ?? "";
  const guardrails = Arr.filter(plan.metrics, (one) => one.role === "guardrail");
  const verdictOf = (metric: string) =>
    final.result._tag === "Judged"
      ? Option.getOrUndefined(Arr.findFirst(final.result.verdicts, (one) => one.metric === metric))
      : undefined;
  const kept = new Set(
    Arr.flatMap(got.cycles, (one) =>
      one.kept && one.opportunity !== null ? [one.opportunity] : [],
    ),
  );
  const left = Arr.filter(found.opportunities, (one) => !kept.has(one.title));
  const said = (field: "behavior_preserved" | "measurement_valid") =>
    `${field}: ${got.review[field] === true}`;
  return redact(
    Arr.join(
      Arr.map(
        [
          `## Tune-up: ${primary} ${verdictOf(primary)?.verdict ?? "unjudged"} against the merge base`,
          "",
          `The final benchmark, on ${final.machine}, compares ${final.base.commit} with the harness applied against this branch at ${final.candidate.head_sha}${final.candidate.harness_applied === undefined ? "" : `, which ships without the harness and was measured with it applied in a scratch tree`}.`,
          "",
          ...tableOf(final),
          ...(got.tradeoff === null
            ? []
            : [
                "",
                "### Accepted tradeoffs",
                "",
                `The human accepted this when they were happy with the progress; it changes no verdict above: ${got.tradeoff}`,
              ]),
          ...(got.original === null
            ? []
            : [
                "",
                `Against the starting base, ${got.original.base.commit}:`,
                "",
                ...tableOf(got.original),
              ]),
          "",
          "### Commands and harness",
          "",
          ...Arr.map(plan.commands, (one) => `- ${one.name}: \`${commandLine(one)}\``),
          ...(plan.prepare === null
            ? []
            : [`- Prepared once per tree: \`${commandLine(plan.prepare)}\``]),
          `- Harness commits ${Arr.join(plan.harness.commits, ", ")}, touching only ${Arr.join(plan.harness.paths, ", ")}, taken off this branch`,
          "",
          "### Regressions and tradeoffs",
          "",
          ...Arr.map(guardrails, (one) => {
            const judged = verdictOf(one.name);
            return `- Guardrail ${one.name}: ${judged === undefined ? "unjudged" : `${judged.verdict}, ${judged.held ? "held" : "not held"}, worse bound ${judged.interval[one.direction === "lower" ? 1 : 0].toFixed(3)}`}`;
          }),
          ...Arr.map(
            Arr.filter(got.cycles, (one) => !one.kept),
            (one) => `- Not kept: ${one.tried}: ${one.why}`,
          ),
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
            : Arr.map(left, (one) => `- ${one.title} (${one.evidence})`)),
          "",
          "### What to monitor after deploying",
          "",
          ...Arr.flatMap(found.journeys, (journey) =>
            Arr.map(
              journey.objectives,
              (one) =>
                `- ${journey.name}: ${one.metric}${one.target === undefined ? "" : ` (${one.target})`}, because ${one.why}`,
            ),
          ),
          "",
          "<details>",
          "<summary>Evidence to audit and reproduce</summary>",
          "",
          "#### Samples of the final benchmark",
          "",
          ...Arr.flatMap(plan.metrics, (metric) =>
            Arr.map(
              ["base", "candidate"] as const,
              (side) =>
                `- ${metric.name}, ${side}: ${Arr.join(
                  Arr.map(readingsOf(final, metric.name, side), (part) =>
                    part === null || part === undefined ? "" : globalThis.String(part),
                  ),
                  ", ",
                )}`,
            ),
          ),
          "",
          "#### The frozen plan",
          "",
          `- Journeys ${Arr.join(got.written.journeys, ", ")}; cases ${Arr.join(got.written.cases, ", ") || "none"}`,
          ...Arr.map(plan.commands, (one) => `- Command ${one.name}: \`${commandLine(one)}\``),
          `- Warmup ${plan.warmup}, ${plan.samples} samples per side, threshold ${plan.threshold}%, tolerance ${plan.tolerance}%`,
          ...Arr.map(
            Rec.toEntries(final.environment),
            ([command, environment]) => `- Environment of ${command}: ${environment ?? "unread"}`,
          ),
          ...Arr.map(["base", "candidate"] as const, (side) => {
            const lockfiles = Rec.toEntries(final[side].lockfiles);
            return `- Lockfiles of the ${side}: ${
              Arr.join(
                Arr.map(lockfiles, ([file, digest]) => `${file} ${digest}`),
                ", ",
              ) || "none"
            }`;
          }),
          `- Harness commits ${Arr.join(plan.harness.commits, ", ")}, under ${Arr.join(plan.harness.paths, ", ")}`,
          `- Base: ${final.base.commit}, with the harness at ${final.base.head_sha}`,
          `- Candidate: ${final.candidate.head_sha}`,
          "",
          "#### Every plan and every `final` Measurement",
          "",
          ...Arr.map(got.plans, (reason, at) => `- Plan ${at + 1}: ${reason}`),
          ...Arr.map(
            got.finals,
            (one) => `- ${one.base.commit} against ${one.candidate.head_sha}: ${verdictsLine(one)}`,
          ),
          "",
          "#### Reproduce",
          "",
          "```sh",
          `git checkout ${final.candidate.head_sha}`,
          ...(plan.prepare === null ? [] : [commandLine(plan.prepare)]),
          ...Arr.map(plan.commands, commandLine),
          "```",
          "",
          "</details>",
          "",
        ],
        (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
      ),
      "\n",
    ),
  );
};

const carryHarness = ({
  cwd,
  from,
  commits,
}: {
  readonly cwd: string;
  readonly from: string;
  readonly commits: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const git = (args: ReadonlyArray<string>) => ChildProcess.make("git", [...args], { cwd });
    for (const commit of yield* harnessLacking(cwd, "HEAD", commits)) {
      if ((yield* spawner.exitCode(git(["cherry-pick", commit]))) === 0) continue;
      yield* spawner.exitCode(git(["cherry-pick", "--abort"]));
      return yield* new WorkflowError({
        reason: `harness commit ${commit} of ${from} does not apply to ${cwd}`,
      });
    }
  }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new WorkflowError({ reason: `the harness could not be carried: ${cause.message}` }),
      ),
    ),
  );

interface Archived {
  readonly runId: string;
  readonly cwd: string;
  readonly archive: string;
  readonly plan: Plan;
  readonly reasons: ReadonlyArray<string>;
}

const unarchived = (cause: { readonly message: string }) =>
  new WorkflowError({ reason: `the archive could not be written: ${cause.message}` });

/** The harness commits as patches in the Run's benchmark archive, read before cleanup takes them off. */
const archivedHarness = ({ cwd, archive, plan }: Archived) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* fs.remove(`${archive}/harness`, { recursive: true, force: true });
    yield* fs.makeDirectory(`${archive}/harness`, { recursive: true });
    for (const [at, commit] of plan.harness.commits.entries())
      yield* spawner.string(
        ChildProcess.make(
          "git",
          [
            "format-patch",
            "--quiet",
            "-1",
            commit,
            "--start-number",
            String(at + 1),
            "-o",
            `${archive}/harness`,
          ],
          { cwd },
        ),
      );
  }).pipe(Effect.mapError(unarchived));

/**
 * The rest of the Run's benchmark archive: the plan, every Measurement raw, and a README of
 * each one's intervals and revisions and how to reproduce them. Written again whole, so a
 * later Measurement joins it.
 */
const archivedResults = (got: Archived) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const fs = yield* FileSystem.FileSystem;
    const { plan, archive } = got;
    const measured = (yield* host.evidence(got.runId, got.cwd)).measurements ?? [];
    yield* fs.writeFileString(
      `${archive}/plan.json`,
      yield* Schema.encodeEffect(Schema.fromJsonString(Planned.fields.plan))(plan),
    );
    const lines: string[] = [];
    for (const one of measured)
      lines.push(yield* Schema.encodeEffect(Schema.fromJsonString(MeasurementSchema))(one));
    yield* fs.writeFileString(`${archive}/measurements.jsonl`, Arr.join([...lines, ""], "\n"));
    const latest = measured.at(-1);
    yield* fs.writeFileString(
      `${archive}/README.md`,
      Arr.join(
        [
          `# Tune-up benchmark archive: ${got.runId}`,
          "",
          `- \`harness/\`: the harness commits ${Arr.join(plan.harness.commits, ", ")} as patches, touching only ${Arr.join(plan.harness.paths, ", ")}.`,
          `- \`plan.json\`: the protocol, the benchmark plan the host measured by (${got.reasons.at(-1) ?? "as written"}).`,
          "- `measurements.jsonl`: every Measurement as the host recorded it, every sample's readings, load and memory included.",
          "",
          "## Measurements",
          "",
          ...Arr.map(
            measured,
            (one) =>
              `- ${one.id} (${one.pass}): base ${one.base.commit} with the harness at ${one.base.head_sha}; candidate ${one.candidate.head_sha}${
                one.candidate.harness_applied === undefined
                  ? ""
                  : ` with ${Arr.join(one.candidate.harness_applied, ", ")} applied`
              }: ${intervalsLine(one)}`,
          ),
          "",
          "## Reproduce",
          "",
          "From a checkout at the candidate, which needs no harness of its own:",
          "",
          "```sh",
          `collie measure --run ${got.runId} --base ${latest?.base.commit ?? "<base>"} --plan ${archive}/plan.json --pass final`,
          "```",
          "",
        ],
        "\n",
      ),
    );
  }).pipe(Effect.mapError(unarchived));

export default defineWorkflow({
  id: "tune-up",
  connections: {
    uses: {
      linear: { with: "Files what it finds as issues", without: "Reports in the Run only" },
      gitlab: {
        with: "Opens the merge request for a proved improvement",
        without: "Keeps the improvement on its branch and says why",
      },
      github: {
        with: "Opens the pull request for a proved improvement",
        without: "Keeps the improvement on its branch and says why",
      },
    },
  },
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
    from: Schema.optionalKey(
      text.annotate({
        description:
          "An earlier tune-up Run whose findings and benchmark plan this one carries instead of discovering again; empty is none",
        default: "",
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
    repair,
    cycles,
    progress,
    cleanup,
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
        success: Schema.Finite,
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
      const measureOrPark = (asked: Parameters<typeof host.measure>[0]) =>
        host.measure(asked).pipe(
          Effect.catch((failed) =>
            Effect.gen(function* () {
              const reason = `${failed.reason}. Correct it, then resume ${runId}.`;
              yield* host.record(runId, reason);
              yield* stepFailed(reason);
              yield* host.parked(runId, reason, "step-failed");
              return yield* Workflow.suspend(yield* WorkflowInstance);
            }),
          ),
          Effect.tap(() => host.parked(runId, null)),
        );

      const from = input.from ?? "";
      const agents = yield* Agents;
      /** The earlier Run's Output of the first of `operations` it has, decoded as `schema`. */
      const carried = <S extends Schema.Codec<unknown, unknown>>(
        name: string,
        operations: ReadonlyArray<string>,
        schema: S,
      ) =>
        Activity.make({
          name: `${name}.carried`,
          success: schema,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const files = Arr.map(operations, (one) => agents.outputFor(from, one));
            const file = Option.getOrUndefined(
              yield* Effect.findFirst(files, (one) =>
                fs.exists(one).pipe(Effect.orElseSucceed(() => false)),
              ),
            );
            if (file === undefined)
              return yield* new WorkflowError({
                reason: `${from} has no ${name} Output to carry: none of ${Arr.join(files, ", ")}`,
              });
            const unreadable = (cause: { readonly message: string }) =>
              new WorkflowError({ reason: `${file} cannot be carried: ${cause.message}` });
            const raw = yield* fs.readFileString(file).pipe(Effect.mapError(unreadable));
            const read = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
              Effect.mapError(unreadable),
            );
            // Kept as this Run's own, so a later `from` naming this Run finds it.
            const own = agents.outputFor(runId, name);
            yield* fs
              .makeDirectory((yield* Path.Path).dirname(own), { recursive: true })
              .pipe(Effect.andThen(fs.writeFileString(own, raw)), Effect.mapError(unreadable));
            yield* host.record(runId, `${name} carried from ${from}: ${file}`);
            return read;
          }),
        });

      const found =
        from === ""
          ? yield* discover(
              agentWork({
                operation: "discover",
                agent: TUNER,
                role: "tuner",
                instructions: prompts.discover,
                input: told,
                output: Discovered,
              }),
            )
          : yield* discover(carried("discover", ["discover"], Discovered));
      for (const one of found.telemetry) yield* host.record(runId, telemetryLine(one));
      for (const one of found.research) yield* host.record(runId, researchLine(one));

      const written =
        from === ""
          ? yield* harness(
              agentWork({
                operation: "harness",
                agent: TUNER,
                role: "tuner",
                instructions: prompts.harness,
                input: {
                  ...told,
                  discovered: Arr.join(
                    [
                      ...Arr.map(found.journeys, (one) => `- journey: ${one.name}`),
                      ...Arr.map(
                        found.opportunities,
                        (one, at) => `${at + 1}. ${one.title} (${one.evidence})`,
                      ),
                    ],
                    "\n",
                  ),
                  budget: {
                    samples: String(budget.samples),
                    threshold: String(budget.threshold),
                    tolerance: String(budget.tolerance),
                  },
                },
                output: Harnessed,
              }),
            )
          : yield* harness(
              carried(
                "harness",
                [...Arr.reverse(Arr.map(Arr.range(1, REPAIRS), (n) => `repair-${n}`)), "harness"],
                Harnessed,
              ),
            );

      if (from !== "")
        yield* Activity.make({
          name: "harness.carried.onto",
          success: Schema.Void,
          error: WorkflowError,
          execute: carryHarness({ cwd, from, commits: written.harness.commits }).pipe(
            Effect.andThen(
              host.record(
                runId,
                `harness commits ${Arr.join(written.harness.commits, ", ")} carried onto ${cwd}`,
              ),
            ),
          ),
        });

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
      const planOf = (harnessed: Harnessed): Plan => ({
        harness: harnessed.harness,
        prepare: harnessed.prepare,
        commands: harnessed.commands,
        metrics: Arr.map(harnessed.metrics, Struct.omit(["counter"])),
        warmup: harnessed.warmup,
        samples: Math.max(budget.samples, harnessed.samples ?? 0),
        threshold: budget.threshold,
        tolerance: budget.tolerance,
      });
      const encodePlan = (one: Plan) =>
        Schema.encodeEffect(Schema.fromJsonString(Planned.fields.plan))(one).pipe(Effect.orDie);
      const experimentOf = (one: Plan) =>
        encodePlan({
          ...one,
          metrics: Arr.map(one.metrics, (metric) => ({
            ...pipe(metric, Struct.omit(["why"])),
            ...limitsOf(one, metric),
          })),
        });
      let plan = yield* recordPlan(
        planOf(written),
        from === "" ? "written by Harness" : `carried from ${from}`,
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
      const tried = new Set<string>([yield* experimentOf(plan)]);
      let counted = written;
      let ending: string | null = null;
      let calibrated = false;
      for (let repairs = 0, attempt = 1; ; attempt++) {
        const result = yield* calibrate(
          Activity.make({
            name: `calibration.${attempt}`,
            success: Schema.Union([MeasurementSchema, Schema.Struct({ refused: text })]),
            error: WorkflowError,
            execute: Effect.map(
              host.measure({ runId, base, cwd, plan, reason: reasons.at(-1), pass: "calibration" }),
              (answered) => answered.measurement,
            ).pipe(Effect.catch((failed) => Effect.succeed({ refused: failed.reason }))),
          }),
        );
        const measured = "refused" in result ? null : result;
        if (measured !== null) calibrations.push(measured);
        const itself =
          measured === null ||
          (measured.candidate.harness_applied === undefined
            ? measured.base.content === measured.candidate.content
            : measured.candidate.head_sha === measured.base.commit);
        if (measured !== null && measured.result._tag === "Judged" && !itself)
          return yield* new WorkflowError({
            reason: `calibration ${measured.id} did not measure the base against itself: ${cwd} at ${measured.candidate.head_sha} holds more than the harness commits ${Arr.join(plan.harness.commits, ", ")}`,
          });
        const read = measured === null ? null : calibrationOf(measured);
        if (measured !== null && read?._tag === "Calibrated") {
          const primary =
            Option.getOrUndefined(Arr.findFirst(plan.metrics, (one) => one.role === "primary"))
              ?.name ?? "";
          ending = `calibrated on ${primary} (calibration ${measured.id})`;
          calibrated = true;
          break;
        }
        const kind =
          read === null || read._tag === "HarnessBroken" ? "harness broken" : "proof unavailable";
        const why =
          "refused" in result
            ? result.refused
            : read?._tag === "ProofUnavailable"
              ? Arr.join(
                  Arr.map(read.lost, (one) => one.why),
                  "; ",
                )
              : result.result._tag === "Judged"
                ? Arr.join(read?._tag === "HarnessBroken" ? read.why : [], "; ")
                : unjudged(result, result.result);
        const counters =
          read?._tag === "ProofUnavailable"
            ? Arr.map(read.lost, (one) => ({
                ...one,
                counter: Option.getOrUndefined(
                  Arr.findFirst(counted.metrics, (metric) => metric.name === one.metric),
                )?.counter,
              }))
            : [];
        const switched: Plan = {
          ...plan,
          metrics: Arr.map(plan.metrics, (metric) => {
            const counter = Option.getOrUndefined(
              Arr.findFirst(counters, (one) => one.metric === metric.name),
            )?.counter;
            return counter === undefined ? metric : { ...counter, role: metric.role };
          }),
        };
        const switchedKey = yield* experimentOf(switched);
        if (
          counters.length > 0 &&
          Arr.every(counters, (one) => one.counter !== undefined) &&
          !tried.has(switchedKey)
        ) {
          tried.add(switchedKey);
          plan = yield* recordPlan(
            switched,
            Arr.join(
              Arr.map(
                counters,
                (one) => `switched ${one.metric} to its counter ${one.counter?.name}: ${one.why}`,
              ),
              "; ",
            ),
          );
          continue;
        }
        const measurement = measured?.id ?? `refused attempt ${attempt}`;
        const failed = `${kind}: ${why} (calibration ${measurement})`;
        if (repairs >= REPAIRS) {
          ending = `${failed}; ${REPAIRS} repairs spent`;
          if (kind === "proof unavailable") break;
          yield* calibrate(
            Activity.make({
              name: `calibration.${attempt}.park`,
              execute: Effect.gen(function* () {
                const fs = yield* FileSystem.FileSystem;
                const marker = `${place.dir}/calibration.${attempt}.parked`;
                if (yield* fs.exists(marker).pipe(Effect.orDie))
                  return yield* host.parked(runId, null);
                const reason = `${ending}. Correct it, then resume ${runId}.`;
                yield* fs.writeFileString(marker, "").pipe(Effect.orDie);
                yield* host.record(runId, reason);
                yield* stepFailed(reason);
                yield* host.parked(runId, reason, "step-failed");
                return yield* Workflow.suspend(yield* WorkflowInstance);
              }),
            }),
          );
        }
        repairs += 1;
        const of = Math.max(REPAIRS, repairs);
        yield* host.record(runId, `${failed}; repair ${repairs} of ${of}`);
        const repaired = yield* repair(
          agentWork({
            operation: `repair-${repairs}`,
            agent: TUNER,
            role: "tuner",
            instructions: prompts.repair,
            input: {
              ...told,
              repair: {
                n: String(repairs),
                of: String(of),
                class: kind,
                why,
                measurement,
              },
              noise: measured === null ? why : intervalsLine(measured),
              plan: yield* encodePlan(plan),
              samples: String(budget.samples),
            },
            output: Repaired,
          }),
        );
        const next = planOf(repaired);
        const encoded = yield* experimentOf(next);
        if (kind === "proof unavailable" && tried.has(encoded)) {
          ending = `${failed}; repair ${repairs} left the plan as it was, and a plan is never calibrated twice`;
          break;
        }
        tried.add(encoded);
        counted = repaired;
        plan = yield* recordPlan(next, `repair ${repairs}: ${repaired.reason}`);
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
          const finding = previewOf(one);
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
                ? `external ${key}: existing ${Arr.join(searched.matching, ", ")}`
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
              options: [IGNORE, { id: POST, recommended: true }],
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
          const named = Arr.map(handed, (one) => ({ key: keyOf(one), one }));
          const keyed = Arr.dedupeWith(named, (one, other) => one.key === other.key);
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
                    Arr.join(
                      [
                        `# Tune-up external findings: ${runId}`,
                        "",
                        "Improvements only another repository can make. None is assumed done: no Measurement, outcome or merge readiness counts on any of them.",
                        "",
                        ...Arr.flatMap(keyed, ({ one }) => [previewOf(one), ""]),
                      ],
                      "\n",
                    ),
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
                success: ConnectionReading,
                execute: host.connection("linear"),
              });
              if (linear.state !== "ok")
                return yield* recorded("external.unasked", `${file} not asked: ${linear.detail}`);
              for (const { key, one } of keyed) yield* settle(key, one);
            }),
          );
          return ending;
        });
      if (!calibrated) {
        const report = yield* findings("findings", ending);
        return yield* new WorkflowError({ reason: yield* handOn(`${report}: ${ending}`) });
      }

      const wall =
        budget.wall_time === ""
          ? null
          : Duration.toMillis(
              yield* Schema.decodeEffect(Schema.DurationFromString)(budget.wall_time).pipe(
                Effect.orDie,
              ),
            );
      const opportunities =
        Arr.join(
          Arr.map(
            found.opportunities,
            (one, at) =>
              `${at + 1}. ${one.title} (${one.evidence}; cites ${Arr.join(one.cites, ", ")})`,
          ),
          "\n",
        ) || "None ranked.";
      const metrics = Arr.join(
        Arr.map(plan.metrics, (one) => `${one.name}, ${one.role}, ${one.direction} is better`),
        "; ",
      );
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
                measureOrPark({
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
          return {
            why: notKept(plan, failed, measured),
            measurement: measured.id,
            measured: intervalsLine(measured),
          };
        });
      /** One Cycle. An `automatic` one does not start once the wall time is spent, and says so as `spent`. */
      const cycle = (n: number, automatic: boolean) =>
        Effect.gen(function* () {
          // The shape a Run recorded before this build, so one it started still recovers. That
          // start may have recorded the wall time spent, so a Cycle a No asks for has its own.
          const begun = yield* Activity.make({
            name: automatic ? `cycle-${n}.start` : `cycle-${n}.start-after-no`,
            success: Schema.Struct({ spent: Schema.NullOr(text), tree: Tree }),
            execute: Effect.gen(function* () {
              const tree = yield* treeNow;
              if (automatic && wall !== null && (yield* Clock.currentTimeMillis) - started >= wall)
                return {
                  spent: `wall time ${budget.wall_time} spent ${n === 1 ? "before Cycle 1" : `after Cycle ${n - 1}`}`,
                  tree,
                };
              yield* host.record(runId, `cycle ${n} started on ${tree.head} ${tree.fingerprint}`);
              return { spent: null, tree };
            }),
          });
          if (begun.spent !== null) return { spent: begun.spent, kept: false, stopped: null };
          const start = begun.tree;
          const tried = yield* cycles(
            agentWork({
              operation: `cycle-${n}`,
              agent: TUNER,
              role: "tuner",
              instructions: prompts.cycle,
              input: {
                ...told,
                cycle: {
                  n: String(n),
                  of:
                    n > budget.cycles
                      ? `${budget.cycles}, and this one past it because the human answered No`
                      : String(budget.cycles),
                  start: start.head,
                },
                opportunities,
                earlier:
                  Arr.join(
                    Arr.map(cycled, (one) => `- ${cycleLine(one)}`),
                    "\n",
                  ) || "None yet.",
                metrics,
              },
              output: Tried,
            }),
          );
          handed.push(...(tried.external ?? []));
          const stopped =
            tried.result === "changed"
              ? null
              : tried.result === "exhausted"
                ? `no measured opportunity is left: ${tried.why}`
                : `an unsafe tradeoff was named: ${tried.tradeoff}`;
          const judged =
            tried.result === "changed"
              ? yield* judging(n, start.head)
              : { why: stopped, measurement: null, measured: null };
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
                      commits: tried.result === "changed" ? Arr.join(tried.commits, ", ") : "none",
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
            measured: judged.measured,
          };
          cycled.push(done);
          yield* findings(`cycle-${n}.findings`, cycleLine(done));
          return { spent: null, kept, stopped };
        });
      let stopped: string | null = null;
      let unkept = 0;
      for (let n = 1; n <= budget.cycles && stopped === null; n++) {
        const one = yield* cycle(n, true);
        if (one.spent !== null) {
          stopped = one.spent;
          break;
        }
        stopped = one.stopped;
        unkept = one.kept ? 0 : unkept + 1;
        if (stopped === null && unkept >= 2) stopped = "two consecutive Cycles were not kept";
      }
      const stop = stopped ?? `cycles spent: ${budget.cycles} of ${budget.cycles}`;
      yield* host.record(runId, `stopped: ${stop}`);

      const progressOf = (why: string) =>
        Arr.join(
          [
            "Are you happy with the progress?",
            "",
            `Automatic cycling stopped: ${why}.`,
            "",
            "Each Cycle, as the host measured it:",
            "",
            ...(cycled.length === 0
              ? ["- None ran."]
              : Arr.map(
                  cycled,
                  (one) =>
                    `- Cycle ${one.n}, ${one.tried}: ${one.kept ? "kept" : `reverted: ${one.why}`}${
                      one.measured === null ? "" : `; ${one.measurement}: ${one.measured}`
                    }`,
                )),
            "",
            ANSWERS,
          ],
          "\n",
        );
      /** The human's answer to the `asked`th question, asked again until it starts with Yes or No. */
      const answered = (asked: number, why: string) =>
        Effect.gen(function* () {
          const prompt = progressOf(why);
          let name = `progress-${asked}`;
          for (let again = 1; ; again++) {
            const said = yield* progress(ask({ name, prompt }));
            const read = readAnswer(said);
            if (read !== null) {
              yield* recorded(`${name}.decided`, `decision ${name}: ${said}`);
              return read;
            }
            name = `progress-${asked}-again${again === 1 ? "" : `-${again}`}`;
          }
        });
      let why = stop;
      let tradeoff: string | null = null;
      for (let asked = 1; ; asked++) {
        const read = yield* answered(asked, why);
        if (read.yes) {
          tradeoff = read.words;
          break;
        }
        const n = cycled.length + 1;
        const one = yield* cycle(n, false);
        why = `the human answered No, so Cycle ${n} ran${one.stopped === null ? "" : `, and ${one.stopped}`}`;
      }
      const kept = Arr.map(
        Arr.filter(cycled, (one) => one.kept),
        (one) => `Cycle ${one.n}`,
      );
      if (kept.length === 0) {
        const done = `no gain: ${stop}; no Cycle was kept, so the Run is back on its base tree`;
        const report = yield* findings("findings", done);
        return yield* handOn(`${report}: ${done}`);
      }
      if (tradeoff !== null) yield* recorded("tradeoff", `accepted tradeoff: ${tradeoff}`);

      const archive = `${place.dir}/archive`;
      const archiving = { runId, cwd, archive, plan, reasons };
      yield* cleanup(
        Effect.gen(function* () {
          yield* Activity.make({
            name: "archive",
            success: Schema.Void,
            error: WorkflowError,
            execute: Effect.andThen(archivedHarness(archiving), archivedResults(archiving)),
          });
          yield* agentWork({
            operation: "cleanup",
            agent: TUNER,
            role: "tuner",
            instructions: prompts.cleanup,
            input: {
              ...told,
              harness: {
                commits: Arr.join(plan.harness.commits, ", "),
                paths: Arr.join(plan.harness.paths, ", "),
              },
              archive,
            },
            output: Cleaned,
          });
          yield* Activity.make({
            name: "cleaned",
            success: Schema.Void,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const left: string[] = [];
              for (const one of plan.harness.paths)
                if (yield* fs.exists(`${cwd}/${one}`).pipe(Effect.orElseSucceed(() => false)))
                  left.push(one);
              if (left.length > 0)
                return yield* new WorkflowError({
                  reason: `cleanup left the harness on the branch: ${Arr.join(left, ", ")}`,
                });
              const now = yield* treeNow;
              yield* host.record(runId, `cleaned up to ${now.head} ${now.fingerprint}`);
            }),
          });
        }),
      );
      const findingsOf = (name: string, ending: string) =>
        Effect.map(findings(name, ending), (report) => `${report}: ${ending}`);

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
            const { measurement, ran } = yield* measureOrPark({
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
            yield* archivedResults(archiving);
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
      // An accepted tradeoff keeps a lost guardrail from dropping the change; the gate still judges it.
      const judgedBy =
        tradeoff === null
          ? plan
          : { metrics: Arr.filter(plan.metrics, (one) => one.role === "primary") };
      const lost = (measured: Measurement) => notKept(judgedBy, [], measured);
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
                  commits: Arr.join([...plan.harness.commits, ...keptCommits], ", "),
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
            `no gain: the final Measurement ${measured.id} against ${measured.base.commit}: ${why}; the change was dropped back to the base tree, so no merge request is opened`,
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
                    measureOrPark({
                      runId,
                      base,
                      cwd,
                      plan,
                      reason: reasons.at(-1),
                      pass: "final",
                    }),
                    (answered) => answered.measurement,
                  ),
                });
          return { measured, why, original };
        }),
      );
      if (proved.why !== null) return yield* handOn(yield* dropped(proved.measured, proved.why));
      yield* findings("findings.integrated", `${stop}; kept ${Arr.join(kept, ", ")}`);

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
        const taken = Arr.filter(evidence.measurements ?? [], (one) => one.pass === "final");
        const final = Option.getOrUndefined(
          Arr.findLast(taken, (one) => one.base.commit === evidence.mergeBase),
        );
        if (final === undefined)
          return yield* new WorkflowError({
            reason: "no `final` Measurement against the merge base to write the merge request from",
          });
        const fs = yield* FileSystem.FileSystem;
        const body = bodyOf({
          final,
          original: proved.original,
          finals: taken,
          plans: reasons,
          written,
          found,
          cycles: cycled,
          evidence: renderEvidence({ ...evidence, measurements: [] }),
          review: latest.reviewed,
          tradeoff,
        });
        yield* archivedResults(archiving);
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
                fs.writeFileString(
                  proofReview,
                  flow(Schema.encodeResult(ProofReview), Result.getOrThrow)(latest),
                ),
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
                error: WorkflowError,
                execute: Effect.gen(function* () {
                  const posted = yield* host.note({
                    runId,
                    cwd,
                    body: `Reran the benchmarks after fixing CI:\n\n${body}`,
                  });
                  if (!posted.ok) return yield* new WorkflowError({ reason: posted.message });
                }),
              });
            return latest;
          }),
      }).pipe(
        Effect.mapError((failed) =>
          tradeoff === null || !Schema.is(WorkflowError)(failed)
            ? failed
            : new WorkflowError({ reason: `${failed.reason}; accepted tradeoff: ${tradeoff}` }),
        ),
      );
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
        const why = `${delivered.mr} is not ready: ${Arr.join(gaps.gaps, "; ")}`;
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
