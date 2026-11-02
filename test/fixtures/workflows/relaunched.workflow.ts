// One agent of each harness, one after another, so a Run has agents whose work is done
// and one whose work is still out when they are lost.

import { agentWork, defineWorkflow } from "collie";
import * as Str from "effect/String";
import { Effect, Schema } from "effect";

const Verdict = Schema.Struct({ verdict: Schema.String });

export default defineWorkflow({
  id: "relaunched",
  title: "Four agents, one of each harness",
  description: "Each named harness's agent works in turn, on an operation named for it.",
  input: Schema.Struct({
    /** The harnesses, comma-separated, in the order their agents work. */
    harnesses: Schema.String,
  }),
  hints: { harnesses: "goal" },
  output: Schema.Array(Schema.String),
  run: ({ input }) =>
    Effect.forEach(Str.split(input.harnesses, ","), (harness) =>
      agentWork({
        operation: harness,
        role: "reviewer",
        harness,
        instructions: `Work as ${harness}.`,
        output: Verdict,
      }).pipe(Effect.map(({ verdict }) => verdict)),
    ),
});
