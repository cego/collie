import { ask, defineWorkflow } from "collie";
import { Schema } from "effect";

export default defineWorkflow({
  id: "follows-mr",
  title: "Follow a merge request",
  description: "Follows its merge request, and asks whether to approve it.",
  input: Schema.Struct({ target: Schema.String, proves: Schema.optionalKey(Schema.String) }),
  output: Schema.String,
  hints: { target: "diff-target" },
  follows: "review.follow_through",
  outcome: { fixed: "review" },
  run: ({ input }) =>
    input.proves === "dispute"
      ? ask({
          name: "dispute-1",
          prompt: "Keep F1 (no approval) / Drop it (approve abc123)?",
          options: [{ id: "Keep F1 (no approval)", recommended: true }, "Drop it (approve abc123)"],
        })
      : ask({
          name: "approve-1",
          prompt: "Approve it?",
          options: [{ id: "Approve", recommended: true }, "Not now"],
        }),
});
