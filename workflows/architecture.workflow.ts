// Look at what is there, then decide whether to build the improvement.
//
// One attended pass over the project, its report written into this Run's own directory,
// and one question for the human. The Markdown beside this file is the content — what the
// architect is asked and what the report is for — and everything that decides what
// happens is here.

import {
  FindingSchema,
  NativeChildren,
  NativeHost,
  agentWork,
  ask,
  contentOf,
  decision,
  defineWorkflow,
} from "collie/native";
import { Effect, Schema } from "effect";
import markdown from "./architecture.md" with { type: "text" };

export const id = "architecture";
export const title = "architecture — look at what is there, then improve it";
export const description =
  "Runs the architecture skill over this project, writes a report into the run dir, then asks what next.";

/** Nothing: the project to look at is the checkout this Run was started for. */
export const input = {};

// No outcome is declared: what building this report would prove is what the report
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

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const next = decision("next", { prompt: "What next?", options: [IMPLEMENT, STOP] });

  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      const host = yield* NativeHost;
      const runId = payload.runId;
      const place = yield* host.place(runId);
      const report = yield* agentWork({
        runId,
        operation: "architecture",
        role: "architect",
        skill: "improve-codebase-architecture",
        workflow: id,
        cwd: place.cwd,
        instructions: prompt("attended"),
        vars: { run: { dir: place.dir, id: runId } },
        output: Report,
      });
      if ((yield* ask(runId, next)) === STOP) return `${report.report}: stopped there`;

      // The plan the architect wrote, built by the workflow that builds — and the kind of
      // result it said building it would be, settled while we agreed on the work rather
      // than asked for again at the start of the build.
      const children = yield* NativeChildren;
      const child = yield* children.start({
        runId,
        invocation: "implement",
        workflow: "implement",
        input: { plan: `${place.dir}/plan` },
        options: launch({ task: report.slug, outcome: report.outcome }),
      });
      yield* children.result(child);
      return `${report.report}: implemented as ${child.runId}`;
    }),
  );

  return { workflow, layer, decisions: { next } };
};
