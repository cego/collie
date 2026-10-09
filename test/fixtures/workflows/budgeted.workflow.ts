// A workflow that decides from this Machine's usage (ADR-0049 D10): the strongest model
// while budget allows, and a lighter plan once a window is nearly spent. The reading is
// taken inside an Activity of its own, so a replay takes the same branch.

import { Host, agentWork, defineWorkflow, usedFor } from "collie";
import { Clock, Effect, Schema } from "effect";
import * as Activity from "effect/workflow/Activity";

export default defineWorkflow({
  id: "budgeted",
  output: Schema.String,
  agents: { model: "opus", effort: "xhigh", upTo: 90, otherwise: [{ model: "sonnet" }] },
  run: () =>
    Effect.gen(function* () {
      const host = yield* Host;
      const nearlySpent = yield* Activity.make({
        name: "budget",
        success: Schema.Boolean,
        execute: Effect.gen(function* () {
          const used = usedFor(
            yield* host.usage(),
            { harness: "claude", model: "opus" },
            yield* Clock.currentTimeMillis,
          );
          return used !== null && used.usedPercent >= 80;
        }),
      });
      return yield* agentWork({
        operation: "plan",
        instructions: nearlySpent ? "Plan the next step only." : "Plan the whole change.",
        ...(nearlySpent ? { effort: "medium" } : {}),
      });
    }),
});
