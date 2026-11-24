import { Host, Run, defineWorkflow, leaveFindings } from "collie";
import type { FollowUp } from "collie";
import { Effect, Schema } from "effect";

const chooseSelected: FollowUp = {
  id: "choose-selected",
  title: "Choose selected",
  workflow: "given",
  when: "succeeded",
  selects: "many",
  inputs: { selected: "findings" },
  eligible: (facts) => facts.openFindings > 0,
};

export default defineWorkflow({
  id: "chooses",
  title: "Leave two findings and offer them under another name",
  description: "Settles with two findings, and offers to build the ones chosen as `selected`.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  followUps: [chooseSelected],
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const { dir } = yield* (yield* Host).place(run.id);
      yield* leaveFindings(dir, [
        { severity: "major", title: "The cached build is stale" },
        { severity: "major", title: "The retry drops the body" },
      ]);
      return "left two findings";
    }),
});
