import { Host, Run, agentWork, contentOf, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";
import markdown from "./investigate.md" with { type: "text" };

const Findings = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(Schema.Struct({ what: Schema.String, evidence: Schema.String })),
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
  input: Schema.Struct({ goal: Schema.String }),
  output: Findings,
  agents: { effort: "high" },
  path: [investigate],
  hints: { goal: "goal" },
  checkout: "branch",
  closes: "reported",
  run: ({ input }) =>
    Effect.gen(function* () {
      const run = yield* Run;
      const place = yield* (yield* Host).place(run.id);
      return yield* agentWork({
        operation: "investigate",
        role: "investigator",
        instructions: content.template("investigate", {
          goal: Schema.String,
          run: Schema.Struct({ dir: Schema.String }),
        }),
        input: { goal: input.goal, run: { dir: place.dir } },
        output: Findings,
      });
    }).pipe(investigate),
});
