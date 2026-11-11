// A Run that follows the merge request it was pointed at, once that setting is on, and asks
// whether to approve it.

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
  run: () =>
    ask({
      name: "approve-1",
      prompt: "Approve it?",
      options: [{ id: "Approve", recommended: true }, "Not now"],
    }),
});
