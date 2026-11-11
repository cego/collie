import { agentWork, contentOf, defineWorkflow, step } from "collie";
import { Schema } from "effect";
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
    agentWork({
      operation: "heal",
      role: "healer",
      instructions: content.template("heal", { run: Schema.String, park: Schema.String }),
      input: { run: input.run, park: input.park },
      output: Healed,
    }).pipe(heal),
});
