import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import {
  FindingSchema,
  Children,
  Host,
  Run,
  agentWork,
  ask,
  contentOf,
  defineWorkflow,
  step,
} from "collie";
import { Effect, Schema } from "effect";
import markdown from "./architecture.md" with { type: "text" };

const content = contentOf(markdown);
const attended = content.template("attended", {
  inputs: Schema.Struct({ goal: Schema.String }),
  run: Schema.Struct({ dir: Schema.String }),
  rooting: Schema.String,
});

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

// WARNING: absent rather than empty, exactly as a front door passes them.
const launch = (options: Record<string, string>) =>
  Rec.fromEntries(Arr.filter(Rec.toEntries(options), ([, value]) => value !== ""));

const IMPLEMENT = "Implement now";
const STOP = "Stop here";

const architecture = step({
  id: "architecture",
  title: "Architecture",
  description: "The architect surveys the project and writes an improvement plan.",
  kind: "agent",
  role: "architect",
  produces: "plan",
});
const menu = step({
  id: "menu",
  title: "What next",
  description: "Choose whether to implement the improvement or finish with its report.",
  kind: "question",
});

export default defineWorkflow({
  id: "architecture",
  title: "architecture — look at what is there, then improve it",
  description:
    "Surveys a project's architecture with the architecture skill, writes a report into the run dir, then asks what next.",
  input: Schema.Struct({ goal: Schema.String }),
  hints: { goal: "goal" },
  output: Schema.String,
  agents: { harness: "claude", model: "opus", effort: "high" },
  path: [architecture, menu],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const report = yield* architecture(
        agentWork({
          operation: "architecture",
          role: "architect",
          skill: "improve-codebase-architecture",
          instructions: attended,
          input: {
            inputs: { goal: asked.goal },
            run: { dir: place.dir },
            rooting:
              place.options.workspace === "projects-root"
                ? (content.sections.get("projects-root") ?? "")
                : "",
          },
          output: Report,
        }),
      );
      const next = yield* menu(
        ask({
          name: "next",
          prompt: "What next?",
          options: [{ id: IMPLEMENT, recommended: true }, STOP],
        }),
      );
      if (next === STOP) return `${report.report}: stopped there`;

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
