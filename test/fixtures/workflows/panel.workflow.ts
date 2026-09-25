import { agentWork, defineWorkflow, panelOf } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "panel",
  output: Schema.String,
  agents: {
    model: "haiku",
    roles: {
      critic: [
        { model: "sonnet", effort: "high" },
        {
          name: "strict",
          model: "opus",
          persona: "strict-critic",
          instructions: "Be strict about {{thing}}.",
        },
      ],
    },
  },
  run: () =>
    Effect.gen(function* () {
      const seats = yield* panelOf("critic");
      const said = yield* Effect.forEach(
        seats,
        (seat, at) =>
          agentWork({
            operation: `critique-${seat.name ?? at + 1}`,
            role: "critic",
            seat,
            instructions: "Critique {{thing}}.",
            input: { thing: "the plan" },
          }),
        { concurrency: "unbounded" },
      );
      const summary = yield* agentWork({
        operation: "summary",
        role: "critic",
        instructions: "Sum up.",
      });
      return [...said, summary].join("+");
    }),
});
