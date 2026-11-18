import * as Arr from "effect/Array";
import { Host, Run, agentWork, contentOf, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./heal.md" with { type: "text" };

const finding = {
  collie_defect: Schema.Boolean,
  key: Schema.String,
  root_cause: Schema.String,
  fix: Schema.String,
  regression: Schema.String,
};
const report = {
  title: Schema.String,
  observed: Schema.String,
  expected: Schema.String,
  issue: Schema.NullOr(Schema.Int).annotate({
    description: "the cego/collie issue about the same cause, whatever its key, or null",
  }),
};
const outputWith = <Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const said = {
    summary: Schema.optionalKey(Schema.String),
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
    diagnosis: Schema.String,
    diagnosis_complete: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "false where the evidence did not establish why the Run parked, naming in diagnosis what you could not read or reproduce; true where it did",
      }),
    ),
    actions: Schema.Array(Schema.String),
    finding: Schema.Struct(fields),
  };
  return Schema.Union([
    Schema.Struct({
      ...said,
      result: Schema.Literal("resumed"),
      needs_person: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({ ...said, result: Schema.Literal("escalate"), needs_person: Schema.String }),
  ]);
};

export const Healed = outputWith({ ...finding, ...report });
const RecordedHeal = outputWith({
  ...finding,
  title: Schema.optionalKey(report.title),
  observed: Schema.optionalKey(report.observed),
  expected: Schema.optionalKey(report.expected),
  issue: Schema.optionalKey(report.issue),
});
const content = contentOf(markdown);
const heal = step({
  id: "heal",
  title: "Heal",
  description:
    "The healer gets the parked Run moving through its own agents, or says why it cannot.",
  kind: "agent",
  role: "healer",
  produces: "evidence",
});

export default defineWorkflow({
  id: "heal",
  title: "heal — get a parked Run moving",
  description:
    "Started by the host for a park its own recovery could not clear, before it needs you.",
  input: Schema.Struct({ run: Schema.String, park: Schema.String }),
  output: RecordedHeal,
  agents: { effort: "high" },
  path: [heal],
  hints: { run: "goal" },
  heals: true,
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const run = yield* Run;
      const issues = yield* Activity.make({
        name: "collie-issues",
        success: Schema.String,
        execute: host.issues(run.id, undefined, "collie").pipe(
          Effect.map((open) =>
            open.length === 0
              ? "None."
              : Arr.join(
                  Arr.map(open, ({ number, title }) => `- #${number} ${title}`),
                  "\n",
                ),
          ),
          Effect.catch((refused) => Effect.succeed(`Unavailable: ${refused.reason}.`)),
        ),
      });
      return yield* agentWork({
        operation: "heal",
        role: "healer",
        instructions: content.template("heal", {
          run: Schema.String,
          park: Schema.String,
          issues: Schema.String,
        }),
        input: { run: input.run, park: input.park, issues },
        output: Healed,
      }).pipe(heal);
    }),
});
