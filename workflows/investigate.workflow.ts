import {
  FindingSchema,
  Host,
  Run,
  agentWork,
  contentOf,
  defineWorkflow,
  formatFindings,
  leaveFindings,
  step,
} from "collie";
import * as Activity from "effect/workflow/Activity";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Schema } from "effect";
import markdown from "./investigate.md" with { type: "text" };
import { measuredBy } from "./measuring.ts";
import { selected } from "./selected.ts";
import type { Finding } from "collie";

const MAX_FINDINGS = 7;

// WARNING: a filter's message is what the agent's one repair is told, so it names the rule.
const atMostSeven: (findings: ReadonlyArray<Finding>) => string | undefined = (findings) =>
  findings.length <= MAX_FINDINGS
    ? undefined
    : `${findings.length} findings: an investigation reports at most ${MAX_FINDINGS}`;

const oneMinor: (findings: ReadonlyArray<Finding>) => string | undefined = (findings) =>
  Arr.length(Arr.filter(findings, (one) => one.severity === "minor")) <= 1
    ? undefined
    : "two or more minor findings: an investigation reports at most one minor";

const INVESTIGATION_FILE = "investigation.md";

export const InvestigationOutput = Schema.Struct({
  answer: Schema.String.annotate({ description: "2–3 sentences answering the goal" }),
  cause: Schema.String.annotate({ description: "why it happens" }),
  findings: Schema.Array(FindingSchema)
    .annotate({
      description: `at most ${MAX_FINDINGS}, worst severity first, with at most one minor`,
    })
    .check(Schema.makeFilter(atMostSeven))
    .check(Schema.makeFilter(oneMinor)),
  summary: Schema.String,
  blocker: Schema.optionalKey(Schema.String),
  next_action: Schema.optionalKey(Schema.String),
  report: Schema.optionalKey(
    Schema.Struct({
      installation: Schema.String,
      run: Schema.String,
      id: Schema.String,
      revision: Schema.Int,
      step: Schema.String,
    }),
  ),
});
export type Investigation = typeof InvestigationOutput.Type;

const renderInvestigation = (report: Investigation, findings: ReadonlyArray<Finding>) =>
  `${Str.trim(report.answer)}\n\n## Cause\n\n${Str.trim(report.cause)}\n\n## Findings\n\n${formatFindings(findings)}\n`;

// WARNING: a report whose findings.json is missing is one nothing counts, so it is written first.
const leaveInvestigation = (dir: string, report: Investigation) =>
  Effect.gen(function* () {
    const findings = yield* leaveFindings(dir, report.findings);
    yield* (yield* FileSystem.FileSystem)
      .writeFileString(`${dir}/${INVESTIGATION_FILE}`, renderInvestigation(report, findings))
      .pipe(Effect.orDie);
    return findings;
  });

const content = contentOf(markdown);
const investigate = step({
  id: "investigate",
  title: "Investigate",
  description: "The investigator finds the cause and reports the evidence.",
  kind: "agent",
  role: "investigator",
  produces: "evidence",
});

export default defineWorkflow({
  id: "investigate",
  title: "investigate — find and report",
  description: "One agent investigates a goal, reports its evidence and closes after reporting.",
  connections: {
    uses: {
      linear: {
        with: "Files a finding as an issue through its Linear MCP",
        without: "Keeps its findings in Collie",
      },
    },
  },
  input: Schema.Struct({ goal: Schema.String }),
  output: InvestigationOutput,
  agents: { effort: "high" },
  path: [investigate],
  hints: { goal: "goal" },
  checkout: "branch",
  closes: "reported",
  followUps: selected,
  run: ({ input }) =>
    Effect.gen(function* () {
      const run = yield* Run;
      const host = yield* Host;
      const place = yield* host.place(run.id);
      const found = yield* investigate(
        agentWork({
          operation: "investigate",
          role: "investigator",
          instructions: content.template("investigate", {
            goal: Schema.String,
            run: Schema.Struct({ dir: Schema.String }),
            measure: Schema.String,
          }),
          input: {
            goal: input.goal,
            run: { dir: place.dir },
            measure: measuredBy("measure.task", `${place.dir}/handoffs/<slug>.benchmark.json`),
          },
          output: InvestigationOutput,
        }),
      );
      yield* leaveInvestigation(place.dir, found);
      yield* Activity.make({
        name: "nothing-to-land",
        success: Schema.NullOr(Schema.String),
        execute: host.nothingToLand(run.id, place.cwd),
      });
      return found;
    }),
});
