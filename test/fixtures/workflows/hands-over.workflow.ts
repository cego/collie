// A delivery that hands its merge request over two ways: merged alone, or released.
//
// Both offers start the same workflow and differ only by what each binds, as implement's
// Merge and Release do; what that workflow's orchestration sets is never theirs to ask.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const handOver = (ship: "merge" | "release", title: string, confirm: string) => ({
  id: ship,
  title,
  workflow: "ship-target",
  when: "succeeded" as const,
  inputs: { mr: "started-with" as const },
  given: { ship },
  ships: ship,
  confirm,
});

export default defineWorkflow({
  id: "hands-over",
  title: "Hand a merge request over",
  description: "Offers to merge or release the merge request it was given.",
  input: Schema.Struct({ mr: Schema.String }),
  hints: { mr: "goal" },
  output: Schema.String,
  outcome: { fixed: "review" },
  followUps: [
    handOver("release", "Release", "Merges it, tags it and deploys the tag."),
    handOver("merge", "Merge", "Merges it and stops: nothing is tagged or deployed."),
  ],
  run: ({ input }) => Effect.succeed(`handed ${input.mr}`),
});
