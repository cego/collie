import { agentWork, defineWorkflow, withAgents } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "prefers",
  output: Schema.String,
  agents: { model: "haiku" },
  run: () =>
    Effect.all(
      [
        agentWork({ operation: "plain", instructions: "As the workflow prefers." }),
        agentWork({ operation: "scoped", instructions: "As the scope prefers." }).pipe(
          withAgents({ model: "sonnet" }),
        ),
        agentWork({ operation: "other", instructions: "As another scope prefers." }).pipe(
          withAgents({ model: "opus" }),
        ),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map((said) => said.join("+"))),
});
