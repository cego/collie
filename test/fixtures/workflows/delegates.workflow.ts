import { child, defineWorkflow, withAgents } from "collie";
import { Effect } from "effect";

export default defineWorkflow({
  id: "delegates",
  run: () =>
    child({ invocation: "quietly", workflow: "quiet", input: {} }).pipe(
      Effect.asVoid,
      withAgents({
        model: "sonnet",
        claudeSubagents: { forceModel: true, cacheTtl: "1h", maxDepth: 1 },
      }),
    ),
});
