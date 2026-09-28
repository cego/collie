import { agentWork, defineWorkflow, withAgents } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "prefers-roles",
  output: Schema.String,
  agents: { model: "haiku", roles: { reviewer: { model: "sonnet", effort: "high" } } },
  run: () =>
    Effect.all(
      [
        agentWork({ operation: "plain", instructions: "As the workflow prefers." }),
        agentWork({ operation: "review", role: "reviewer", instructions: "As the role prefers." }),
        agentWork({
          operation: "own",
          role: "reviewer",
          model: "opus",
          instructions: "As the work itself prefers.",
        }),
        agentWork({
          operation: "scoped",
          role: "reviewer",
          instructions: "As the scope prefers.",
        }).pipe(withAgents({ model: "fable" })),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map((said) => said.join("+"))),
});
