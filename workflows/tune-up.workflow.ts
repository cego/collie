// Make a repository measurably faster, proved by the host's Measurement rather than by an
// agent's timings (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement).
//
// Discover reads the project, Harness commits a benchmark harness and writes its plan, and
// Calibrate has the host measure the base against itself to learn this Machine's noise
// floor. Where that rules out proof the Run ends with its findings and no merge request.
//
// The Markdown beside this file is the content: what each step is asked.

import {
  Host,
  MeasurementSchema,
  Run,
  WorkflowError,
  agentWork,
  contentOf,
  defineWorkflow,
  step,
  type Measurement,
} from "collie";
import { Array as Arr, Effect, FileSystem, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./tune-up.md" with { type: "text" };
import { IMPLEMENTER, REVIEWER, reviewRound } from "./reviewing.ts";
import { mergeRequest } from "./delivering.ts";

const content = contentOf(markdown);
const text = Schema.String;

const DEFAULTS = { cycles: 5, threshold: 5, tolerance: 2, samples: 10, external: "ask" } as const;

/** A whole number, as a front door's words or as JSON. */
const Whole = Schema.Union([Schema.Int, Schema.NumberFromString.check(Schema.isInt())]);
const Percent = Schema.Union([
  Schema.Finite,
  Schema.NumberFromString.check(Schema.isFinite()),
]).check(Schema.isGreaterThan(0));

const Told = {
  inputs: Schema.Struct({ focus: text }),
  run: Schema.Struct({ dir: text, id: text }),
};

const prompts = {
  discover: content.template("discover", Told),
  harness: content.template("harness", {
    ...Told,
    discovered: text,
    budget: Schema.Struct({ samples: text, threshold: text, tolerance: text }),
  }),
};

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
  external: Schema.Array(Schema.Struct({ title: text, repository: text, change: text })),
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

const TUNER = "tune";

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
    ...(found.external.length === 0
      ? []
      : [
          "",
          "## External candidates",
          "",
          ...found.external.map((one) => `- ${one.repository}: ${one.title}: ${one.change}`),
        ]),
    "",
  ].join("\n");
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
      text.annotate({
        description: "A duration after which no new Cycle starts; empty is none",
        default: "",
      }),
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
    mergeRequest,
    externalReport,
  ],
  checkout: "branch",
  outcome: { fixed: "performance" },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
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

      // Each plan is its own record before anything is measured by it.
      let plans = 0;
      const recordPlan = (plan: Plan, reason: string) =>
        Effect.gen(function* () {
          plans += 1;
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
      for (;;) {
        const measured = yield* calibrate(
          Activity.make({
            name: `calibration.${calibrations.length + 1}`,
            success: MeasurementSchema,
            error: WorkflowError,
            execute: Effect.map(
              host.measure({ runId, base, cwd, plan, pass: "calibration" }),
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

      const report = yield* Activity.make({
        name: "findings",
        success: text,
        error: WorkflowError,
        execute: Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = `${place.dir}/handoffs/tune-up-findings.md`;
          yield* fs.makeDirectory(`${place.dir}/handoffs`, { recursive: true });
          yield* fs.writeFileString(file, reportOf({ runId, ending, found, calibrations }));
          return file;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowError({ reason: `the findings could not be written: ${cause.message}` }),
          ),
        ),
      });
      return `${report}: ${ending}`;
    }),
});
