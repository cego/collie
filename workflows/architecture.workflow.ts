// Look at what is there, then decide whether to build the improvement.
//
// One attended pass over the project, its report written into this Run's own directory,
// and one question for the human. The Markdown beside this file is the content — what the
// architect is asked and what the report is for — and everything that decides what
// happens is here.

import {
  FindingSchema,
  Children,
  Host,
  Run,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
} from "collie";
import { Effect, Schema } from "effect";
import markdown from "./architecture.md" with { type: "text" };

// It takes nothing: the project to look at is the checkout this Run was started for. No
// outcome is declared either: what building this report would prove is what the report
// itself says — usually a refactor, a feature where we agreed to build something that is
// not there yet — so it is the architect's own answer below rather than a kind fixed here.

const content = contentOf(markdown);
const prompt = (section: string) =>
  [content.preamble, content.sections.get(section) ?? ""]
    .filter((part) => part !== "")
    .join("\n\n");

/** What the architect is held to: the report, what it applied, and what it left. */
const Report = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "findings only where something stopped you, with the reason in findings",
  }),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  report: Schema.String.annotate({ description: "the report you wrote, as a path" }),
  applied: Schema.optionalKey(Schema.Array(Schema.String)),
  deferred: Schema.optionalKey(Schema.Array(FindingSchema)).annotate({
    description:
      "every candidate you did not apply, with its strength and what leaving it costs — this is what the human reads at the end",
  }),
  slug: Schema.String.annotate({
    description:
      "short kebab-case name for the work we agreed on; the branch an implement run would build is named after it, so name the work rather than the repository",
  }),
  outcome: Schema.String.annotate({
    description:
      "what kind of result building it would be — usually refactor, because architectural work is judged on behaviour surviving it; feature only where we agreed to build something that is not there yet",
  }),
});

/** The host's own options for a child, with the ones nobody settled left out: absent
 *  rather than empty, exactly as a front door passes them. */
const launch = (options: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== ""));

const IMPLEMENT = "Implement now";
const STOP = "Stop here";

export default defineWorkflow({
  id: "architecture",
  title: "architecture — look at what is there, then improve it",
  description:
    "Runs the architecture skill over this project, writes a report into the run dir, then asks what next.",
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const report = yield* agentWork({
        operation: "architecture",
        role: "architect",
        skill: "improve-codebase-architecture",
        instructions: prompt("attended"),
        vars: { run: { dir: place.dir, id: run.id } },
        output: Report,
      });
      const next = yield* ask({ name: "next", prompt: "What next?", options: [IMPLEMENT, STOP] });
      if (next === STOP) return `${report.report}: stopped there`;

      // The plan the architect wrote, built by the workflow that builds — and the kind of
      // result it said building it would be, settled while we agreed on the work rather
      // than asked for again at the start of the build.
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "implement",
        workflow: "implement",
        input: { plan: `${place.dir}/plan` },
        options: launch({ task: report.slug, outcome: report.outcome }),
      });
      yield* children.result(child);
      return `${report.report}: implemented as ${child.runId}`;
    }),
});
