import * as Arr from "effect/Array";
import { Host, Run, agentWork, contentOf, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";
import markdown from "./heal.md" with { type: "text" };

const said = {
  diagnosis: Schema.String,
  actions: Schema.Array(Schema.String),
  finding: Schema.Struct({
    collie_defect: Schema.Boolean,
    key: Schema.String,
    root_cause: Schema.String,
    fix: Schema.String,
    regression: Schema.String,
    title: Schema.String,
    observed: Schema.String,
    expected: Schema.String,
    issue: Schema.NullOr(Schema.Int).annotate({
      description: "the cego/collie issue about the same cause, whatever its key, or null",
    }),
  }),
};
const Healed = Schema.Union([
  Schema.Struct({
    ...said,
    result: Schema.Literal("resumed"),
    needs_person: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ ...said, result: Schema.Literal("escalate"), needs_person: Schema.String }),
]);
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
  output: Healed,
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
